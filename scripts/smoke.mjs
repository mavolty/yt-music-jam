// Integration smoke checks only: real Worker, WebSockets, Chrome extension and two browser contexts.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';
import { randomToken, randomId, digest, Cipher } from '../extension/crypto.js';

const reports = [];
const report = message => { reports.push(message); console.log(`PASS ${message}`); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work, name, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { if (await work()) return; } catch (error) { last = error.message; }
    await delay(150);
  }
  throw new Error(`Timed out: ${name}${last ? ` (${last})` : ''}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
await mkdir('artifacts', { recursive: true });
await mkdir('.cache/browser-temp', { recursive: true });
const port = await freePort(); const inspector = await freePort();
const relay = `http://127.0.0.1:${port}`;
const run = `${Date.now()}`;
let relayOutput = '';
const worker = spawn(process.execPath, ['scripts/wrangler.mjs', 'dev', '--local', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', `.cache/smoke-state-${run}`], { stdio: ['ignore', 'pipe', 'pipe'] });
worker.stdout.on('data', chunk => { relayOutput += chunk; });
worker.stderr.on('data', chunk => { relayOutput += chunk; });
const contexts = [];
const sockets = [];
let success = false;
try {
  await until(async () => (await fetch(`${relay}/health`)).ok, 'local relay startup', 30000);
  report('Worker health endpoint');
  const hostToken = randomToken(), joinToken = randomToken();
  const created = await fetch(`${relay}/rooms`, { method: 'POST', body: JSON.stringify({ hostHash: await digest(hostToken), joinHash: await digest(joinToken) }) });
  assert.equal(created.status, 201);
  const { room } = await created.json();
  function connect(role, token, clientId = randomId()) {
    const socket = new WebSocket(`${relay.replace('http', 'ws')}/rooms/${room}/socket`);
    const messages = []; let closeCode;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', role, token, clientId })));
    socket.addEventListener('message', event => { if (event.data !== 'pong') messages.push(JSON.parse(event.data)); });
    socket.addEventListener('close', event => { closeCode = event.code; });
    socket.addEventListener('error', () => {});
    sockets.push(socket);
    return { socket, messages, closeCode: () => closeCode, clientId };
  }
  const host = connect('host', hostToken);
  const guest = connect('guest', joinToken);
  await until(() => host.messages.some(m => m.type === 'authenticated') && guest.messages.some(m => m.type === 'authenticated'), 'two authenticated participants');
  assert(guest.messages.find(m => m.type === 'authenticated').resumeToken);
  host.socket.send(JSON.stringify({ type: 'approve' }));
  await until(() => guest.messages.some(m => m.type === 'presence' && m.approved), 'pair confirmation');
  report('Fresh invite, one-time guest credential and pair confirmation');
  const third = connect('guest', joinToken);
  await until(() => third.closeCode() === 1008, 'reject consumed invitation');
  const impostor = connect('host', randomToken());
  await until(() => impostor.closeCode() === 1008, 'reject invalid credentials');
  report('Consumed invite, third participant and invalid credentials rejected');
  const key = randomToken();
  const sender = new Cipher({ role: 'host', room, key });
  const recipient = new Cipher({ role: 'guest', room, key });
  const privateMessage = { kind: 'integration', title: 'Private track metadata must stay encrypted' };
  const sealed = await sender.seal(privateMessage);
  assert(!JSON.stringify(sealed).includes(privateMessage.title));
  host.socket.send(JSON.stringify(sealed));
  await until(() => guest.messages.some(m => m.type === 'sealed'), 'encrypted forwarding');
  const received = guest.messages.find(m => m.type === 'sealed');
  assert.deepEqual(await recipient.open(received), privateMessage);
  await assert.rejects(() => recipient.open(received));
  report('Real WebSocket encrypted delivery and replay rejection');
  const forbidden = await fetch(`${relay}/rooms`, { method: 'POST', headers: { Origin: 'https://unrelated.example' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  host.socket.send(JSON.stringify({ type: 'end' }));
  await until(() => guest.messages.some(m => m.type === 'ended'), 'room termination');
  const endedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${relay}/rooms/${room}/socket`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(endedStatus, 410);
  report('Unexpected origins rejected; ending clears credentials and disables invite');

  execFileSync(process.execPath, ['scripts/build.mjs', '--relay-url', relay, '--output', 'artifacts/smoke-extension'], { stdio: 'pipe' });
  const extension = resolve('artifacts/smoke-extension');
  const executablePath = await browserPath();
  const fixture = await readFile('scripts/native-fixture.html', 'utf8');
  async function browser(name) {
    const context = await chromium.launchPersistentContext(resolve(`.cache/smoke-${run}-${name}`), {
      executablePath, channel: 'chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      env: { ...process.env, TMPDIR: resolve('.cache/browser-temp'), XDG_CACHE_HOME: resolve('.cache/browser-cache'), XDG_CONFIG_HOME: resolve('.cache/browser-config') },
    });
    contexts.push(context);
    let service = context.serviceWorkers()[0];
    if (!service) service = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = service.url().split('/')[2];
    await context.route('https://music.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    const page = await context.newPage();
    await page.goto('https://music.youtube.com/');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const request = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
    await until(async () => (await request({ type: 'diagnostics' })).value?.ready, `${name} native adapter readiness`);
    return { context, page, popup, request, service, id };
  }
  const first = await browser('host'); const second = await browser('guest');
  report('Real MV3 extension loaded in two isolated Chromium contexts');
  await first.popup.locator('#relay').fill(relay);
  await first.popup.locator('#create-panel button').click();
  await until(async () => (await first.request({ type: 'status' })).value?.invite, 'host session invitation');
  const invite = (await first.request({ type: 'status' })).value.invite;
  await second.popup.locator('#join-tab').click();
  await second.popup.locator('#invite').fill(invite);
  await second.popup.locator('#join-panel button').click();
  await until(async () => (await first.request({ type: 'status' })).value?.approvalNeeded, 'partner approval');
  await first.popup.locator('#approve').click();
  const native = browser => browser.page.evaluate(() => window.fixture.snapshot());
  async function together(name) {
    await until(async () => {
      const [a, b] = await Promise.all([native(first), native(second)]);
      return a.videoId === b.videoId && JSON.stringify(a.queue) === JSON.stringify(b.queue) && a.paused === b.paused && Math.abs(a.position - b.position) < 1;
    }, name);
  }
  await together('initial synchronization');
  report('Create/join/confirm flow synchronizes the creator’s native queue');
  await first.popup.screenshot({ path: 'artifacts/session-popup.png' });
  await second.page.locator('#play').click();
  await until(async () => (await native(first)).paused && (await native(second)).paused, 'guest pause');
  await first.page.locator('#play').click();
  await until(async () => !(await native(first)).paused && !(await native(second)).paused, 'host resume');
  await second.page.locator('#seek').click();
  await together('guest seek');
  await first.page.locator('#next').click();
  await together('host song selection');
  report('Bidirectional native play/pause, seek and song selection');
  await Promise.all([first.page.locator('#add-c').click(), second.page.locator('#add-d').click()]);
  await until(async () => {
    const [a, b] = await Promise.all([native(first), native(second)]);
    return a.queue.includes('CCCCCCCCCCC') && a.queue.includes('DDDDDDDDDDD') && JSON.stringify(a.queue) === JSON.stringify(b.queue);
  }, 'simultaneous queue additions');
  await second.page.locator('#reorder').click(); await together('guest queue reorder');
  await first.page.locator('#remove').click(); await together('host queue removal');
  await second.page.locator('#replace').click();
  await until(async () => (await native(first)).videoId === 'EEEEEEEEEEE', 'guest playlist replacement');
  await together('playlist replacement');
  report('Native queue add/remove/reorder, simultaneous additions and playlist replacement');
  await second.page.locator('#like').click();
  await delay(700);
  assert.equal((await native(first)).likes, 0); assert.equal((await native(second)).likes, 1);
  report('Personal library actions stay local');
  await second.page.evaluate(() => window.fixture.buffer(true));
  await until(async () => (await native(first)).paused && (await native(second)).paused, 'buffering pauses both');
  await second.page.evaluate(() => window.fixture.buffer(false));
  await until(async () => !(await native(first)).paused && !(await native(second)).paused, 'ready participants resume together');
  report('Buffering pauses both and readiness resynchronizes playback');
  await second.context.setOffline(true);
  await until(async () => (await native(first)).paused, 'disconnect pauses host', 12000);
  await second.context.setOffline(false);
  await until(async () => {
    const a = (await first.request({ type: 'status' })).value;
    const b = (await second.request({ type: 'status' })).value;
    return a?.peerOnline && b?.peerOnline && a.phase === 'playing' && b.phase === 'playing';
  }, 'both participants reconnected and playing', 20000);
  await together('reconnection');
  report('Network interruption pauses and reconciles the session');
  for (const participant of [second, first]) {
    await participant.page.reload();
    await until(async () => {
      const a = (await first.request({ type: 'status' })).value;
      const b = (await second.request({ type: 'status' })).value;
      return a.phase === 'playing' && b.phase === 'playing';
    }, 'native tab refresh recovers shared playback', 20000);
    await together('native queue recovery after refresh');
  }
  report('Refreshing either native tab restores the shared queue and playback');
  await first.popup.locator('#end').click();
  await until(async () => !(await first.request({ type: 'status' })).value.active && !(await second.request({ type: 'status' })).value.active, 'end both extension sessions');
  const storage = await first.service.evaluate(() => chrome.storage.session.get(null));
  assert(!storage.session);
  report('End session clears Chrome session state for both participants');
  success = true;
} finally {
  if (!success && contexts.length) {
    const diagnostics = [];
    for (const context of contexts) {
      const page = context.pages().find(page => page.url().startsWith('https://music.youtube.com/'));
      const popup = context.pages().find(page => page.url().startsWith('chrome-extension://'));
      const local = page ? await page.evaluate(() => window.fixture?.snapshot()).catch(() => null) : null;
      const status = popup ? await popup.evaluate(async () => { const result = await chrome.runtime.sendMessage({ type: 'status' }); const v = result.value; return { phase: v?.phase, error: v?.error, label: v?.label }; }).catch(() => null) : null;
      const state = await context.serviceWorkers()[0]?.evaluate(async () => { const value = await chrome.storage.session.get('session'); const config = value.session; return { state: config?.state, revision: config?.revision, desiredPlaying: config?.desiredPlaying }; }).catch(() => null);
      diagnostics.push({ local, status, coordinator: state });
    }
    await writeFile('artifacts/smoke-failure.json', JSON.stringify(diagnostics, null, 2));
    console.log('Failure diagnostics saved to artifacts/smoke-failure.json (synthetic metadata only).');
  }
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
  for (const context of contexts) await context.close();
  worker.kill('SIGTERM');
  await writeFile('artifacts/relay-smoke.log', relayOutput);
  await writeFile('artifacts/smoke-report.json', JSON.stringify({ success, checks: reports, liveSignedInVerification: false, unitTestsRun: false }, null, 2));
}
console.log('Integration smoke checks passed. This does not verify signed-in YouTube Music audio or native queue compatibility.');
