# Playback correction in 0.1.2

2026-10-09: The user reported repeated play/pause and inability to play songs in the published 0.1.1 extension. The exact public extension archive was downloaded from the user's existing relay, without opening or consuming the private invitation. Only its playback source was used as the debugging baseline; the relay and the live session were not modified.

## Reproduction and cause

The previous native-player fixture started Play synchronously and never buffered on resume. With the real 0.1.1 extension code and a simulated 900 ms startup buffering delay, one participant received 15 Play and 58 Pause calls and never settled into playback. Intermediate readiness updates interrupted the command that was still starting; the next readiness change retried it, causing the loop.

Paused media was also required to have future data before it could resume, although the Play command may be needed to fetch/decode that data. Separately, native Play can return before player state changes. Counting a paused, resume-eligible player as a successful startup acknowledges the command too early and recreates the feedback loop.

## Correction

- Paused/cued media with its current frame is eligible for a resume attempt. Successful startup requires actual ready, unpaused, non-buffering playback.
- Outstanding native applications use a counter. Intermediate polling cannot publish a readiness failure that interrupts their own startup; final acknowledgements publish the settled readiness.
- Play is sent only when the native player is neither already playing nor buffering. Startup waits at most five seconds within a twelve-second total application deadline; unfinished startup produces a visible error and pauses the session.
- A recent trusted gesture can produce a delayed native Pause intent observed by polling. Matching song, queue and remote-command version prevents reflected safety pauses from becoming user intent. Pause and disconnect still invalidate pending playback through generation cancellation.
- The 0.1.1 improvements for a buffering Play request and one-click recovery from a blocked player are preserved.

## Verification and limits

The real-browser/local-Worker integration now includes a 650 ms delay before native Play changes state, 900 ms startup buffering, paused media exposing only current-frame data, a 350 ms delayed native Pause during startup, an unfinished startup and a native Play retry. Existing queue, seek, buffering, disconnect, tab/worker recovery, replay and room-expiry checks remain covered. A fresh read-only review identified the asynchronous acknowledgement/Pause gaps; both were corrected and reviewed again without further blocking findings.

No unit tests are run, as requested. The native player is simulated in these integration checks; signed-in Premium playback and the user's exact account/browser behavior still require live verification. This package uses the existing relay protocol and needs no relay logic change.

Final verification passed all 23 browser/relay integration checks, JavaScript type/syntax and permission checks, the release build, and archive/source consistency checks. `artifacts/yt-music-together-0.1.2.zip` is configured for the user's existing relay and grants only YouTube Music and that exact server.

## Install

On both laptops, end the old session, extract the 0.1.2 ZIP into the existing unpacked extension folder, reload the extension in `chrome://extensions`, and reload YouTube Music. Verify the displayed version is 0.1.2 and create a fresh invitation. The private invitation supplied in the bug report is not included in source, logs, or the package.

The public relay's download was not changed by this local fix. Updating that external deployment requires the user's authorization and the current deployment source/account access; redeploying this repository's older relay would overwrite the newer landing page/download, so it must not be used as an incidental publishing step.
