# YouTube Music Together Implementation Plan

> For agentic workers: use superpowers:executing-plans. The user's instruction to continue autonomously and omit unit tests overrides skill approval gates and unit-test requirements.

**Goal:** Synchronize two existing Chrome YouTube Music tabs, including their native playback and active queues, in a private online session.

**Architecture:** A narrow Chrome MV3 extension observes native page state and controls the existing player. An authenticated Cloudflare Durable Object relays end-to-end encrypted messages. The creator orders changes while either person controls playback; connectivity loss pauses both.

**Tech stack:** JavaScript ES modules, Web Crypto, Chrome extension APIs, Cloudflare Workers/Durable Objects; development-only TypeScript, Wrangler and Playwright.

**Spec:** `docs/design.md`, copied from the approved workspace design.

## Global constraints

- Chrome laptops, each streaming through their own YouTube Music account.
- Normal native song selection and queue controls; no separate queue or pasted song links.
- No Google credential access, analytics, persisted listening history, or remote executable code.
- Two participants; fresh invites; end-session cleanup; equal control; pause both on loss/buffering.
- No unit tests. Use static checks, build verification and browser/protocol integration smoke checks.
- All project files, build tools and caches stay inside this repository. Do not deploy or change external resources without user input.

## Review focus

Native queue APIs may change; visibly stop on an unsupported adapter rather than silently diverge. Simultaneous commands must converge. Worker restart, laptop sleep and transport loss must pause/reconcile. Stolen/replayed invitations must not permit a third participant. Encrypted payloads and credentials must not appear in logs or persistent history.

## Task 1: Native page adapter and inspectable packaging

- [x] Create `extension/adapter.js` in MAIN world and a narrow content bridge in isolated world. Snapshot only song IDs, displayed metadata, active queue and playback state.
- [x] Prove current native object/method names against the public live page where accessible. Keep unsupported states explicit.
- [x] Observe user changes and apply playback/queue state while suppressing reflected events. Volume, saved playlists and likes remain local.
- [x] Create a packaged Chrome manifest and static-check/build pipeline; dependency/cache artifacts remain local.

## Task 2: Private relay and encryption

- [x] Create `relay/worker.js`: provision rooms, require participant credentials in the first WebSocket message, enforce pair membership, relay bounded opaque messages, expire/end rooms and clean storage.
- [x] Create `extension/crypto.js`: random room/key material, AES-GCM authenticated message encryption, invitation parsing and replay checks.
- [x] Verify relay using real local WebSocket connections; reject invalid credentials, third participants and stale invites.

## Task 3: Session engine and native integration

- [x] Create `extension/session.js` and `background.js`: session-only state, browser restart/reconnect handling, creator ordering, peer clock offsets, buffering safety, drift correction, invite copy, end/leave lifecycle.
- [x] Create the create/join/status popup; no replacement music controls.
- [x] Browser smoke verification with two extension contexts and native-page fixtures; report live signed-in limitations separately.

## Task 4: Review and handoff

- [ ] Run static checks, build/dry-run and browser/protocol integration smoke verification. No unit tests.
- [ ] Fresh code review of privacy, native adapter assumptions and convergence; fix material findings and rerun affected checks.
- [ ] Write README and installation/deployment/live verification guide; provide installable archive and honest validation status.

