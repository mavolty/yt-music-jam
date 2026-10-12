// Jam session: owns the shared state, the relay socket and the server clock.
//
// Shared state merges without a leader, so both peers can act instantly:
//   play  – last-writer-wins register ordered by (v, by)
//   items – queue entries keyed by id, ordered by (order, id)
//   gone  – ids removed from the queue (played or deleted)
// Every change broadcasts the whole state and receivers merge it, so
// duplicated, reordered or replayed frames are harmless. The page only ever
// receives a target to converge to; it never echoes what it is told.

import { RELAY } from './config.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SONG_LEAD = 700;
const RECONNECT_MS = [250, 500, 1000, 2000, 4000];

let session = null; // { code, role, peer, name, key, roomId }
let state = emptyState();
let lamport = 0;
let ws = null;
let wsGeneration = 0;
let reconnectAttempt = 0;
let peers = [];
let status = 'idle'; // idle | connecting | live | reconnecting | ended
let endedReason = '';
let clock = { offset: 0, rtt: Infinity, samples: [] };
let pingTimer = null;
let port = null;

function emptyState() {
  return { play: null, items: {}, gone: {}, names: {} };
}

const serverNow = () => Date.now() + clock.offset;
const lead = () => Math.round(Math.min(400, Math.max(120, (Number.isFinite(clock.rtt) ? clock.rtt : 150) + 60)));

// ---------- crypto ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function deriveRoom(code) {
  const id = [...(await digest(`ytm-jam:room:${code}`))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', await digest(`ytm-jam:key:${code}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { roomId: id, key };
}

async function seal(message) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.key, enc.encode(JSON.stringify(message))));
  const out = new Uint8Array(12 + body.length);
  out.set(iv);
  out.set(body, 12);
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return JSON.stringify({ e: btoa(bin) });
}

async function open(text) {
  const bytes = Uint8Array.from(atob(JSON.parse(text).e), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, session.key, bytes.slice(12));
  return JSON.parse(dec.decode(plain));
}

// ---------- state ----------

const newer = (a, b) => !b || a.v > b.v || (a.v === b.v && a.by > b.by);

function merge(incoming) {
  const before = state.play;
  if (incoming.play && newer(incoming.play, state.play)) state.play = incoming.play;
  for (const [id, item] of Object.entries(incoming.items || {})) state.items[id] ||= item;
  Object.assign(state.gone, incoming.gone);
  Object.assign(state.names, incoming.names);
  for (const id of Object.keys(state.gone)) delete state.items[id];
  lamport = Math.max(lamport, state.play?.v || 0);
  return state.play !== before;
}

const queue = () => Object.values(state.items).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

function setPlay(changes) {
  lamport += 1;
  const base = state.play || { videoId: null, playing: false, pos: 0, at: serverNow() };
  state.play = { ...base, ...changes, v: lamport, by: session.peer };
  commit(true);
}

function commit(playChanged) {
  if (playChanged) pushTarget();
  pushQueue();
  persist();
  broadcast();
  notify();
}

function positionNow(play) {
  if (!play) return 0;
  return play.playing ? play.pos + Math.max(0, serverNow() - play.at) / 1000 : play.pos;
}

function playNow(song, extra = {}) {
  setPlay({
    videoId: song.videoId, title: song.title || '', artist: song.artist || '', art: song.art || '',
    playing: true, pos: 0, at: serverNow() + SONG_LEAD, ...extra
  });
}

function popHead() {
  const head = queue()[0];
  if (!head) return false;
  state.gone[head.id] = true;
  delete state.items[head.id];
  playNow(head, { from: head.byName });
  return true;
}

