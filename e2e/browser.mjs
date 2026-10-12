// Launches a Chromium profile with the extension loaded and exposes helpers
// to drive YouTube Music and the Jam session from tests.
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTENSION = resolve(import.meta.dirname, '../extension');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export async function launch(label) {
  const dir = await mkdtemp(join(tmpdir(), `ytm-jam-${label}-`));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 860 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio'
    ]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // Logged-out test profiles get ads; strip them so the run behaves like Premium.
  await context.route('**/youtubei/v1/player?*', async route => {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (!body) return route.fulfill({ response });
    for (const key of ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams']) delete body[key];
    await route.fulfill({ response, json: body });
  });
  const page = context.pages()[0] || await context.newPage();
  page.on('console', msg => {
    if (msg.text().startsWith('[jam]') || process.env.VERBOSE) console.log(`  ${label} console:`, msg.text());
  });
  page.on('pageerror', err => console.log(`  ${label} pageerror:`, err.message));
  return { label, context, worker, page };
}

// Opens the real extension popup in a tab, the way a user would.
export async function openPopup(b) {
  const id = new URL(b.worker.url()).host;
  const popup = await b.context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  return popup;
}
