import { DurableObject } from 'cloudflare:workers';

const ROOM = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[\w-]{43}$/;
const MAX_FRAME = 256 * 1024;
const LIFETIME = 6 * 60 * 60 * 1000;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const allowedOrigin = origin => !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (!allowedOrigin(origin)) return json({ error: 'Origin not allowed.' }, 403);
    let response;
    if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
    else if (url.pathname === '/health') response = json({ ok: true, protocol: 1 });
    else if (url.pathname === '/join' || url.pathname === '/') {
      response = new Response('<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>YouTube Music Together</title><h1>YouTube Music Together</h1><p>Open our Chrome extension on YouTube Music and paste the full invitation into Join session. Its private key stays in the URL fragment and is never sent to this page.</p>', { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      } });
    } else if (request.method === 'POST' && url.pathname === '/rooms') {
      if (Number(request.headers.get('Content-Length') || 0) > 512) return json({ error: 'Request too large.' }, 413);
      const body = await request.text();
      if (body.length > 512) return json({ error: 'Request too large.' }, 413);
      let data; try { data = JSON.parse(body); } catch { return json({ error: 'Invalid room request.' }, 400); }
      if (!HASH.test(data.hostHash) || !HASH.test(data.joinHash)) return json({ error: 'Invalid room credentials.' }, 400);
      const room = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      response = await stub.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify(data) }));
      if (response.ok) response = json({ room, expiresAt: Date.now() + LIFETIME }, 201);
    } else {
      const match = url.pathname.match(/^\/rooms\/([a-f0-9]{32})\/socket$/);
      if (!match || request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Not found.' }, 404);
      response = await env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    if (response.status === 101) return response;
    response = new Response(response.body, response);
    if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  },
};

