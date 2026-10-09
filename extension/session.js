import { Cipher, digest, invitation } from './crypto.js';
import { validState, validCommand, validQueue, queueSignature, mergeQueue, positionAt } from './protocol.js';

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
    this.remoteRevision = config.remoteRevision ?? -1;
    this.remoteEpoch = config.remoteEpoch || '';
    this.retiredEpochs = new Set(config.retiredEpochs || []);
    this.transportGeneration = 0;
    this.applyGeneration = 0;
    this.nativeIntents = [];
    this.intentEpoch = crypto.randomUUID();
    this.intentSequence = 0;
    this.pendingGuestSequence = 0;
    this.pendingGuestAt = 0;
    this.guestAck = config.guestAck || null;
    this.flushingNative = false;
    this.commitChain = Promise.resolve();
    this.receiveChain = Promise.resolve();
    this.sendChain = Promise.resolve();
    this.applying = 0;
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
      canDiscard: this.phase === 'reconnecting' || !!this.error,
    };
  }
  notify() { this.hooks.status(this.view()); }
  matchesSelection(state, canonical = this.state) {
    return !!state && !!canonical && state.videoId === canonical.videoId &&
      state.queue?.[state.index]?.key === canonical.queue[canonical.index]?.key;
  }
  async sendReady() {
    await this.send({ kind: 'ready', ready: this.localReady,
      videoId: this.local?.videoId || '', key: this.local?.queue?.[this.local.index]?.key || '' });
    this.lastReadySent = this.localReady;
  }
  async persist() {
    if (this.closed) return;
    await this.hooks.save({ ...this.config, state: this.state, revision: this.revision, desiredPlaying: this.desiredPlaying,
      received: [...this.cipher.received], remoteEpoch: this.remoteEpoch, remoteRevision: this.remoteRevision, retiredEpochs: [...this.retiredEpochs], guestAck: this.guestAck });
  }
  async start() {
    await this.hooks.pause();
    this.connect();
  }
  connect() {
    if (this.closed || !this.networkUp) return;
    if (this.config.expiresAt && this.config.expiresAt <= Date.now()) { this.fail('Session expired. Leave locally and create a fresh session.'); return; }
    const generation = ++this.transportGeneration;
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
        if (this.closed || generation !== this.transportGeneration || socket !== this.socket) return;
        const frame = JSON.parse(event.data);
        if (frame.type === 'authenticated') {
          this.config.expiresAt = frame.expiresAt;
          await this.persist();
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
          if (this.closed || generation !== this.transportGeneration) return;
          this.peerSeenAt = Date.now();
          if (frame.role === 'host' && this.remoteEpoch !== frame.epoch) {
            if (this.retiredEpochs.has(frame.epoch)) throw new Error('Retired session message rejected.');
            if (this.remoteEpoch) this.retiredEpochs.add(this.remoteEpoch);
            this.remoteEpoch = frame.epoch; this.remoteRevision = -1;
          }
          // Persist authenticated replay watermarks before any playback side effect.
          await this.persist();
          if (generation !== this.transportGeneration) return;
          await this.onMessage(message);
        }
      }).catch(error => this.fail(error.message));
    };
    socket.onclose = event => {
      clearInterval(this.keepalive); clearInterval(this.ticker);
      if (this.closed || socket !== this.socket) return;
      this.transportGeneration++; this.applyGeneration++;
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
      this.applyGeneration++;
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
      await this.sendReady();
    }
    this.notify();
  }
  async send(message) {
    if (!this.paired()) return;
    this.sendChain = this.sendChain.catch(() => {}).then(async () => {
      const frame = await this.cipher.seal(message);
      if (this.paired()) this.socket.send(JSON.stringify(frame));
    });
    return this.sendChain;
  }
  async tick() {
    if (!this.paired()) return;
    if (Date.now() - this.peerSeenAt > 6500) {
      this.applyGeneration++;
      await this.hooks.pause();
      this.socket.close(4000, 'Partner heartbeat missing');
      return;
    }
    if (this.pendingGuestSequence && Date.now() - this.pendingGuestAt > 45000) {
      await this.fail('Your action was not confirmed. Let both players reconnect, then press Play to retry.'); return;
    }
    await this.sendReady();
    if (this.config.role === 'host') {
      // During startup the canonical playing clock would advance while native
      // media is still loading. Its final acknowledgement anchors that clock.
      if (this.state && !this.applying) await this.publish();
    } else await this.send({ kind: 'clock', sentAt: Date.now() });
  }
  async onMessage(message) {
    if (!this.paired() || !this.networkUp || this.closed) return;
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
      if (message.ready && (message.videoId !== this.state?.videoId || message.key !== this.state?.queue[this.state.index]?.key)) return;
      this.peerReady = message.ready;
      if (this.config.role === 'host') await this.reconcileReadiness();
      return;
    }
    if (message.kind === 'intent' && this.config.role === 'host') {
      if (!validCommand(message.state) || !Array.isArray(message.changes) || !validQueue(message.before, true) ||
        !/^[a-f0-9-]{36}$/.test(message.epoch) || !Number.isSafeInteger(message.sequence) || message.sequence < 1) throw new Error('Invalid shared playback command.');
      await this.enqueueIntent(message, true); return;
    }
    if (message.kind === 'snapshot' && this.config.role === 'guest') {
      if (!validState(message.state) || !Number.isSafeInteger(message.revision) || message.revision < 0 || !Number.isFinite(message.state.at)) throw new Error('Invalid shared playback snapshot.');
      if (message.revision < this.remoteRevision) return;
      this.remoteRevision = message.revision;
      const state = message.state;
      this.state = state;
      await this.persist();
      if (!this.paired() || !this.networkUp || this.blocked) return;
      if (message.ack?.epoch === this.intentEpoch && Number.isSafeInteger(message.ack.sequence) && message.ack.sequence >= this.pendingGuestSequence) this.pendingGuestSequence = 0;
      // Older canonical snapshots still carry safety pauses, but must not reset
      // a native queue selection whose command is awaiting host acceptance.
      if (this.pendingGuestSequence) {
        if (state.paused) { this.applyGeneration++; await this.hooks.pause(); }
        this.phase = 'syncing'; this.notify(); return;
      }
      const target = positionAt(state, Date.now() + this.hostOffset);
      const needsApply = !this.local || this.local.videoId !== state.videoId || this.local.paused !== state.paused ||
        this.local.index !== state.index || queueSignature(this.local.queue) !== queueSignature(state.queue) ||
        this.local.repeat !== state.repeat || this.local.shuffle !== state.shuffle || Math.abs(positionAt(this.local) - target) > 0.45;
      if (needsApply) await this.apply({ ...state, position: target });
      if (!this.paired() || !this.networkUp || this.blocked || this.closed) return;
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
    if (!incoming?.supported) {
      if (this.needsRestore) { this.error = incoming?.error || 'Waiting for the native player after reload.'; this.notify(); return; }
      await this.fail(incoming?.error || 'YouTube Music native controls are unavailable.'); return;
    }
    if (!this.networkUp || !this.paired()) {
      this.localReady = false;
      if (!incoming.paused) { this.applyGeneration++; await this.hooks.pause(); }
      return;
    }
    if (incoming.autoplayBlocked && !incoming.userInitiated) { await this.fail('YouTube Music needs a click to play. Press its Play button to resume your session.'); return; }
    // Intermediate native states belong to the outstanding command. Its final
    // acknowledgement updates readiness; polling must not interrupt startup.
    if (this.applying) return;
    if (this.needsRestore && incoming.supported && this.state && !this.applying) {
      this.needsRestore = false;
      this.error = '';
      await this.apply({ ...this.state, position: positionAt(this.state), paused: true });
      this.phase = 'syncing'; this.notify();
      return;
    }
    if (this.blocked && incoming.userInitiated && validState(incoming)) { this.blocked = false; this.error = ''; }
    // Capture automatic host changes before readiness can apply an older song.
    // User gestures have their own immutable intent, emitted before this poll.
    if (!event.applying && (incoming.userInitiated || this.config.role === 'host') && event.changes?.length) {
      const selected = incoming.queue[incoming.index];
      // Playback requests are captured at native controls or a tracked song
      // gesture. A later paused flag alone cannot identify a new user request;
      // it may be a delayed effect of an already superseded native command.
      const changes = event.changes.filter(change => ['song', 'queue', 'seek', 'modes'].includes(change));
      if (selected && changes.length) {
        const command = { ...incoming, videoId: selected.videoId,
          duration: selected.videoId === incoming.videoId ? incoming.duration : 0,
          position: changes.includes('song') ? 0 : incoming.position,
          ready: selected.videoId === incoming.videoId && incoming.ready };
        await this.nativeIntent({ state: command, previous: event.previous, changes });
        return;
      }
    }
    this.localReady = this.networkUp && !this.blocked && validState(incoming) && incoming.ready && this.matchesSelection(incoming);
    if (this.nativeIntents.length || this.flushingNative || this.pendingGuestSequence) return;
    if (!this.localReady && !this.applying && this.paired() && !incoming.paused) { this.applyGeneration++; await this.hooks.pause(); }
    if (this.paired() && this.lastReadySent !== this.localReady) {
      await this.sendReady();
    }
    if (this.config.role === 'host' && this.paired()) await this.reconcileReadiness();
  }
  async nativeIntent(event) {
    if (this.closed || !this.networkUp || !this.paired() || !validCommand(event.state) || !validQueue(event.previous?.queue, true) || !Array.isArray(event.changes)) return;
    // Intent arrives before the following snapshot. Let the same deliberate
    // click recover a blocked player instead of dropping it at enqueueIntent.
    if (this.blocked && event.state.userInitiated) { this.blocked = false; this.error = ''; }
    const intent = { kind: 'intent', state: event.state, before: event.previous.queue, changes: event.changes,
      epoch: this.intentEpoch, sequence: ++this.intentSequence };
    this.nativeIntents.push(intent);
    if (this.config.role === 'guest') { this.pendingGuestSequence = intent.sequence; this.pendingGuestAt = Date.now(); }
    if (this.nativeIntents.length > 30) throw new Error('Too many pending native actions. Pause and let the players synchronize.');
    if (this.applying && event.state.userInitiated) {
      this.applyGeneration++;
      await this.hooks.pause();
    }
    if (!this.applying) {
      this.local = event.state;
      this.localReady = !this.blocked && event.state.ready && this.matchesSelection(event.state);
    }
    await this.flushNative();
  }
  async flushNative() {
    if (this.flushingNative || this.applying || !this.paired()) return;
    this.flushingNative = true;
    try {
      while (this.nativeIntents.length && !this.applying && this.paired()) {
        const intent = this.nativeIntents.shift();
        if (this.config.role === 'host') await this.enqueueIntent(intent);
        else { await this.send(intent); await this.sendReady(); }
      }
    } finally { this.flushingNative = false; }
  }
  async enqueueIntent(intent, fromGuest = false) {
    this.commitChain = this.commitChain.catch(() => {}).then(async () => {
      if (!this.paired() || !this.networkUp || this.blocked) return;
      const incoming = intent.state;
      const changes = intent.changes;
      if (!validCommand(incoming) || !changes.every(change => ['song', 'queue', 'seek', 'playback', 'modes'].includes(change))) throw new Error('Invalid playback change.');
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
      const duration = songChanged ? incoming.duration : prior.duration ||
        (incoming.videoId === queue[index].videoId && incoming.queue[incoming.index].key === queue[index].key ? incoming.duration : 0);
      // Native Play can report BUFFERING before PLAYING. Preserve the user's
      // request while readiness pauses the shared timeline; automatic buffering
      // and end-of-track transitions must not replace that request.
      if (changes.includes('playback') && (incoming.userInitiated || (!incoming.buffering && !incoming.ended))) this.desiredPlaying = !incoming.paused;
      if (songChanged) { this.peerReady = false; this.localReady = false; }
      this.state = {
        ...prior, videoId: queue[index].videoId, queue, index,
        duration,
        position: songChanged || changes.includes('seek') ? incoming.position : positionAt(prior),
        paused: !this.desiredPlaying || !this.localReady || !this.peerReady,
        repeat: changes.includes('modes') ? incoming.repeat : prior.repeat,
        shuffle: changes.includes('modes') ? incoming.shuffle : prior.shuffle,
        ready: duration > 0, at: Date.now(),
      };
      if (!validState(this.state)) throw new Error('The native queue change cannot be synchronized.');
      if (fromGuest) this.guestAck = { epoch: intent.epoch, sequence: intent.sequence };
      this.revision++;
      this.error = '';
      await this.publish(false);
      await this.apply(this.state);
      await this.persist();
    });
    return this.commitChain;
  }
  async reconcileReadiness() {
    this.commitChain = this.commitChain.catch(() => {}).then(async () => {
      if (!this.state || !this.paired() || !this.networkUp || this.blocked || this.nativeIntents.length) return;
      const durationChanged = this.localReady && this.matchesSelection(this.local) && this.state.duration !== this.local.duration;
      const shouldPause = !this.desiredPlaying || !this.localReady || !this.peerReady;
      const playbackChanged = this.state.paused !== shouldPause;
      const nativeMismatch = this.localReady && this.matchesSelection(this.local) && this.local.paused !== shouldPause;
      if (!durationChanged && !playbackChanged && !nativeMismatch) return;
      this.state = { ...this.state, duration: durationChanged ? this.local.duration : this.state.duration,
        ready: durationChanged || this.state.ready, position: positionAt(this.state), at: Date.now(), paused: shouldPause };
      this.revision++;
      await this.publish(false);
      if (playbackChanged || nativeMismatch) await this.apply(this.state);
      await this.persist();
    });
    return this.commitChain;
  }
  async publish(sampleLocal = true) {
    if (!this.state || !this.paired()) return;
    let position = positionAt(this.state);
    if (sampleLocal && this.local?.videoId === this.state.videoId && this.local.ready && this.local.paused === this.state.paused) {
      position = this.local.position + (this.local.paused ? 0 : Math.max(0, Date.now() - this.local.at) / 1000);
    }
    this.state = { ...this.state, position: Math.min(this.state.duration, position), at: Date.now() };
    await this.send({ kind: 'snapshot', revision: this.revision, state: this.state, ack: this.guestAck });
    this.phase = this.state.paused ? 'paused' : 'playing'; this.notify();
  }
  async apply(state) {
    const generation = this.applyGeneration;
    if (!state.paused && (!this.paired() || !this.networkUp || this.blocked)) return;
    this.applying++;
    try {
      const result = await this.hooks.apply(state);
      if (generation !== this.applyGeneration || this.closed) { await this.hooks.pause(); return; }
      this.local = result;
      this.localReady = validState(result) && result.ready && this.matchesSelection(result);
      if (this.config.role === 'host' && this.localReady && this.state.duration !== result.duration) {
        this.state = { ...this.state, duration: result.duration, ready: true }; this.revision++;
      }
      if (this.paired()) await this.sendReady();
      if (generation === this.applyGeneration && this.paired() && this.networkUp && !this.closed && !this.blocked &&
        this.config.role === 'host' && this.localReady && result.paused === this.state.paused) {
        this.state = { ...this.state, position: result.position, at: result.at };
        this.revision++;
        await this.publish(false);
      }
    } catch (error) { if (generation === this.applyGeneration && !this.closed) throw error; }
    finally { this.applying--; this.flushNative().catch(error => this.fail(error.message)); }
  }
  approve() {
    if (this.config.role !== 'host' || !this.presence.guest || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Your partner must join before confirmation.');
    this.socket.send(JSON.stringify({ type: 'approve' }));
  }
  async fail(message) {
    if (this.closed) return;
    if (this.needsRestore) { this.phase = 'reconnecting'; this.error = message; this.notify(); return; }
    this.applyGeneration++;
    this.error = message;
    this.phase = 'paused';
    this.desiredPlaying = false;
    this.blocked = true;
    this.nativeIntents.length = 0; this.pendingGuestSequence = 0;
    await this.hooks.pause().catch(() => {});
    if (this.paired()) {
      this.localReady = false;
      this.lastReadySent = false;
      await this.sendReady().catch(() => {});
    }
    this.notify();
  }
  async detached() {
    if (this.closed) return;
    this.applyGeneration++;
    this.needsRestore = true;
    this.localReady = false;
    this.lastReadySent = false;
    this.phase = 'reconnecting';
    if (this.state) this.state = { ...this.state, position: positionAt(this.state), at: Date.now(), paused: true };
    if (this.paired()) {
      await this.sendReady();
      if (this.config.role === 'host') await this.publish();
    }
    this.notify();
  }
  async network(online) {
    this.networkUp = online;
    if (!online) {
      this.applyGeneration++; this.transportGeneration++;
      this.localReady = false; this.lastReadySent = false;
      await this.hooks.pause().catch(() => {});
      if (this.paired()) await this.sendReady().catch(() => {});
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
  async discard() {
    await this.finish();
    return { active: false, notice: 'Left this device. Relay closure was not confirmed; the invitation expires within six hours. Ask your partner to end the session if it is still active.' };
  }
  async finish() {
    this.closed = true;
    this.applyGeneration++; this.transportGeneration++;
    clearInterval(this.keepalive); clearInterval(this.ticker); clearTimeout(this.retryTimer);
    this.socket?.close(1000, 'Session ended');
    await this.hooks.pause().catch(() => {});
    this.state = null;
    await this.hooks.clear();
    this.phase = 'ended'; this.notify();
  }
}
