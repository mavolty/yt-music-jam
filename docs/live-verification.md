# Live two-laptop verification

This is the remaining acceptance check. Fixture smoke checks cannot establish real YouTube Music queue compatibility, audio timing, autoplay behavior, or Premium benefits. Neither person's Google credentials should be shared to perform this checklist.

## Start

- Install the same extension package on both laptops and reload YouTube Music.
- Each person remains signed into their own Premium account.
- Open Up next on both. Choose an ordinary available song and a short queue on the creator's tab.
- Use the extension's **Check connection to YouTube Music** action. It should report native player connected, the queue length, and ready.
- Create, copy invite, join, compare pairing codes, confirm partner. The second queue should become the creator's active queue.

## Native controls

- From each laptop, pause/resume, seek within the current song, select another queued song, and choose a song from search.
- Add songs through the ordinary YouTube Music menu, remove a queued song, and drag a song to reorder it from either laptop.
- Add a song on both laptops at nearly the same time; both additions should remain in the same order on both queues.
- Start a different playlist, exercise shuffle and repeat, and let a radio queue grow. Confirm the native queue and selected track remain aligned.
- Change volume and like a song on one laptop. These should remain local. Inspect saved playlists to confirm no saved-library edits.

## Recovery and timing

- Interrupt one laptop's internet connection. Both players should pause; reconnect and confirm queue/position reconciliation.
- Cause one player to buffer. Both should pause and resume after both are ready.
- Reload each YouTube Music tab separately. The session should recover its active queue without treating the default page queue as a new selection.
- Put the creator's laptop to sleep. The other player should pause after losing peer heartbeat. Wake and reconnect.
- If autoplay is blocked, click the native Play button and confirm both resume.
- On version 0.1.2, resume after a pause or song load and confirm playback settles rather than repeatedly toggling. Press native Pause while playback is starting; both players should stay paused. A startup that cannot finish should show a loading error rather than continually retry; after loading recovers, one native Play click should retry it.
- Listen for at least ten minutes, including song boundaries. Compare positions periodically; target stable offset within roughly 500 ms with no repeated corrective seeks. This does not promise sample-perfect alignment or gapless simultaneous transitions.

## Privacy and ending

- Confirm the installed extension grants only YouTube Music and the configured relay, with `storage` as its sole named API permission.
- A third browser should not join an occupied room, and the original guest invitation should not be reusable after admission.
- End the session from either laptop. Both players should pause, both extension sessions should clear, and the old invitation should no longer work.
- Try a consumed invitation. Confirm the rejection is visible, choose **Leave this device**, then join a fresh invitation. Local leave must explain that server closure was not confirmed.
- Disconnect while a new song is loading. Wait for the song to finish loading while still offline: neither player should resume until reconnect/reconciliation.
- Review relay logging settings without copying any invitation or credentials into diagnostics. The adapter never exports page cookies or Google tokens.

Record results with browser versions and the operation that fails, not private invitations or account credentials. If native queue control fails, keep the error visible and report that interface failure; do not call the app ready for everyday use.
