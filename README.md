# YouTube Music Together

A private Chrome extension for two people listening through their own YouTube Music tabs. Use the normal website to choose songs, play/pause, seek, skip, and edit the active queue. The extension coordinates the two players; it does not stream, download, or proxy music.

**Status: working integration prototype, not yet verified with two signed-in Premium accounts.** The public site's native queue/player entry points were inspected on 2026-10-08. Live audio was not available in the fresh inspection browser. The integration smoke runner uses real Chromium extension contexts and a real local Worker, with a simulated native player page. This does not establish reliable compatibility with the signed-in YouTube Music website.

Version **0.1.2** fixes a reproduced play/pause feedback loop in the published 0.1.1 extension. Startup waits for actual playing readiness, paused media with its current frame can resume, and delayed native Pause still cancels a pending start. See [the playback fix and verification record](docs/playback-fix-0.1.2.md).

To update both laptops, end the existing session, extract the new package into the **existing extension folder**, click **Reload** in `chrome://extensions`, and reload both YouTube Music tabs. Check that Chrome shows version **0.1.2**, then create a fresh session and invitation. Replace the existing files rather than loading a second active copy of the extension.

## First-time setup

1. Deploy the relay using [the deployment guide](docs/deployment.md). Deployment requires your Cloudflare account; nothing has been deployed automatically.
2. Build the extension with `npm run build`, or use the generated `artifacts/yt-music-together.zip` archive.
3. On each laptop, unzip the archive if needed. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/extension` (or the extracted archive folder containing `manifest.json`). Pin the extension if you like.
4. Both people open `https://music.youtube.com/` under their own existing Premium account. Reload the tab after installing the extension, and open **Up next**.
5. The creator chooses a song, opens the extension, enters the deployed relay's HTTPS address, and chooses **Create private session**. Allow access to that specific server when Chrome asks.
6. Copy the private invitation and share it with your partner. Your partner chooses **Join your partner** in the extension and pastes the invitation.
7. Check the pairing code on both laptops. The creator chooses **Confirm my partner**. Then use your normal YouTube Music controls.

The creator supplies the starting song and queue. Once paired, both have equal control. Volume, likes, and saved playlists remain personal. Ending the session invalidates the invitation and clears temporary extension session data; it leaves both players paused and independent. It does not promise to restore the queue you had before joining.

## Build and verification

Requires Node.js 22 or newer.

```bash
npm ci --ignore-scripts --cache .cache/npm
npm run check
npm run build
npm run relay:dry-run
npm run smoke
```

No unit tests are included or run, as requested. `check` verifies JavaScript types/syntax and declared permission boundaries. `relay:dry-run` bundles the Cloudflare Worker without deploying. `smoke` starts a temporary local Worker on free ports and runs protocol/browser integration checks; it records results under `artifacts/`.

The smoke runner can use an existing Chromium installation. If it cannot find one, set `CHROMIUM_PATH` to a Chromium executable, or install a browser inside this project:

```bash
PLAYWRIGHT_BROWSERS_PATH=.cache/browsers npm exec --no -- playwright install chromium
```

All tooling caches, temporary browser profiles and smoke relay state are kept under the repository's ignored `.cache/` directory. The installable extension has no runtime npm dependencies; TypeScript, Wrangler and Playwright are development tools only.

## Trust and privacy

- Required page access is limited to `music.youtube.com`. Only the `storage` extension API permission is requested. A generic build requests optional access to your specific relay when you configure it; it does not grant all-sites access.
- For a fixed server build, use `npm run build -- --relay-url https://your-relay.workers.dev`. That package declares only YouTube Music and the exact relay, with no optional wildcard permissions.
- Google passwords, OAuth credentials and cookies are not read or sent to the relay. YouTube Music handles each account and audio stream normally.
- Song/queue/playback messages use authenticated AES-GCM encryption between the extension instances. The key is in the invite's URL fragment, not a server request. The relay still sees connection metadata, message sizes and timing.
- The page adapter receives only native playback/queue commands; invitation keys and relay credentials stay in the extension's isolated background context.
- Only current session state is kept in `chrome.storage.session`; the relay address alone is saved in `chrome.storage.local`. The relay stores expiring authentication/routing state, not listening history or music payloads. Room lifetime is six hours.
- Guest invitations are consumed on first admission and replaced with a private reconnect credential. Two participants are enforced server-side; reconnects can replace only that authenticated participant's own stale connection.
- No analytics, remote executable extension code, playback payload logging, cookie permissions, Google identity permissions, or broad tab-reading permissions.

You can inspect every packaged extension file. This prototype has not had an independent cryptographic audit, and end-to-end encryption does not protect a compromised laptop or maliciously modified extension.

## Practical limits

YouTube Music exposes no documented native queue-control API in the Google documentation we found. The adapter uses observed page controllers and queue reducer interfaces; YouTube can change them. If it cannot load a shared song or read the queue, the session pauses and shows a concrete error rather than replacing the experience with another player.

Initial limit: 1,000 queued songs and bounded encrypted frames. Account-specific uploads, unavailable songs, live broadcasts, ads, casts, offline playback, and region-restricted tracks may not synchronize and need live validation. The synchronization target is roughly 500 ms in stable conditions; that target has not been measured with real Premium audio.

If either player buffers, both pause. Browser offline events close the session transport; missing peer heartbeat pauses playback within roughly eight seconds even when a TCP connection looks alive. Reconnects reconcile the queue/position. If autoplay is blocked, click Play in YouTube Music. The creator coordinates ordering, so their laptop must remain online. Simultaneous additions are merged; conflicting song/playback choices are ordered by the creator's session engine.

A full Chrome restart clears session-only credentials: create a fresh session. If the relay is unreachable, **End session** cannot claim to invalidate the invitation immediately. **Leave this device** clears the local session so you can start again; it does not confirm server closure. Ask your partner to end the old session, or let its six-hour expiry invalidate it. Rejected and expired sessions also offer local leave. Personal playlists are not modified.

Authenticated receive sequence watermarks and retired message epochs are retained in session storage across extension worker reconstruction. A safety pause cancels pending native playback updates. The adapter checks the applied queue, selection, repeat and shuffle before resuming; ignored native writes produce an error and leave playback paused.

Before everyday use, complete [the live two-laptop checklist](docs/live-verification.md).

## Source map

`extension/adapter.js` handles native page controllers; `content.js` bridges sanitized state; `session.js` handles synchronization; `crypto.js` handles invitations/encryption; `background.js` binds a session to one tab; `popup.*` handles session setup. `relay/worker.js` handles expiring two-person room authentication and opaque WebSocket forwarding.

See [the design](docs/design.md), [implementation plan](docs/implementation-plan.md), and [execution record](docs/progress.md). Official Chrome/Cloudflare/YouTube references are linked in the design.
