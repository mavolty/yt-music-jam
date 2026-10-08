import { Cipher, digest, invitation } from './crypto.js';
import { validState, validQueue, queueSignature, mergeQueue, positionAt } from './protocol.js';

export class Session {
  constructor(config, hooks) {
    this.config = config;
    this.hooks = hooks;
    this.cipher = new Cipher(config);
    this.state = config.state || null;
    this.revision = config.revision || 0;
    this.desiredPlaying = config.desiredPlaying ?? !this.state?.paused;
    this.local = null;
    this.localReady = false;
    this.peerReady = false;
    this.presence = { host: false, guest: false, approved: false };
    this.phase = 'connecting';
    this.error = '';
    this.closed = false;
    this.hostOffset = 0;
    this.remoteRevision = -1;
    this.remoteEpoch = '';
    this.pendingChanges = new Set();
    this.nativeIntents = [];
    this.flushingNative = false;
    this.commitChain = Promise.resolve();
    this.receiveChain = Promise.resolve();
    this.sendChain = Promise.resolve();
    this.applying = false;
    this.retries = 0;
    this.pairingCode = '';
    this.lastSnapshotAt = 0;
    this.lastReadySent = null;
    this.pendingEnd = null;
    this.blocked = false;
    this.needsRestore = false;
    this.networkUp = true;
    this.peerSeenAt = Date.now();
    this.socket = null;
    this.keepalive = null;
    this.ticker = null;
    this.retryTimer = null;
    digest(config.key).then(value => { this.pairingCode = `${value.slice(0, 4)} ${value.slice(4, 8)} ${value.slice(8, 12)}`; this.notify(); });
  }
  paired() { return this.presence.host && this.presence.guest && this.presence.approved && this.socket?.readyState === WebSocket.OPEN; }
  view() {
    return {
      active: !this.closed, role: this.config.role, phase: this.phase, error: this.error,
      label: this.error || ({ connecting: 'Connecting session…', waiting: 'Waiting for your partner', approving: 'Confirm your partner in the extension', syncing: 'Synchronizing your players…', paused: 'Together · paused', playing: 'Listening together', reconnecting: 'Paused · reconnecting', ended: 'Session ended' }[this.phase] || 'Together'),
      approvalNeeded: this.config.role === 'host' && this.presence.guest && !this.presence.approved,
      invite: this.config.role === 'host' && !this.presence.approved ? invitation(this.config) : '',
      pairingCode: this.pairingCode, peerOnline: this.config.role === 'host' ? this.presence.guest : this.presence.host,
      relay: this.config.relay, title: this.state?.queue?.[this.state.index]?.title || '',
    };
  }
  notify() { this.hooks.status(this.view()); }
  async persist() {
    await this.hooks.save({ ...this.config, state: this.state, revision: this.revision, desiredPlaying: this.desiredPlaying });
  }
  async start() {
    await this.hooks.pause();
    this.connect();
  }
  connect() {
    if (this.closed || !this.networkUp) return;
    const address = this.config.relay.replace(/^http/, 'ws') + `/rooms/${this.config.room}/socket`;
    this.socket = new WebSocket(address);
    const socket = this.socket;
    let lastPong = Date.now();
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', role: this.config.role, token: this.config.token, clientId: this.config.clientId }));
      this.keepalive = setInterval(() => {
        if (Date.now() - lastPong > 45000) socket.close(4000, 'Heartbeat timed out');
        else if (socket.readyState === WebSocket.OPEN) socket.send('ping');
      }, 20000);
    };
    socket.onmessage = event => {
      if (event.data === 'pong') { lastPong = Date.now(); return; }
      this.receiveChain = this.receiveChain.then(async () => {
        const frame = JSON.parse(event.data);
        if (frame.type === 'authenticated') {
          if (frame.resumeToken) { this.config.token = frame.resumeToken; await this.persist(); }
          this.retries = 0;
          return;
        }
        if (frame.type === 'ended') {
          this.pendingEnd?.resolve();
          await this.finish();
          return;
        }
        if (frame.type === 'presence') { await this.onPresence(frame); return; }
        if (frame.type === 'sealed') {
          const message = await this.cipher.open(frame);
          this.peerSeenAt = Date.now();
          if (frame.role === 'host' && this.remoteEpoch !== frame.epoch) { this.remoteEpoch = frame.epoch; this.remoteRevision = -1; }
          await this.onMessage(message);
        }
      }).catch(error => this.fail(error.message));
    };
    socket.onclose = event => {
      clearInterval(this.keepalive); clearInterval(this.ticker);
      if (this.closed || socket !== this.socket) return;
      this.presence = { host: false, guest: false, approved: false };
      this.peerReady = false; this.localReady = false;
      this.phase = 'reconnecting';
      if (this.state) this.state = { ...this.state, position: positionAt(this.state), at: Date.now(), paused: true };
      this.hooks.pause().catch(() => {});
      this.notify();
      if (event.code === 1008 || event.code === 1009) {
        this.fail(`Session rejected: ${event.reason || 'invalid or expired invitation'}. Create a fresh session.`);
        return;
      }
      this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retries++, 10000));
    };
    socket.onerror = () => { this.phase = 'reconnecting'; this.notify(); };
    this.notify();
  }
  async onPresence(frame) {
    const wasPaired = this.paired();
    this.presence = { host: !!frame.host, guest: !!frame.guest, approved: !!frame.approved };
    if (!this.paired()) {
      this.peerReady = false; this.lastReadySent = null;
      await this.hooks.pause();
      if (this.state) this.state = { ...this.state, position: positionAt(this.state), at: Date.now(), paused: true };
      this.phase = this.presence.guest && !this.presence.approved ? 'approving' : 'waiting';
      this.notify(); return;
    }
    if (!wasPaired) {
      this.peerSeenAt = Date.now();
      this.phase = 'syncing'; this.peerReady = false; this.lastReadySent = null; this.error = '';
      clearInterval(this.ticker);
      this.ticker = setInterval(() => this.tick().catch(error => this.fail(error.message)), 2000);
      if (this.config.role === 'host' && this.state) {
        this.state = { ...this.state, position: positionAt(this.state), at: Date.now(), paused: true };
        await this.publish();
      }
      await this.send({ kind: 'ready', ready: this.localReady });
      this.lastReadySent = this.localReady;
    }
    this.notify();
  }
  async send(message) {
    if (!this.paired()) return;
    this.sendChain = this.sendChain.then(async () => {
      const frame = await this.cipher.seal(message);
      if (this.paired()) this.socket.send(JSON.stringify(frame));
    });
    return this.sendChain;
  }
  async tick() {
    if (!this.paired()) return;
    if (Date.now() - this.peerSeenAt > 6500) {
      await this.hooks.pause();
      this.socket.close(4000, 'Partner heartbeat missing');
      return;
    }
    await this.send({ kind: 'ready', ready: this.localReady });
    if (this.config.role === 'host') {
      if (this.state) await this.publish();
    } else await this.send({ kind: 'clock', sentAt: Date.now() });
  }
  async onMessage(message) {
    if (!message || typeof message.kind !== 'string') throw new Error('Invalid private session message.');
    if (message.kind === 'clock' && this.config.role === 'host' && Number.isFinite(message.sentAt)) {
      await this.send({ kind: 'clock-reply', sentAt: message.sentAt, hostAt: Date.now() }); return;
    }
    if (message.kind === 'clock-reply' && this.config.role === 'guest') {
      const rtt = Date.now() - message.sentAt;
      if (Number.isFinite(message.hostAt) && rtt >= 0 && rtt < 10000) this.hostOffset = message.hostAt + rtt / 2 - Date.now();
      return;
    }
    if (message.kind === 'ready' && typeof message.ready === 'boolean') {
      this.peerReady = message.ready;
      if (this.config.role === 'host') await this.reconcileReadiness();
      return;
    }
    if (message.kind === 'intent' && this.config.role === 'host') {
      if (!validState(message.state) || !Array.isArray(message.changes) || !validQueue(message.before, true)) throw new Error('Invalid shared playback command.');
      await this.enqueueIntent(message); return;
    }
    if (message.kind === 'snapshot' && this.config.role === 'guest') {
      if (!validState(message.state) || !Number.isSafeInteger(message.revision) || message.revision < 0 || !Number.isFinite(message.state.at)) throw new Error('Invalid shared playback snapshot.');
      if (message.revision < this.remoteRevision) return;
      this.remoteRevision = message.revision;
      const state = message.state;
      this.state = state;
      const target = positionAt(state, Date.now() + this.hostOffset);
      const needsApply = !this.local || this.local.videoId !== state.videoId || this.local.paused !== state.paused ||
        this.local.index !== state.index || queueSignature(this.local.queue) !== queueSignature(state.queue) ||
        this.local.repeat !== state.repeat || this.local.shuffle !== state.shuffle || Math.abs(positionAt(this.local) - target) > 0.45;
      if (needsApply) await this.apply({ ...state, position: target });
      this.phase = state.paused ? 'paused' : 'playing';
      this.notify();
      await this.persist();
      return;
    }
    throw new Error('Unexpected private session message.');
  }
  async nativeUpdate(event) {
    const incoming = event.state;
    if (this.closed) return;
    this.local = incoming;
    if (!incoming?.supported) { await this.fail(incoming?.error || 'YouTube Music native controls are unavailable.'); return; }
    if (incoming.autoplayBlocked && !incoming.userInitiated) { await this.fail('YouTube Music needs a click to play. Press its Play button to resume your session.'); return; }
    if (!event.applying && !this.applying && Array.isArray(event.changes) && (incoming.userInitiated || this.config.role === 'host')) {
      for (const change of event.changes) if (['song', 'queue', 'seek', 'playback', 'modes'].includes(change)) this.pendingChanges.add(change);
      if (!this.pendingBefore && event.previous?.queue) this.pendingBefore = event.previous.queue;
    }
    if (this.needsRestore && incoming.supported && this.state && !this.applying) {
      this.needsRestore = false;
      await this.apply({ ...this.state, position: positionAt(this.state), paused: true });
      this.phase = 'syncing'; this.notify();
      return;
    }
    if (this.blocked && incoming.userInitiated && validState(incoming)) { this.blocked = false; this.error = ''; }
    this.localReady = this.networkUp && !this.blocked && validState(incoming) && incoming.ready;
    if (this.paired() && this.lastReadySent !== this.localReady) {
      this.lastReadySent = this.localReady;
      await this.send({ kind: 'ready', ready: this.localReady });
      if (this.config.role === 'host') await this.reconcileReadiness();
    }
    if (!validState(incoming) || event.applying || this.applying || !this.paired() || !this.pendingChanges.size) return;
    const changes = [...this.pendingChanges];
    const before = this.pendingBefore || this.state?.queue || incoming.queue;
    this.pendingChanges.clear(); this.pendingBefore = null;
    const intent = { kind: 'intent', state: incoming, changes, before };
    if (this.config.role === 'host') await this.enqueueIntent(intent);
    else await this.send(intent);
  }
  async nativeIntent(event) {
    if (!this.paired() || !validState(event.state) || !validQueue(event.previous?.queue, true) || !Array.isArray(event.changes)) return;
    this.nativeIntents.push({ kind: 'intent', state: event.state, before: event.previous.queue, changes: event.changes });
    if (this.nativeIntents.length > 30) throw new Error('Too many pending native actions. Pause and let the players synchronize.');
    await this.flushNative();
  }
  async flushNative() {
    if (this.flushingNative || this.applying || !this.paired()) return;
    this.flushingNative = true;
    try {
      while (this.nativeIntents.length && !this.applying && this.paired()) {
        const intent = this.nativeIntents.shift();
        if (this.config.role === 'host') await this.enqueueIntent(intent);
        else await this.send(intent);
      }
    } finally { this.flushingNative = false; }
  }
  async enqueueIntent(intent) {
    this.commitChain = this.commitChain.then(async () => {
      const incoming = intent.state;
      const changes = intent.changes;
      if (!validState(incoming) || !changes.every(change => ['song', 'queue', 'seek', 'playback', 'modes'].includes(change))) throw new Error('Invalid playback change.');
      const prior = this.state || incoming;
      let queue = prior.queue;
      if (changes.includes('queue')) {
        const replacement = changes.includes('song') && !intent.before.some(item => incoming.queue.some(entry => entry.key === item.key));
        queue = mergeQueue(intent.before, incoming.queue, prior.queue, replacement);
      }
      let selected = changes.includes('song') ? incoming.queue[incoming.index].key : prior.queue[prior.index].key;
      let index = queue.findIndex(item => item.key === selected);
      if (index < 0) index = Math.min(prior.index, queue.length - 1);
      if (index < 0 || queue.length > 1000) throw new Error('The shared queue is empty or too large.');
      const songChanged = queue[index].videoId !== prior.videoId || queue[index].key !== prior.queue[prior.index].key;
      if (changes.includes('playback') && !incoming.buffering && (!incoming.ended || incoming.userInitiated)) this.desiredPlaying = !incoming.paused;
      if (songChanged) this.peerReady = false;
      this.state = {
        ...prior, videoId: queue[index].videoId, queue, index,
        duration: songChanged ? incoming.duration : prior.duration,
        position: songChanged || changes.includes('seek') ? incoming.position : positionAt(prior),
        paused: !this.desiredPlaying || !this.localReady || !this.peerReady,
        repeat: changes.includes('modes') ? incoming.repeat : prior.repeat,
        shuffle: changes.includes('modes') ? incoming.shuffle : prior.shuffle,
        ready: true, at: Date.now(),
      };
      if (!validState(this.state)) throw new Error('The native queue change cannot be synchronized.');
      this.revision++;
      this.error = '';
      await this.publish();
      await this.apply(this.state);
      await this.persist();
    });
    return this.commitChain;
  }
  async reconcileReadiness() {
    if (!this.state || !this.paired()) return;
    const shouldPause = !this.desiredPlaying || !this.localReady || !this.peerReady;
    if (this.state.paused === shouldPause) return;
    this.state = { ...this.state, position: positionAt(this.state), at: Date.now(), paused: shouldPause };
    this.revision++;
    await this.publish();
    await this.apply(this.state);
    await this.persist();
  }
  async publish() {
    if (!this.state || !this.paired()) return;
    let position = positionAt(this.state);
    if (this.local?.videoId === this.state.videoId && this.local.ready && this.local.paused === this.state.paused) {
      position = this.local.position + (this.local.paused ? 0 : Math.max(0, Date.now() - this.local.at) / 1000);
    }
    this.state = { ...this.state, position: Math.min(this.state.duration, position), at: Date.now() };
    await this.send({ kind: 'snapshot', revision: this.revision, state: this.state });
    this.phase = this.state.paused ? 'paused' : 'playing'; this.notify();
  }
  async apply(state) {
    this.applying = true;
    try {
      const result = await this.hooks.apply(state);
      this.local = result;
      this.localReady = validState(result) && result.ready;
      if (this.paired()) { await this.send({ kind: 'ready', ready: this.localReady }); this.lastReadySent = this.localReady; }
    } finally { this.applying = false; this.flushNative().catch(error => this.fail(error.message)); }
  }
  approve() {
    if (this.config.role !== 'host' || !this.presence.guest || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Your partner must join before confirmation.');
    this.socket.send(JSON.stringify({ type: 'approve' }));
  }
  async fail(message) {
    this.error = message;
    this.phase = 'paused';
    this.desiredPlaying = false;
    this.blocked = true;
    this.pendingChanges.clear();
    await this.hooks.pause().catch(() => {});
    if (this.paired()) {
      this.localReady = false;
      this.lastReadySent = false;
      await this.send({ kind: 'ready', ready: false }).catch(() => {});
    }
    this.notify();
  }
  async detached() {
    if (this.closed) return;
    this.needsRestore = true;
    this.localReady = false;
    this.lastReadySent = false;
    this.phase = 'reconnecting';
    if (this.state) this.state = { ...this.state, position: positionAt(this.state), at: Date.now(), paused: true };
    if (this.paired()) {
      await this.send({ kind: 'ready', ready: false });
      if (this.config.role === 'host') await this.publish();
    }
    this.notify();
  }
  async network(online) {
    this.networkUp = online;
    if (!online) {
      this.localReady = false; this.lastReadySent = false;
      await this.hooks.pause().catch(() => {});
      if (this.paired()) await this.send({ kind: 'ready', ready: false }).catch(() => {});
      this.socket?.close(4000, 'Local network offline');
      this.phase = 'reconnecting'; this.notify();
    } else if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      clearTimeout(this.retryTimer); this.connect();
    }
  }
  async end() {
    if (this.closed) return;
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Reconnect before ending the session so the relay can invalidate its invite. Both players remain paused.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingEnd = null; reject(new Error('The relay did not confirm session closure. Try again after reconnecting.')); }, 4000);
      this.pendingEnd = { resolve: () => { clearTimeout(timer); resolve(undefined); }, reject };
      this.socket.send(JSON.stringify({ type: 'end' }));
    });
  }
  async finish() {
    this.closed = true;
    clearInterval(this.keepalive); clearInterval(this.ticker); clearTimeout(this.retryTimer);
    this.socket?.close(1000, 'Session ended');
    await this.hooks.pause().catch(() => {});
    this.state = null;
    await this.hooks.clear();
    this.phase = 'ended'; this.notify();
  }
}
