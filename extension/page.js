// Main world: drives YouTube Music's own player.
//
// Loop-free by construction:
//   * User intent is captured only at the input (player bar buttons, keyboard
//     shortcuts, media keys, progress bar, song navigation, queue menus) and
//     sent to the session. It is never inferred from player state, so
//     applying a remote change cannot echo back.
//   * The page converges the player to the session's target: same song, same
//     play state, same position on the shared server clock. Drift is fixed
//     with small playback-rate nudges, large gaps with a seek.
(() => {
  const TO_PAGE = 'ytm-jam:to-page';
  const FROM_PAGE = 'ytm-jam:from-page';
  const TICK = 100;
  const SEEK_THRESHOLD = 0.2;
  const SEEK_COOLDOWN = 1500;
  const DEADBAND = 0.012;
  const MAX_NUDGE = 0.05;
  const END_HOLD = 0.3;
  const PICK_WINDOW = 6000;

  let target = null; // shared playback target, null when not in a Jam
  let offset = 0; // server clock - local clock, ms
  let role = null;
  let loading = null; // { videoId, since } navigation we started
  let reported = null; // { videoId, since } song change sent to the session
  let picked = null; // { videoId|null, since } user navigated to a song
  let lastId = null;
  let endedFor = null;
  let scrubbing = false;
  let seekAt = 0;
  let seekLead = 0.15; // learned: how far ahead to seek so playback lands on time
  let settled = true;
  let smoothed = 0;

  const serverNow = () => Date.now() + offset;
  const send = message => document.dispatchEvent(new CustomEvent(FROM_PAGE, { detail: JSON.stringify(message) }));
  const intent = value => send({ type: 'intent', intent: value });
  const toast = text => send({ type: 'toast', text });
  const log = (...args) => console.debug('[jam]', ...args);
  const active = () => Boolean(target?.videoId);
  const inPath = (event, selector) => event.composedPath().some(node => node instanceof Element && node.matches(selector));

  // ---------- YTM adapter ----------

  const player = () => document.querySelector('#movie_player');
  const video = () => player()?.querySelector('video') || document.querySelector('video');
  const adShowing = () => Boolean(player()?.classList.contains('ad-showing'));
  const playerState = () => player()?.getPlayerState?.();
  const currentId = () => {
    try { return player()?.getVideoData?.()?.video_id || null; } catch { return null; }
  };

  function songMeta(videoId) {
    const data = player()?.getVideoData?.() || {};
    const meta = navigator.mediaSession?.metadata;
    const fresh = data.video_id === videoId;
    const title = (fresh && data.title) || '';
    const artist = (fresh && meta?.title === title && meta.artist) || (fresh && data.author) || '';
    const art = (meta?.title === title && meta.artwork?.at(-1)?.src) || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    return { videoId, title, artist: artist.replace(/ - Topic$/, ''), art };
  }

  function load(videoId, startSeconds) {
    if (loading?.videoId === videoId && Date.now() - loading.since < 6000) return;
    loading = { videoId, since: Date.now() };
    const watchEndpoint = { videoId };
    if (startSeconds > 1) watchEndpoint.startTimeSeconds = Math.floor(startSeconds);
    document.body.dispatchEvent(new CustomEvent('yt-navigate', {
      bubbles: true, composed: true, detail: { endpoint: { watchEndpoint } }
    }));
  }

  function seek(seconds) {
    const v = video();
    if (!v) return;
    v.currentTime = Math.max(0, seconds);
    seekAt = Date.now();
    settled = false;
  }

  const rawPlay = () => player()?.playVideo?.();
  const rawPause = () => player()?.pauseVideo?.();

  function setRate(rate) {
    const v = video();
    if (v && Math.abs(v.playbackRate - rate) > 0.0005) v.playbackRate = rate;
  }

  // ---------- convergence ----------

  const expectedPos = (now = serverNow()) => (target.playing ? target.pos + (now - target.at) / 1000 : target.pos);

  function reconcile() {
    if (!active()) return;
    const v = video();
    const id = currentId();
    if (adShowing()) return;

    if (id !== target.videoId) {
      if (id && id !== lastId) noticeSongChange(id);
      lastId = id;
      if (reported?.videoId === id && Date.now() - reported.since < 2000) return; // session is adopting it
      setRate(1);
      load(target.videoId, expectedPos());
      return;
    }
    lastId = id;
    loading = null;
    reported = null;
    if (!v || v.readyState < 2 || scrubbing) return;

    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    if (!target.playing) {
      if (!v.paused) rawPause();
      if (Math.abs(v.currentTime - target.pos) > 0.25) seek(target.pos);
      setRate(1);
      return;
    }

    const now = serverNow();
    const expected = expectedPos(now);
    if (dur && (expected > dur - END_HOLD || playerState() === 0)) {
      // Hold at the end so the session picks what comes next, not each YTM.
      if (!v.paused) rawPause();
      if (endedFor !== target.v) {
        endedFor = target.v;
        log('ended', id, expected.toFixed(2), dur);
        intent({ kind: 'ended' });
      }
      return;
    }

    if (now < target.at) {
      // Start barrier: wait paused at the start position, start on the beat.
      if (!v.paused) rawPause();
      if (Math.abs(v.currentTime - target.pos) > 0.05) seek(target.pos);
      startAt(target.at);
      return;
    }

    if (v.paused || playerState() === 2) {
      if (Math.abs(v.currentTime - expected) > 0.15) seek(expected + seekLead);
      rawPlay();
      return;
    }
    if (v.seeking || playerState() === 3) return; // buffering; judge once it plays

    const error = v.currentTime - expected;
    if (seekAt && !settled) {
      // First clean reading after our seek: learn how far off it landed.
      settled = true;
      seekLead = Math.min(1.5, Math.max(0, seekLead - error * 0.7));
      smoothed = error;
    }
    smoothed = smoothed * 0.7 + error * 0.3; // currentTime jitters by ~20 ms
    window.__jamDebug = { error, smoothed, offset, seekLead }; // read by e2e traces

    // Right after a change a quick re-seek is unnoticeable; later, prefer nudging.
    const threshold = now - target.at < 4000 ? 0.08 : SEEK_THRESHOLD;
    if (Math.abs(smoothed) > threshold && Date.now() - seekAt > SEEK_COOLDOWN) {
      seek(expected + seekLead);
      setRate(1);
    } else if (Math.abs(smoothed) < DEADBAND) {
      setRate(1);
    } else {
      setRate(1 - Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, smoothed * 0.8)));
    }
  }

  function noticeSongChange(id) {
    if (reported?.videoId === id || loading?.videoId === id) return;
    if (loading && Date.now() - loading.since < 1500) return; // our navigation is still settling
    const userPicked = picked && Date.now() - picked.since < PICK_WINDOW && (!picked.videoId || picked.videoId === id);
    picked = null;
    if (!userPicked && role !== 'host') return; // guests follow the host's autoplay
    log('song change', id, userPicked ? 'picked' : 'auto');
    reported = { videoId: id, since: Date.now() };
    const song = songMeta(id);
    intent({ kind: 'song', auto: !userPicked, song });
    if (!song.title) setTimeout(() => intent({ kind: 'meta', song: songMeta(id) }), 400);
  }

  setInterval(reconcile, TICK);

  // Background tabs clamp timers to 1 s, which would wreck a synchronized
  // start. MessageChannel callbacks are not throttled, so spin on them for
  // the few hundred ms until the start instant.
  const channel = new MessageChannel();
  let startTarget = 0;
  channel.port1.onmessage = () => {
    if (!startTarget) return;
    if (serverNow() >= startTarget) {
      startTarget = 0;
      reconcile();
    } else {
      channel.port2.postMessage(0);
    }
  };
  function startAt(at) {
    const idle = !startTarget;
    startTarget = at;
    if (idle) channel.port2.postMessage(0);
  }

  // ---------- input capture ----------

  function block(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function togglePlay() {
    const pos = video()?.currentTime;
    intent({ kind: target.playing ? 'pause' : 'play', pos });
  }

  addEventListener('click', event => {
    if (!active() || !event.isTrusted) return;
    if (inPath(event, 'ytmusic-player-bar #play-pause-button')) {
      block(event);
      togglePlay();
    } else if (inPath(event, 'ytmusic-player-bar .next-button')) {
      block(event);
      intent({ kind: 'next' });
    } else if (inPath(event, 'ytmusic-player-bar .previous-button')) {
      block(event);
      intent({ kind: 'prev' });
    }
  }, true);

  addEventListener('keydown', event => {
    if (!active() || !event.isTrusted || event.ctrlKey || event.metaKey || event.altKey) return;
    const origin = event.composedPath()[0];
    if (origin instanceof HTMLElement && (origin.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(origin.tagName))) return;
    const { key, shiftKey } = event;
    if (key === ' ' || key === ';') {
      block(event);
      togglePlay();
    } else if (key === 'j' || (shiftKey && key === 'N')) {
      block(event);
      intent({ kind: 'next' });
    } else if (key === 'k' || (shiftKey && key === 'P')) {
      block(event);
      intent({ kind: 'prev' });
    } else if (key === 'l' || (shiftKey && (key === 'ArrowRight' || key === 'ArrowLeft'))) {
      block(event);
      intent({ kind: 'seek', pos: Math.max(0, expectedPos() + (key === 'ArrowLeft' ? -10 : 10)) });
    }
  }, true);

  // Progress bar: YTM seeks live while dragging; `change` fires only for the
  // user's final value, and that becomes the Jam's position.
  addEventListener('pointerdown', event => {
    if (active() && event.isTrusted && inPath(event, 'ytmusic-player-bar #progress-bar')) scrubbing = true;
  }, true);
  addEventListener('pointerup', () => scrubbing && setTimeout(() => { scrubbing = false; }, 400), true);
  addEventListener('change', event => {
    const slider = active() && event.composedPath().find(node => node instanceof Element && node.matches('ytmusic-player-bar #progress-bar'));
    if (!slider) return;
    scrubbing = false;
    // The slider holds the chosen second; the video may not have seeked yet.
    if (Number.isFinite(slider.value)) intent({ kind: 'seek', pos: slider.value });
  }, true);

  // Media keys and OS controls. YTM re-registers handlers constantly, so the
  // registration itself is wrapped.
  const mediaSession = navigator.mediaSession;
  if (mediaSession?.setActionHandler) {
    const original = mediaSession.setActionHandler.bind(mediaSession);
    const routes = {
      play: () => intent({ kind: 'play', pos: video()?.currentTime }),
      pause: () => intent({ kind: 'pause', pos: video()?.currentTime }),
      nexttrack: () => intent({ kind: 'next' }),
      previoustrack: () => intent({ kind: 'prev' }),
      seekto: details => intent({ kind: 'seek', pos: details.seekTime }),
      seekforward: () => intent({ kind: 'seek', pos: expectedPos() + 10 }),
      seekbackward: () => intent({ kind: 'seek', pos: Math.max(0, expectedPos() - 10) })
    };
    mediaSession.setActionHandler = (action, handler) => {
      if (!routes[action] || !handler) return original(action, handler);
      return original(action, details => (active() ? routes[action](details) : handler(details)));
    };
  }

  // Every "play this song" click goes through YTM's shared navigator. Our own
  // loads go through it too, so those are skipped by videoId.
  (function hookNavigator() {
    const navigator = document.querySelector('ytmusic-app')?.inst?.navigator;
    if (!navigator?.navigate) return setTimeout(hookNavigator, 250);
    if (navigator.navigate.__jam) return;
    const original = navigator.navigate;
    navigator.navigate = function (endpoint, ...rest) {
      try {
        const command = endpoint?.toCommand?.() || endpoint;
        const watch = command?.watchEndpoint;
        if (watch && active() && watch.videoId !== loading?.videoId) picked = { videoId: watch.videoId || null, since: Date.now() };
      } catch {}
      return original.call(this, endpoint, ...rest);
    };
    navigator.navigate.__jam = true;
  })();

  // "Add to queue" / "Play next" feed the Jam queue instead of YTM's own.
  addEventListener('click', event => {
    if (!active() || !event.isTrusted) return;
    const item = event.composedPath().find(node => node instanceof Element && node.tagName === 'YTMUSIC-MENU-SERVICE-ITEM-RENDERER');
    const endpoint = item?.data?.serviceEndpoint?.queueAddEndpoint;
    if (!endpoint) return;
    block(event);
    const dropdown = document.querySelector('ytmusic-popup-container tp-yt-iron-dropdown');
    const row = dropdown?.positionTarget?.closest?.('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer, ytmusic-player-queue-item');
    dropdown?.close?.();
    const videoId = endpoint.queueTarget?.videoId;
    if (!videoId) return toast('Only single songs can go in the Jam queue for now.');
    const next = endpoint.queueInsertPosition === 'INSERT_AFTER_CURRENT_VIDEO';
    intent({ kind: 'enqueue', next, song: rowMeta(row, videoId) });
    toast(next ? 'Playing next in your Jam' : 'Added to your Jam queue');
  }, true);

  function rowMeta(row, videoId) {
    const runs = column => row?.data?.flexColumns?.[column]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const text = selector => row?.querySelector(selector)?.textContent?.trim() || '';
    const title = runs(0).map(r => r.text).join('') || text('.title') || text('.song-title');
    const artist = (runs(1)[0]?.text || text('.secondary-flex-columns yt-formatted-string') || text('.byline')).split('•')[0].trim();
    const thumbs = row?.data?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
    const art = thumbs?.at(-1)?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    return { videoId, title, artist, art };
  }

  // ---------- session messages ----------

  document.addEventListener(TO_PAGE, event => {
    const message = JSON.parse(event.detail);
    if (message.type === 'target') {
      const previous = target;
      target = message.play?.videoId ? message.play : null;
      offset = message.offset ?? offset;
      role = message.role;
      if (!target) setRate(1);
      if (target && previous?.v !== target.v) endedFor = null;
      reconcile();
    } else if (message.type === 'native') {
      log('native', message.cmd);
      picked = { videoId: null, since: Date.now() }; // the session asked for this step
      if (message.cmd === 'next') player()?.nextVideo?.();
      else player()?.previousVideo?.();
    } else if (message.type === 'seed') {
      const v = video();
      const id = currentId();
      if (id && !adShowing()) intent({ kind: 'seed', song: songMeta(id), playing: v ? !v.paused : false, pos: v?.currentTime || 0 });
    }
  });

  send({ type: 'hello' });
})();
