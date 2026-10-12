# YT Music Jam

Listen to YouTube Music together, in sync, like Spotify Jam. Both people use desktop Chrome on music.youtube.com with their own Premium account.

- One person starts a Jam and shares a 6 character code. The other types it in.
- Both control everything: play, pause, seek, next, previous, picking a song.
- "Add to queue" and "Play next" put songs in a shared Jam queue, showing who added them.
- When the queue is empty, the host's autoplay picks the next song.
- When the host ends the Jam or is gone for 30 s, the Jam ends for everyone.

## How it works

```
music.youtube.com tab                         Cloudflare
┌──────────────────────────┐   port   ┌──────────────┐  wss  ┌─────────────────────┐
│ page.js (main world)     │◄───────► │ background.js│◄────► │ relay/worker.js     │
│  drives YTM's player     │ content  │  Jam session │       │ Durable Object/room │
│ content.js (isolated)    │   .js    │  clock, crypto│      │ forwards, clock ping│
│  bridge + Jam panel      │          └──────────────┘       └─────────────────────┘
└──────────────────────────┘
```

- **No echo loops.** User intent is read only from input: player bar buttons, keyboard shortcuts, media keys, the progress bar, YTM's song navigator and the queue menus. A change applied from your partner never produces an intent, so it can't bounce back.
- **Shared state merges without a leader.** Playback is last-writer-wins on `(version, peer)`. Queue items are add-only with removals kept as tombstones. Every change sends the whole state, so late or duplicate messages are harmless. This is what fixes "next goes back".
- **Sync.** Both browsers measure their offset to the relay clock. Every playback change carries the server time it takes effect, and starts wait for that moment. Small drift is corrected by nudging playback speed up to ±5%, with pitch preserved. Gaps over 200 ms trigger a seek, and the extension learns how far ahead to seek on your machine.
- **End to end encrypted.** AES-GCM with a key derived from the code. The relay only sees ciphertext.

## Set up

1. Deploy the relay once. You need a Cloudflare API token made from the "Edit Cloudflare Workers" template.
   ```sh
   npm install
   CLOUDFLARE_API_TOKEN=... npm run deploy
   ```
2. Put the printed `https://….workers.dev` URL in `extension/config.js`.
3. On both laptops, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick the `extension` folder. Or run `npm run pack` and share `yt-music-jam.zip`.

## Use

1. Open music.youtube.com and play something.
2. Click the extension, type your name and click **Start a Jam**. Send the code to your partner.
3. Your partner opens music.youtube.com, clicks the extension, types their name and the code, then clicks **Join**.
4. The panel at the bottom left shows who you're jamming with and the shared queue.

## Test

The tests are end to end only: two Chromium profiles with the extension, a local relay and the real YouTube Music.

```sh
npm run relay        # local relay on :8797, in another terminal
npm run e2e          # TRACE=1 prints drift traces, HEADED=1 shows the browsers
node e2e/screens.mjs <dir>   # screenshots of the popup and panel
```

The test profiles are logged out, so the tests strip ads from player responses to behave like Premium. On a datacenter IP, YouTube's bot check may let only one video stream. Song changes are still checked by videoId.

## Known limits

- Desktop Chrome only. The YouTube Music mobile app can't run extensions.
- Only single songs can go in the Jam queue, not albums or playlists.
- Sync is measured at the player. Bluetooth headphones add their own delay (often 100–250 ms), so if one of you uses wired and the other Bluetooth, you may hear an offset.