export class MusicRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    /** @type {any} */
    this.auth = null;
    ctx.blockConcurrencyWhile(async () => { this.auth = await ctx.storage.get('auth') || null; });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/init') {
      if (this.auth) return json({ error: 'Room already exists.' }, 409);
      const data = await request.json();
      this.auth = { hostHash: data.hostHash, joinHash: data.joinHash, expiresAt: Date.now() + LIFETIME, approved: false };
      await this.ctx.storage.put('auth', this.auth);
      await this.ctx.storage.setAlarm(this.auth.expiresAt);
      return json({ ok: true });
    }
    if (!this.auth?.hostHash || this.auth.expiresAt <= Date.now()) return json({ error: 'Session expired or ended. Create a new one.' }, 410);
    if (this.ctx.getWebSockets().length >= 4) return json({ error: 'Session connection limit reached.' }, 429);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ role: null, connectedAt: Date.now(), windowAt: Date.now(), count: 0 });
    setTimeout(() => { if (!pair[1].deserializeAttachment()?.role) pair[1].close(1008, 'Authentication required'); }, 8000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  sockets(role = null) {
    return this.ctx.getWebSockets().filter(socket => socket.readyState === WebSocket.OPEN && socket.deserializeAttachment()?.role && (!role || socket.deserializeAttachment().role === role));
  }
  notify() {
    const value = JSON.stringify({ type: 'presence', host: this.sockets('host').length > 0, guest: this.sockets('guest').length > 0, approved: !!this.auth?.approved });
    for (const socket of this.sockets()) { try { socket.send(value); } catch {} }
  }
  async webSocketMessage(socket, input) {
    try {
      if (typeof input !== 'string' || input.length > MAX_FRAME) { socket.close(1009, 'Message too large'); return; }
      if (!this.auth?.hostHash || this.auth.expiresAt <= Date.now()) { socket.close(1008, 'Session expired'); return; }
      const attachment = socket.deserializeAttachment();
      const now = Date.now();
      if (now - attachment.windowAt > 1000) { attachment.windowAt = now; attachment.count = 0; }
      if (++attachment.count > 30) { socket.close(1008, 'Message rate exceeded'); return; }
      socket.serializeAttachment(attachment);
      const message = JSON.parse(input);
      if (!attachment.role) {
        if (message.type !== 'auth' || !['host', 'guest'].includes(message.role) || !TOKEN.test(message.token) || !ROOM.test(message.clientId)) {
          socket.close(1008, 'Invalid authentication'); return;
        }
        const digest = await hash(message.token);
        let resumeToken;
        // Serialize membership changes across async hashes/storage writes.
        const accepted = await this.ctx.blockConcurrencyWhile(async () => {
          if (message.role === 'host') {
            if (digest !== this.auth.hostHash || (this.auth.hostId && message.clientId !== this.auth.hostId)) return false;
            this.auth.hostId = message.clientId;
            await this.ctx.storage.put('auth', this.auth);
          }
          else if (this.auth.guestHash) {
            if (digest !== this.auth.guestHash || message.clientId !== this.auth.guestId) return false;
          } else {
            if (digest !== this.auth.joinHash) return false;
            resumeToken = token();
            this.auth.guestHash = await hash(resumeToken);
            this.auth.guestId = message.clientId;
            this.auth.joinHash = null;
            await this.ctx.storage.put('auth', this.auth);
          }
          // A verified returning participant may replace its own stale TCP connection after sleep.
          for (const prior of this.sockets(message.role)) {
            if (prior.deserializeAttachment().clientId !== message.clientId) return false;
            prior.close(4001, 'Participant reconnected');
          }
          attachment.role = message.role;
          attachment.clientId = message.clientId;
          socket.serializeAttachment(attachment);
          return true;
        });
        if (!accepted) { socket.close(1008, 'Invite used, invalid credentials, or participant already connected'); return; }
        socket.send(JSON.stringify({ type: 'authenticated', role: attachment.role, resumeToken, expiresAt: this.auth.expiresAt }));
        this.notify();
        return;
      }
      if (message.type === 'end') {
        for (const peer of this.sockets()) { peer.send(JSON.stringify({ type: 'ended' })); peer.close(1000, 'Session ended'); }
        const expiresAt = this.auth.expiresAt;
        this.auth = { expiresAt, ended: true };
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.put('auth', this.auth);
        await this.ctx.storage.setAlarm(expiresAt);
        return;
      }
      if (message.type === 'approve' && attachment.role === 'host' && this.sockets('guest').length) {
        this.auth.approved = true;
        await this.ctx.storage.put('auth', this.auth);
        this.notify();
        return;
      }
      if (message.type === 'sealed') {
        if (message.role !== attachment.role || !ROOM.test(message.epoch) || !Number.isSafeInteger(message.seq) || message.seq < 1 ||
          typeof message.iv !== 'string' || !/^[\w-]{16}$/.test(message.iv) || typeof message.data !== 'string' || !/^[\w-]+$/.test(message.data)) {
          socket.close(1008, 'Invalid encrypted frame'); return;
        }
        // Presence can change between a browser's send and server receipt. Keep the
        // authenticated participant connected and pause via presence, rather than
        // treating a valid in-flight frame as a protocol violation.
        if (!this.auth.approved || this.sockets().length !== 2) { this.notify(); return; }
        const clean = JSON.stringify({ type: 'sealed', role: attachment.role, epoch: message.epoch, seq: message.seq, iv: message.iv, data: message.data });
        for (const peer of this.sockets()) if (peer !== socket) peer.send(clean);
        return;
      }
      socket.close(1008, 'Unsupported session message');
    } catch { try { socket.close(1008, 'Invalid session message'); } catch {} }
  }
  webSocketClose(socket) {
    try { socket.close(1000, 'Connection closed'); } catch {}
    this.notify();
  }
  webSocketError(socket) { this.webSocketClose(socket); }
  async alarm() {
    for (const socket of this.ctx.getWebSockets()) { try { socket.close(1000, 'Session expired'); } catch {} }
    await this.ctx.storage.deleteAll();
    this.auth = null;
  }
}
