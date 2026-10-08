# Deploy the private relay

The extension needs a publicly reachable HTTPS relay so two laptops on different networks can connect. The code is prepared for Cloudflare Workers with a SQLite-backed Durable Object. This repository has not deployed any resources.

## Prepare and review

```bash
npm ci --ignore-scripts --cache .cache/npm
npm run check
npm run relay:dry-run
```

Review `wrangler.jsonc`: worker name `yt-music-together-relay`, binding `ROOMS`, class `MusicRoom`, migration `v1`, observability disabled. Choose a unique worker name if your account already has one with that name. Do not overwrite an existing unrelated worker.

Workers Free currently supports SQLite-backed Durable Objects with usage limits. Check [current pricing and quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/) for your account before deployment; this is not a promise of zero cost.

## Authenticate and deploy when authorized

These commands change Cloudflare account resources and require the account owner's authorization. The wrapper disables tooling metrics and places Wrangler configuration/cache inside this repository's ignored `.cache/` directory.

```bash
node scripts/wrangler.mjs login
node scripts/wrangler.mjs whoami
node scripts/wrangler.mjs deploy
```

Use the HTTPS `workers.dev` URL Wrangler returns. Both extension instances must use the same relay URL. `/health` should return `{"ok":true,"protocol":1}`. Never paste Cloudflare tokens into the extension or send Google credentials to the relay.

If your environment uses an API token, provide it through your existing secure environment configuration; do not commit it. The token must authorize Workers deployment and the Durable Object migration in the intended account. Multiple available accounts require choosing the intended account explicitly before deployment.

## Package for that exact server

```bash
npm run build -- --relay-url https://your-relay.your-subdomain.workers.dev
```

This produces `dist/extension` and `artifacts/yt-music-together.zip`. The fixed server package declares access to that server and YouTube Music only, and pre-fills the server address. Distribute the same archive to both laptops. Keep the archive separate from private invitations: no account/session credentials are packaged.

For later relay updates, inspect the dry-run output and verify the target account/worker name first. The initial migration creates a new Durable Object class; don't remove deployed class migrations or delete rooms/resources as an incidental update.

## Local development

```bash
npm run dev -- --port 8791 --inspector-port 9231
```

Choose unused ports; do not stop other workspace processes to make space. Build with `--relay-url http://127.0.0.1:8791` for a local permission scope. A loopback URL is suitable only for local development; it cannot connect a partner on another laptop. `npm run smoke` chooses free ports and uses its own temporary state.

## Operational boundaries

Rooms expire after six hours. Persisted Durable Object records contain only room authentication/admission/expiry metadata, including hashed tokens and participant IDs. No encrypted music frames are stored. Encrypted WebSocket data is forwarded as it arrives, and reconnecting browsers supply the current state.

The relay does not log application credentials or playback messages, and configured Worker observability is disabled. Cloudflare can still process standard network metadata. Hosting a publicly reachable service can consume platform quota; if you plan to open this beyond the two of you, add account-level abuse controls and review scaling before doing so.
