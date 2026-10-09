# Preserve native playback commands through loading

The user reported that 0.1.2 still paused immediately after Play and restored the previous song after the partner selected another one. A read-only capture showed an unstarted native player with no media loaded. The user also confirmed that normal YouTube Music playback fails after disabling this extension and reloading the tab. That underlying playback failure needs separate diagnosis; the Cloudflare relay forwards encrypted controls and does not deliver music.

## Confirmed local synchronization failures

- When both native duration sources return zero during startup, 0.1.2 drops a delayed Play and fails to resume. The corrected reproduction sets both `player.getDuration()` and `video.duration` to zero; setting just one leaves the fallback active.
- When the native queue selects B before `getVideoData()` changes from A, 0.1.2 emits an invalid full-player state and discards the selection. A readiness message can then restore A. The browser fixture reproduces this with a 2.5-second staged load.
- Retaining only change names allows a later safety-paused snapshot to supply the values for an earlier user command.

## Design and implementation

1. Capture immutable selected-song commands separately from observed native playback. A selected song may have an unknown duration; canonical unknown-duration snapshots stay paused and unready.
2. Send a guest command before its readiness update. Give each command a session epoch and sequence, persist the host's accepted sequence, and prevent older snapshots from replacing an unacknowledged native selection. Safety pauses remain effective during that hold.
3. Scope positive readiness to the canonical video's ID and queue key. Serialize readiness reconciliation with host command commits and incorporate late native duration metadata before publishing a playing snapshot.
4. Record Play/Pause at the trusted native control before its asynchronous handler, without duplicate pointer/keyboard activation. Preserve phased song/queue effects while excluding playback changes caused by an outstanding remote command. Keep generation cancellation and bounded adapter acknowledgement.
   Snapshot fallback never creates a Play/Pause request from a paused flag; a delayed native callback must not override a newer accepted command. Directional media keys emit even when native playback still reports their requested state.
5. Keep periodic heartbeats during startup, but publish the playing timeline only from the host's settled native acknowledgement. Recheck cancellation before publishing that acknowledgement, so a later Pause wins. Enforce local pause while the session is offline or unpaired, including delayed native handlers.

## Validation and live limits

Validation uses the real extension, two isolated Chromium contexts, and a real local Worker with a simulated native player. No unit tests are run. Coverage includes missing startup duration, delayed native control transitions, paused/playing selections from both roles, late song metadata, phased selection followed by Play, and local actions during remote startup. Existing queue merging, buffering, disconnect, tab/worker recovery, replay, expiry, and end-session checks remain required.

Final verification on 2026-10-09 passed all 30 browser/relay integration checks, static checks, Worker bundle dry-run, patch check and exact-relay archive/source comparison. The installable archive is `artifacts/yt-music-together-0.1.3.zip`; the detailed report is `artifacts/smoke-report-0.1.3.json`. Archive SHA-256: `b2463add6d93bb2b1f6ef2869831e922bf94bfee1a1d4ff733c05ec47cbdb17b`.

Signed-in Premium audio has not been verified in this environment. First establish normal playback in the user's browser without Music Together, using a clean Guest window to distinguish the normal profile from broader playback problems. Google documents extension/profile isolation in its [Chrome playback troubleshooting](https://support.google.com/chrome/answer/6138475?hl=en) and connection/account checks in [YouTube Music troubleshooting](https://support.google.com/youtubemusic/answer/9027741?hl=en). Do not infer that unrelated wallet warnings or failed analytics requests caused the music failure.

Disabling the extension does not establish what caused an existing native queue to become stuck: previously applied queue changes may survive in the page's saved state. In the clean window, choose a fresh song from search rather than relying on the old queue. Do not delete cookies, reset Chrome, or change Cloudflare to run this control check.

Both participants must install the same 0.1.3 package and reload the extension and their YouTube Music tabs before creating a fresh session. This changes the encrypted client messages, not the relay's opaque forwarding behavior. No Cloudflare settings change is needed. The external public download is not updated by a local build.
