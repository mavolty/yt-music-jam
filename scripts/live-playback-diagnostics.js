// Optional read-only capture for the YouTube Music tab's DevTools console.
// Records numeric player states and readiness only. No song metadata, URLs,
// invitations, cookies, account details, or extension storage are accessed.
(async () => {
  const controller = node => node?.polymerController || node?.inst || node;
  const started = Date.now();
  const samples = [];
  for (let index = 0; index < 20; index++) {
    const playerElement = document.querySelector('ytmusic-player');
    const queue = controller(document.querySelector('ytmusic-player-queue'))?.queue;
    const player = queue?.playerApi || controller(playerElement)?.playerApi ||
      controller(document.querySelector('ytmusic-player-bar'))?.playerApi || document.querySelector('#movie_player');
    const sample = { elapsedMs: Date.now() - started, playerAvailable: typeof player?.getPlayerState === 'function' };
    try {
      const items = queue?.getItems?.() || [];
      const selected = items[queue?.getCurrentItemIndex?.()];
      const renderer = selected?.playlistPanelVideoRenderer || selected?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
      const data = player?.getVideoData?.();
      Object.assign(sample, {
        playerState: player?.getPlayerState?.(),
        durationKnown: Number(player?.getDuration?.() || 0) > 0,
        selectedSongMatchesPlayer: !!renderer && renderer.videoId === (data?.video_id || data?.videoId),
        media: [...document.querySelectorAll('video')].map(video => ({
          insideNativePlayer: !!playerElement?.contains(video),
          readyState: video.readyState, paused: video.paused, networkState: video.networkState,
          playbackError: !!video.error,
        })),
      });
    } catch { Object.assign(sample, { nativeReadFailed: true }); }
    samples.push(sample);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.log('YouTube Music Together read-only playback diagnostics\n' + JSON.stringify(samples, null, 2));
  return samples;
})();
