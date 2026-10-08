// Runs in the page MAIN world. No extension storage, networking or credentials here.
(() => {
  const MAX_QUEUE = 1000;
  const ID = /^[\w-]{11}$/;
  let channel = '';
  let previous = null;
  let applying = false;
  let lastInteraction = 0;
  let suppressedUntil = 0;
  let applyChain = Promise.resolve();
  let autoplayBlocked = false;
  let remoteVersion = 0;
  let gesture = 0;
  const interactions = new WeakMap();
  const observedPlayers = new WeakSet();
  const keys = new Map();
  const node = tag => /** @type {any} */ (document.querySelector(tag));
  const controller = element => element?.polymerController || element?.inst || element;
  const renderer = item => item?.playlistPanelVideoRenderer || item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
  const text = value => (value?.simpleText || value?.runs?.map(run => run.text).join('') || '').slice(0, 180);
  const send = message => channel && window.dispatchEvent(new CustomEvent('ytmt:from-page', { detail: { channel, ...message } }));
  function difference(before, after) {
    const changes = [];
    if (!before?.supported || !after?.supported) return changes;
    if (after.videoId !== before.videoId || after.queue[after.index]?.key !== before.queue[before.index]?.key) changes.push('song');
    if (after.paused !== before.paused) changes.push('playback');
    if (JSON.stringify(after.queue.map(t => [t.key, t.videoId])) !== JSON.stringify(before.queue.map(t => [t.key, t.videoId]))) changes.push('queue');
    if (after.repeat !== before.repeat || after.shuffle !== before.shuffle) changes.push('modes');
    const predicted = before.position + (before.paused ? 0 : (after.at - before.at) / 1000);
    if (after.videoId === before.videoId && Math.abs(after.position - predicted) > 1.2) changes.push('seek');
    return changes;
  }
  function access() {
    const queue = controller(node('ytmusic-player-queue'))?.queue;
    const player = queue?.playerApi || controller(node('ytmusic-player'))?.playerApi || controller(node('ytmusic-player-bar'))?.playerApi || node('#movie_player');
    if (player && typeof player.addEventListener === 'function' && !observedPlayers.has(player)) {
      observedPlayers.add(player);
      try { player.addEventListener('onAutoplayBlocked', () => { autoplayBlocked = true; poll(); }); } catch {}
    }
    return { queue, player, video: document.querySelector('video') };
  }
  function track(item) {
    const data = renderer(item);
    if (!data || !ID.test(data.videoId)) throw new Error('This queue contains a song that cannot be shared by video ID.');
    const sourceId = `${data.videoId}:${data.navigationEndpoint?.watchEndpoint?.index ?? ''}`;
    const key = data._togetherKey || keys.get(sourceId) || crypto.randomUUID();
    keys.set(sourceId, key);
    if (keys.size > 5000) keys.clear();
    return {
      key, videoId: data.videoId, title: text(data.title), byline: text(data.longBylineText || data.shortBylineText),
      length: text(data.lengthText).slice(0, 20),
      musicVideoType: data.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType || 'MUSIC_VIDEO_TYPE_ATV',
    };
  }
  function snapshot() {
    const { queue, player, video } = access();
    if (typeof queue?.getItems !== 'function' || typeof queue?.store?.dispatch !== 'function' ||
      typeof player?.getVideoData !== 'function' || typeof player?.getPlayerState !== 'function') {
      return { supported: false, error: 'Open YouTube Music and its Up next queue. The native player is not ready or its interfaces have changed.' };
    }
    const items = queue.getItems();
    if (items.length > MAX_QUEUE) return { supported: false, error: 'This queue has more than 1,000 songs. Use a smaller native queue for this session.' };
    const tracks = items.map(track);
    const index = queue.getCurrentItemIndex();
    const queueState = queue.store.getState().queue;
    const data = player.getVideoData() || {};
    const state = player.getPlayerState();
    const duration = Number(player.getDuration?.() || video?.duration || 0);
    const position = Number(player.getCurrentTime?.() || video?.currentTime || 0);
    const videoId = data.video_id || data.videoId || tracks[index]?.videoId || '';
    return {
      supported: true, videoId, queue: tracks, index, duration: Number.isFinite(duration) ? duration : 0,
      position: Number.isFinite(position) ? position : 0, paused: state !== 1 && state !== 3, ended: state === 0,
      buffering: state === 3 || state === -1,
      ready: !autoplayBlocked && !!tracks.length && videoId === tracks[index]?.videoId && duration > 0 && state !== 3 && state !== -1 && (!video || video.readyState >= 3),
      autoplayBlocked,
      repeat: queueState.repeatMode || 'NONE', shuffle: !!queueState.shuffleEnabled,
      at: Date.now(), userInitiated: Date.now() - lastInteraction < 1800,
    };
  }
  function poll() {
    try {
      const state = snapshot();
      const changes = difference(previous, state);
      send({ kind: 'snapshot', state, previous, changes, applying: applying || Date.now() < suppressedUntil });
      previous = state;
    } catch (error) { send({ kind: 'snapshot', state: { supported: false, error: error.message }, changes: [] }); }
  }
  function nativeItem(track, index, selected, local) {
    const own = local.find(item => renderer(item)?.videoId === track.videoId);
    const existing = renderer(own);
    return { playlistPanelVideoRenderer: {
      ...(existing || {}), _togetherKey: track.key, videoId: track.videoId, selected, canReorder: true,
      thumbnail: existing?.thumbnail || { thumbnails: [{ url: `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`, width: 120, height: 90 }] },
      title: { simpleText: track.title || track.videoId },
      longBylineText: { simpleText: track.byline }, shortBylineText: { simpleText: track.byline },
      lengthText: { simpleText: track.length },
      navigationEndpoint: { watchEndpoint: {
        videoId: track.videoId, index,
        watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: track.musicVideoType } },
      } },
      // Locally generated endpoints only remove from the active queue, never saved playlists.
      menu: existing?.menu || { menuRenderer: { items: [{ menuServiceItemRenderer: {
        text: { simpleText: 'Remove from queue' }, icon: { iconType: 'REMOVE' },
        serviceEndpoint: { removeFromQueueEndpoint: { videoId: track.videoId, itemId: String(index) } },
      } }], accessibility: { accessibilityData: { label: 'Song actions' } } } },
    } };
  }
  let generation = 0;
  async function apply(state, expectedGeneration) {
    const check = () => { if (generation !== expectedGeneration) throw new Error('Playback update cancelled by a safety pause.'); };
    check();
    if (!state || !Array.isArray(state.queue) || state.queue.length < 1 || state.queue.length > MAX_QUEUE ||
      !ID.test(state.videoId) || state.queue[state.index]?.videoId !== state.videoId ||
      !state.queue.every(item => ID.test(item.videoId) && /^[\w-]{1,80}$/.test(item.key))) throw new Error('Invalid shared playback state.');
    const { queue, player } = access();
    if (!queue?.store?.dispatch || !player?.pauseVideo || !player?.playVideo || !player?.seekTo) throw new Error('YouTube Music playback controls are unavailable.');
    applying = true;
    remoteVersion++;
    try {
      const current = snapshot();
      const queueChanged = JSON.stringify(current.queue?.map(t => [t.key, t.videoId])) !== JSON.stringify(state.queue.map(t => [t.key, t.videoId]));
      const songChanged = current.videoId !== state.videoId || current.queue?.[current.index]?.key !== state.queue[state.index].key;
      if (state.paused || songChanged) player.pauseVideo();
      if (queueChanged) {
        const local = queue.getItems();
        const items = state.queue.map((entry, index) => nativeItem(entry, index, index === state.index, local));
        // ADD_ITEMS assigns native item indexes and advances nextQueueItemId consistently.
        queue.store.dispatch({ type: 'CLEAR', payload: [] });
        queue.store.dispatch({ type: 'ADD_ITEMS', payload: { items, index: 0, shouldAssignIds: true, nextQueueItemId: 0 } });
        queue.store.dispatch({ type: 'CLEAR_STEERING_CHIPS' });
      }
      if (queueChanged || songChanged || current.index !== state.index) queue.store.dispatch({ type: 'SET_INDEX', payload: state.index });
      if (current.repeat !== state.repeat) queue.store.dispatch({ type: 'SET_REPEAT', payload: state.repeat });
      if (current.shuffle !== state.shuffle) queue.store.dispatch({ type: 'SET_SHUFFLE_ENABLED', payload: !!state.shuffle });
      if (songChanged) {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && (player.getVideoData()?.video_id || player.getVideoData()?.videoId) !== state.videoId) {
          await new Promise(resolve => setTimeout(resolve, 100));
          check();
        }
        if ((player.getVideoData()?.video_id || player.getVideoData()?.videoId) !== state.videoId) {
          throw new Error('YouTube Music could not load the shared song. This song may be unavailable, or the native queue interface changed.');
        }
      }
      const matches = actual => actual.supported && actual.videoId === state.videoId && actual.index === state.index &&
        JSON.stringify(actual.queue.map(t => [t.key, t.videoId])) === JSON.stringify(state.queue.map(t => [t.key, t.videoId])) &&
        actual.repeat === state.repeat && actual.shuffle === state.shuffle;
      const settleBy = Date.now() + 1200;
      while (!matches(snapshot()) && Date.now() < settleBy) { await new Promise(resolve => setTimeout(resolve, 100)); check(); }
      if (!matches(snapshot())) throw new Error('YouTube Music did not apply the shared queue or playback modes. Its native interface may have changed.');
      check();
      const target = Math.min(state.duration, Math.max(0, state.position));
      if (songChanged || Math.abs(Number(player.getCurrentTime()) - target) > 0.35) player.seekTo(target, true);
      if (state.paused || !snapshot().ready) player.pauseVideo();
      else {
        check();
        autoplayBlocked = false;
        player.playVideo();
        await new Promise(resolve => setTimeout(resolve, 200));
        check();
        if (autoplayBlocked) throw new Error('YouTube Music needs a click to play. Press its Play button to resume your session.');
      }
      suppressedUntil = Date.now() + 900;
      previous = snapshot();
      return previous;
    } finally { applying = false; }
  }
  window.addEventListener('ytmt:to-page', event => {
    const message = /** @type {CustomEvent} */ (event).detail;
    if (message?.kind === 'init' && typeof message.channel === 'string') { channel = message.channel; poll(); return; }
    if (!channel || message?.channel !== channel) return;
    if (message.kind === 'snapshot') {
      try { send({ kind: 'reply', id: message.id, state: snapshot() }); }
      catch (error) { send({ kind: 'reply', id: message.id, error: error.message }); }
    }
    if (message.kind === 'pause') { generation++; access().player?.pauseVideo?.(); suppressedUntil = Date.now() + 900; return; }
    if (message.kind === 'apply') {
      const expectedGeneration = generation;
      applyChain = applyChain.catch(() => {}).then(async () => {
        try { send({ kind: 'reply', id: message.id, state: await apply(message.state, expectedGeneration) }); }
        catch (error) { access().player?.pauseVideo?.(); send({ kind: 'reply', id: message.id, error: error.message }); }
      });
    }
  });
  for (const type of ['click', 'keydown', 'pointerup']) document.addEventListener(type, event => {
    if (event.isTrusted) {
      let before; try { before = snapshot(); } catch {}
      const interaction = { before, version: remoteVersion, gesture: ++gesture, emitted: false };
      interactions.set(event, interaction);
      lastInteraction = Date.now();
      autoplayBlocked = false;
      // A deliberate native action must not be discarded as feedback from a recent remote update.
      suppressedUntil = 0;
      setTimeout(() => {
        if (interaction.emitted || interaction.version !== remoteVersion || interaction.gesture !== gesture) return;
        try {
          const state = snapshot(); const changes = difference(before, state);
          if (changes.length) { send({ kind: 'intent', state, previous: before, changes }); previous = state; }
        } catch {}
        poll();
      }, 0);
    }
  }, true);
  // Read synchronous native handlers in the same event, before another remote
  // update can turn a user's addition into an apparent removal. Polling remains
  // available for asynchronous native actions.
  for (const type of ['click', 'keydown', 'pointerup']) document.addEventListener(type, event => {
    const interaction = interactions.get(event);
    if (!interaction || interaction.version !== remoteVersion) return;
    try {
      const state = snapshot(); const changes = difference(interaction.before, state);
      if (changes.length) {
        interaction.emitted = true;
        send({ kind: 'intent', state, previous: interaction.before, changes });
        previous = state;
        poll();
      }
    } catch {}
  });
  setInterval(poll, 400);
})();
