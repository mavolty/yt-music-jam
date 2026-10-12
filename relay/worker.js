// Relay for YT Music Jam. It never sees song data: peers exchange AES-GCM
// frames derived from the room code. The relay only knows who is host,
// forwards frames, answers clock pings and ends the room when the host leaves.

const ROOM_TTL = 12 * 60 * 60 * 1000;
const HOST_GRACE = 30 * 1000;
const MAX_PEERS = 8;
const MAX_FRAME = 64 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/rooms\/([a-f0-9]{32})$/);
    if (!match) return new Response('YT Music Jam relay', { status: url.pathname === '/' ? 200 : 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
    const peer = (url.searchParams.get('peer') || '').slice(0, 64);
    if (!peer) return new Response('Missing peer', { status: 400 });

    const meta = (await this.state.storage.get('meta')) || null;
    const now = Date.now();
    const refuse = reason => {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.send(JSON.stringify({ t: 'refused', reason }));
      server.close(4000, reason);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (meta?.ended) return refuse('ended');
    if (meta && now > meta.expires) return refuse('expired');
    if (role === 'host') {
      if (meta && meta.host !== peer) return refuse('taken');
      if (!meta) await this.state.storage.put('meta', { host: peer, expires: now + ROOM_TTL });
    } else if (!meta) {
      return refuse('missing');
    }

    const others = this.state.getWebSockets().filter(ws => this.tag(ws).peer !== peer);
    if (others.length >= MAX_PEERS) return refuse('full');
    // A peer that reconnects replaces its own stale socket.
    for (const ws of this.state.getWebSockets()) if (this.tag(ws).peer === peer) ws.close(4001, 'replaced');

    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ peer, role });
    if (role === 'host') await this.state.storage.delete('hostGoneAt');
    await this.state.storage.setAlarm(Math.min((meta?.expires || now + ROOM_TTL), now + ROOM_TTL));
    this.presence();
    return new Response(null, { status: 101, webSocket: client });
  }

  tag(ws) {
    return ws.deserializeAttachment() || {};
  }

  presence(leaving) {
    const sockets = this.state.getWebSockets().filter(ws => ws !== leaving);
    const frame = JSON.stringify({ t: 'peers', peers: sockets.map(ws => this.tag(ws)) });
    for (const ws of sockets) {
      try { ws.send(frame); } catch {}
    }
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_FRAME) return;
    if (data.startsWith('{"t":"ping"')) {
      // Clock sync: reply with server time as close to receipt as possible.
      const { c } = JSON.parse(data);
      ws.send(`{"t":"pong","c":${Number(c)},"s":${Date.now()}}`);
      return;
    }
    if (data === '{"t":"end"}') {
      if (this.tag(ws).role === 'host') await this.end(await this.state.storage.get('meta'));
      return;
    }
    for (const peer of this.state.getWebSockets()) if (peer !== ws) peer.send(data);
  }

  async webSocketClose(ws) {
    await this.left(ws);
  }

  async webSocketError(ws) {
    await this.left(ws);
  }

  async left(ws) {
    const { role, peer } = this.tag(ws);
    const stillHere = this.state.getWebSockets().some(other => other !== ws && this.tag(other).peer === peer);
    if (role === 'host' && !stillHere) {
      await this.state.storage.put('hostGoneAt', Date.now());
      await this.state.storage.setAlarm(Date.now() + HOST_GRACE);
    }
    this.presence(ws);
  }

  async alarm() {
    const meta = await this.state.storage.get('meta');
    if (!meta) return;
    const now = Date.now();
    const hostGoneAt = await this.state.storage.get('hostGoneAt');
    const hostBack = this.state.getWebSockets().some(ws => this.tag(ws).role === 'host');
    const hostGone = hostGoneAt && !hostBack && now - hostGoneAt >= HOST_GRACE - 1000;
    if (now >= meta.expires || hostGone) return this.end(meta);
    await this.state.storage.setAlarm(hostGoneAt && !hostBack ? hostGoneAt + HOST_GRACE : meta.expires);
  }

  async end(meta) {
    await this.state.storage.deleteAll();
    await this.state.storage.put('meta', { ...meta, ended: true });
    for (const ws of this.state.getWebSockets()) {
      ws.send('{"t":"ended"}');
      ws.close(4002, 'ended');
    }
  }
}
