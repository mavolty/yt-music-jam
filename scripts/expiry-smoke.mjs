// Real Worker/WebSocket expiration integration. Only the fixture's clock scale differs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomToken, randomId, digest } from '../extension/crypto.js';

export async function expirySmoke() {
  const directory = `.cache/expiry-${Date.now()}`;
  await mkdir(directory, { recursive: true });
  const source = await readFile('relay/worker.js', 'utf8');
  const declaration = 'const LIFETIME = 6 * 60 * 60 * 1000;';
  assert(source.includes(declaration));
  await writeFile(`${directory}/worker.js`, source.replace(declaration, 'const LIFETIME = 1800;'));
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  delete config.$schema;
  config.main = 'worker.js';
  await writeFile(`${directory}/wrangler.json`, JSON.stringify(config));
  const freePort = async () => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
  };
  const port = await freePort(), inspector = await freePort();
  const relay = `http://127.0.0.1:${port}`;
  const worker = spawn(process.execPath, ['scripts/wrangler.mjs', 'dev', '--config', `${directory}/wrangler.json`, '--local', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', `${directory}/state`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', socket;
  worker.stdout.on('data', chunk => { log += chunk; });
  worker.stderr.on('data', chunk => { log += chunk; });
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await fetch(`${relay}/health`).then(response => response.ok).catch(() => false);
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert(ready, 'expiry Worker startup');
    const token = randomToken();
    const response = await fetch(`${relay}/rooms`, { method: 'POST', body: JSON.stringify({ hostHash: await digest(token), joinHash: await digest(randomToken()) }) });
    const { room } = await response.json();
    socket = new WebSocket(`${relay.replace('http', 'ws')}/rooms/${room}/socket`);
    const closed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Room expiration did not close the socket')), 10000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', role: 'host', token, clientId: randomId() })));
      socket.addEventListener('close', event => { clearTimeout(timeout); resolve(event); });
      socket.addEventListener('error', reject);
    });
    const event = await closed;
    assert.equal(event.code, 1000);
    assert.match(event.reason, /expired/i);
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${relay}/rooms/${room}/socket`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 410);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    worker.kill('SIGTERM');
    await writeFile('artifacts/expiry-smoke.log', log);
  }
}