function handleIntent(intent) {
  if (!session || status === 'ended') return;
  const play = state.play;
  switch (intent.kind) {
    case 'play':
      if (play) setPlay({ playing: true, pos: intent.pos ?? positionNow(play), at: serverNow() + lead() });
      break;
    case 'pause':
      if (play) setPlay({ playing: false, pos: intent.pos ?? positionNow(play), at: serverNow() });
      break;
    case 'seek':
      if (play) setPlay({ pos: Math.max(0, intent.pos), at: serverNow() + (play.playing ? lead() : 0) });
      break;
    case 'song':
      // A song the user picked natively, or (host only) YTM autoplay.
      if (play?.videoId === intent.song.videoId) break;
      if (intent.auto && popHead()) break;
      if (intent.auto && session.role !== 'host') break;
      playNow(intent.song);
      break;
    case 'meta':
      if (play?.videoId === intent.song.videoId && !play.title && intent.song.title) setPlay(intent.song);
      break;
    case 'ended':
      if (session.role === 'host' && !popHead()) sendPage({ type: 'native', cmd: 'next' });
      break;
    case 'next':
      if (popHead()) break;
      if (session.role === 'host') sendPage({ type: 'native', cmd: 'next' });
      else send({ t: 'native', cmd: 'next' });
      break;
    case 'prev':
      if (play && positionNow(play) > 3) setPlay({ pos: 0, at: serverNow() + (play.playing ? lead() : 0) });
      else if (session.role === 'host') sendPage({ type: 'native', cmd: 'prev' });
      else send({ t: 'native', cmd: 'prev' });
      break;
    case 'enqueue': {
      const live = queue();
      const order = intent.next ? (live[0]?.order ?? 1) - 1 : (live.at(-1)?.order ?? 0) + 1;
      const id = crypto.randomUUID();
      state.items[id] = { id, ...intent.song, order, by: session.peer, byName: session.name };
      commit(false);
      break;
    }
    case 'remove':
      state.gone[intent.id] = true;
      delete state.items[intent.id];
      commit(false);
      break;
    case 'jump': {
      const item = state.items[intent.id];
      if (!item) break;
      state.gone[item.id] = true;
      delete state.items[item.id];
      playNow(item, { from: item.byName });
      break;
    }
    case 'seed':
      // First page report after starting a Jam: adopt whatever is playing.
      if (session.role === 'host' && !state.play && intent.song) setPlay({ ...intent.song, playing: intent.playing, pos: intent.pos, at: serverNow() });
      break;
  }
}

// ---------- relay ----------

async function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(await seal(message));
}

function broadcast() {
  send({ t: 'state', state });
}

function connect() {
  const generation = ++wsGeneration;
  ws?.close();
  const relay = session.relay || RELAY;
  const socket = new WebSocket(`${relay.replace(/^http/, 'ws')}/rooms/${session.roomId}?role=${session.role}&peer=${session.peer}`);
  ws = socket;
  status = reconnectAttempt ? 'reconnecting' : 'connecting';
  notify();

  socket.onopen = () => {
    if (generation !== wsGeneration) return;
    reconnectAttempt = 0;
    status = 'live';
    clock.samples = [];
    burstPing();
    send({ t: 'hello' });
    broadcast();
    notify();
  };

  socket.onmessage = async event => {
    if (generation !== wsGeneration) return;
    const text = event.data;
    if (text.startsWith('{"e"')) {
      let message;
      try { message = await open(text); } catch { return; }
      if (generation === wsGeneration) receive(message);
      return;
    }
    const message = JSON.parse(text);
    if (message.t === 'pong') return onPong(message);
    if (message.t === 'peers') {
      peers = message.peers;
      notify();
      pushQueue();
    }
    if (message.t === 'refused' || message.t === 'ended') end(message.reason || 'ended');
  };

  socket.onclose = () => {
    if (generation !== wsGeneration || status === 'ended' || !session) return;
    status = 'reconnecting';
    peers = [];
    notify();
    const delay = RECONNECT_MS[Math.min(reconnectAttempt++, RECONNECT_MS.length - 1)];
    setTimeout(() => generation === wsGeneration && session && connect(), delay);
  };
}

function receive(message) {
  if (message.t === 'hello') return broadcast();
  if (message.t === 'state') {
    const playChanged = merge(message.state);
    if (playChanged) pushTarget();
    pushQueue();
    persist();
    notify();
    return;
  }
  if (message.t === 'native' && session.role === 'host') {
    if (message.cmd === 'next' && popHead()) return;
    sendPage({ type: 'native', cmd: message.cmd });
  }
}

// ---------- clock ----------

function ping() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(`{"t":"ping","c":${Date.now()}}`);
}

function burstPing() {
  clearInterval(pingTimer);
  let n = 0;
  pingTimer = setInterval(() => {
    ping();
    if (++n === 10) {
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, 10000);
    }
  }, 120);
}

