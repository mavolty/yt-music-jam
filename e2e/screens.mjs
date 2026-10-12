// Screenshots of the popup and in-page panel during a live Jam.
import { launch, openPopup } from './browser.mjs';
const out = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [A, B] = await Promise.all([launch('A'), launch('B')]);
for (const b of [A, B]) await b.worker.evaluate(relay => chrome.storage.local.set({ relay }), 'http://127.0.0.1:8797');
await Promise.all([A.page.goto('https://music.youtube.com/'), B.page.goto('https://music.youtube.com/')]);
await A.page.waitForSelector('ytmusic-app');
await A.page.evaluate(() => document.body.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint: { watchEndpoint: { videoId: 'dQw4w9WgXcQ' } } } })));
await sleep(5000);
const pa = await openPopup(A);
await pa.setViewportSize({ width: 320, height: 520 });
await pa.screenshot({ path: `${out}/popup-idle.png` });
await pa.fill('#name', 'Ruth'); await pa.click('#start'); await pa.waitForSelector('#bigcode span');
const code = (await pa.locator('#bigcode').innerText()).replace(/\s/g, '');
await pa.screenshot({ path: `${out}/popup-waiting.png` });
const pb = await openPopup(B); await pb.fill('#name', 'Sari'); await pb.fill('#code', code); await pb.click('#join button');
await sleep(6000);
await pa.screenshot({ path: `${out}/popup-live.png` });
// Guest queues two songs from search.
for (const q of ['a-ha take on me', 'abba gimme gimme gimme']) {
  await B.page.evaluate(q => document.body.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint: { searchEndpoint: { query: q, params: 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D' } } } })), q);
  const row = B.page.locator('ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer').first();
  await row.waitFor(); await sleep(800); await row.hover();
  await row.locator('ytmusic-menu-renderer').last().locator('yt-button-shape button, button').last().click();
  await B.page.locator('ytmusic-popup-container tp-yt-iron-dropdown ytmusic-menu-popup-renderer #items > *', { hasText: 'Add to queue' }).first().click();
  await sleep(1200);
}
await B.page.screenshot({ path: `${out}/guest-toast.png` });
await A.page.bringToFront();
await A.page.evaluate(() => document.querySelector('#ytm-jam-root').shadowRoot.querySelector('.pill').click());
await sleep(800);
await A.page.screenshot({ path: `${out}/host-panel.png` });
await Promise.all([A.context.close(), B.context.close()]);
