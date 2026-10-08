# YouTube Music Together — proposed design

Date: 2026-10-08
Status: Requirements confirmed in conversation; proposed architecture awaiting final shared-understanding confirmation. No implementation or live player verification yet.

## Purpose and agreed behavior

Two people with their own YouTube Music Premium accounts listen together online from Chrome on separate laptops. Each continues using the normal YouTube Music website. A separate music player or an extension queue requiring pasted links would not satisfy the request.

- Either participant can select songs, play, pause, seek, skip, and add, remove, or reorder upcoming songs through the native YouTube Music interface.
- The creator supplies the initial song and upcoming queue. Once joined, both have equal control.
- Playback and the active queue synchronize; volume, likes, and saved playlists stay personal. Playing a playlist changes the shared listening queue, without editing either person's saved playlist.
- Buffering or disconnection pauses both players. Reconnection must reconcile the song, queue, and position before resuming. If browser autoplay blocks playback, show an explicit local resume action.
- Each room admits two participants through a fresh private invitation. End session invalidates the invite and clears transient shared state. After ending, each native player returns to independent control; restoring the pre-session queue is not promised.
- Install the initial extension through Chrome Developer Mode / Load unpacked.

## Selected approach and alternatives

Use a private Manifest V3 Chrome extension plus a small managed WebSocket relay on Cloudflare Workers / Durable Objects. The user delegated the hosting choice. Each existing YouTube Music tab streams its own audio using its own account; the relay carries synchronization messages, not music.

A self-hosted WebSocket relay is feasible but adds server maintenance. An embedded YouTube player would replace the normal YouTube Music experience and does not establish equivalent Music Premium behavior, so it does not meet the agreed interaction requirement.

## Components and data flow

1. A page adapter observes and operates the native playback controls and active queue. Scope page access to `https://music.youtube.com/*`. Prove its capabilities against the live site before depending on them.
2. A synchronization engine turns deliberate native actions into commands, prevents reflected updates from becoming new commands, applies ordered state, and corrects playback drift.
3. The room creator's browser coordinates command ordering during the session. Both users can issue commands; coordination grants no extra user-facing control rights. If the coordinator disconnects, pause and wait for reconnection rather than allow conflicting independent queues.
4. The relay authenticates room participation, enforces the two-person limit, and forwards encrypted messages. A small extension interface handles create/join/end and connection status; everyday music controls remain in YouTube Music.

Use WebSocket reconnects, fresh state snapshots, and Chrome service-worker lifecycle handling. Laptop sleep, stale commands, duplicate messages, and differing local queues must not silently split the session.

## Privacy and trust requirements

- Collect no Google passwords, OAuth credentials, or session cookies; request no cookie or Google identity permissions.
- Package extension logic locally; use reviewed minimal dependencies and no remotely downloaded executable extension code.
- Encrypt song and playback payloads between the two browsers using standard authenticated encryption. Keep invitation key material out of relay requests and logs; bind pairing to room credentials and confirm the second participant before accepting commands.
- Hosting can still see connection metadata. End-to-end encryption does not make a compromised extension or participant device safe.
- Keep no accumulated listening history or analytics. Only minimal temporary room authentication and routing state may be kept server-side, with expiration and cleanup.
- Specify how transient routing state survives Durable Object hibernation; do not assume ordinary in-memory state persists.
- Validate message schemas, sizes, freshness, room membership, and rate. Origin checks supplement authentication.

## First milestone: native-site feasibility

Google's public documentation does not establish a supported YouTube Music native queue-control API. DOM interaction is plausible, but no live adapter has been verified.

Test on real signed-in Chrome tabs: observe and reproduce play/pause/seek; identify and select songs; read the upcoming queue; mirror add/remove/reorder and playlist replacement; observe dynamic queue growth and playback-affecting shuffle/repeat. Detect missing controls and unsupported queue states visibly. Do not report simulated DOM tests as proof of actual YouTube Music compatibility.

If native queue behavior cannot be reproduced reliably, report the exact limitation. Do not silently replace it with link-pasting, separate playback, or a separate shared-queue interface.

## Validation and completion criteria

The proposed synchronization target is generally within 500 ms during stable playback, measured across the two laptops; this is a target, not an established guarantee. Verify both directions of control, simultaneous actions, song boundaries, playlist replacement, queue mutations, buffering, refresh, reconnect, and laptop sleep. A ten-minute listening run should remain on the same song without repeated corrective seeks.

Verify no feedback loops or unintended saved-library edits. Test invite invalidation, rejection of a third participant, message replay/malformed input, state cleanup, and absence of listening payloads or secrets in relay logs. Inspect extension permissions and dependency inventory.

Completion requires live two-person Chrome verification, installation instructions, managed relay configuration/deployment instructions, and a clear report of any unsupported native behavior. Browser automation with fixtures can test the protocol but cannot substitute for that live verification. Deployment additionally requires access to the chosen hosting account.

## Primary resources

- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome extension permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Chrome local extension installation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Chrome service-worker WebSockets](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Durable Objects pricing and limits](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Google YouTube Data API reference](https://developers.google.com/youtube/v3/docs/)
- [YouTube IFrame API scope](https://developers.google.com/youtube/iframe_api_reference)