function onPong({ c, s }) {
  const now = Date.now();
  const rtt = now - c;
  clock.samples.push({ rtt, offset: s - (c + now) / 2 });
  clock.samples = clock.samples.slice(-12);
  const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  const changed = Math.abs(best.offset - clock.offset) > 2;
  clock.offset = best.offset;
  clock.rtt = best.rtt;
  if (changed) pushTarget();
}

// ---------- page ----------

function sendPage(message) {
  try { port?.postMessage(message); } catch { port = null; }
}

function pushTarget() {
  sendPage({ type: 'target', play: state.play, offset: clock.offset, role: session?.role || null });
}

function pushQueue() {
  const others = peers.filter(p => p.peer !== session?.peer).map(p => state.names[p.peer] || 'Partner');
  sendPage({
    type: 'jam',
    jam: session ? {
      code: session.code, role: session.role, status, partners: others,
      queue: queue(), nowPlaying: state.play, me: session.peer, myName: session.name
    } : null
  });
}

chrome.runtime.onConnect.addListener(newPort => {
  if (newPort.name !== 'ytm-jam') return;
  if (port) sendPage({ type: 'target', play: null, role: null });
  port = newPort;
  newPort.onMessage.addListener(message => {
    if (newPort !== port) return;
    if (message.type === 'intent') handleIntent(message.intent);
    if (message.type === 'hello') {
      pushTarget();
      pushQueue();
    }
  });
  newPort.onDisconnect.addListener(() => {
    if (newPort === port) port = null;
  });
});

// ---------- lifecycle ----------

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

async function begin(code, role, name) {
  await leave(false);
  const { roomId, key } = await deriveRoom(code);
  const stored = await chrome.storage.local.get(['peer', 'relay']); // relay: dev override
  const peer = stored.peer || crypto.randomUUID();
  await chrome.storage.local.set({ peer, name });
  session = { code, role, name, peer, roomId, key, relay: stored.relay };
  state = emptyState();
  state.names[peer] = name;
  lamport = 0;
  endedReason = '';
  reconnectAttempt = 0;
  connect();
  sendPage({ type: 'seed' });
  pushTarget();
  pushQueue();
  persist();
}

function end(reason) {
  endedReason = reason;
  status = 'ended';
  wsGeneration++;
  ws?.close();
  ws = null;
  clearInterval(pingTimer);
  sendPage({ type: 'target', play: null, role: null });
  pushQueue();
  notify();
  chrome.storage.session.remove('jam');
}

async function leave(announce = true) {
  if (!session) return;
  if (announce && session.role === 'host' && ws?.readyState === WebSocket.OPEN) ws.send('{"t":"end"}');
  if (announce) end('left');
  session = null;
  state = emptyState();
  status = 'idle';
  peers = [];
  pushQueue();
  notify();
  await chrome.storage.session.remove('jam');
}

function persist() {
  if (!session) return;
  const { key, ...rest } = session;
  chrome.storage.session.set({ jam: { session: rest, state, lamport } });
}

async function restore() {
  const { jam } = await chrome.storage.session.get('jam');
  if (!jam || session) return;
  const { key } = await deriveRoom(jam.session.code);
  session = { ...jam.session, key };
  state = jam.state;
  lamport = jam.lamport;
  connect();
}

function snapshot() {
  return {
    status, endedReason,
    code: session?.code || null, role: session?.role || null, name: session?.name || null,
    partners: peers.filter(p => p.peer !== session?.peer).map(p => state.names[p.peer] || 'Partner'),
    nowPlaying: state.play, queueLength: queue().length, rtt: Number.isFinite(clock.rtt) ? clock.rtt : null,
    hasTab: Boolean(port)
  };
}

function notify() {
  chrome.runtime.sendMessage({ type: 'status', status: snapshot() }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    if (message.type === 'start') await begin(makeCode(), 'host', message.name);
    if (message.type === 'join') await begin(message.code.toUpperCase().replace(/[^A-Z0-9]/g, ''), 'guest', message.name);
    if (message.type === 'leave') await leave();
    if (message.type === 'dismiss') { status = 'idle'; endedReason = ''; session = null; state = emptyState(); }
    reply(snapshot());
  })();
  return true;
});

restore();
