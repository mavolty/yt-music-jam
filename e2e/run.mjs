// End-to-end: two Chromium profiles with the extension, a local relay, real
// YouTube Music. Run `npm run relay` first (or set RELAY to a deployed one).
//
// This server only gets one playable video past YouTube's bot check, so
// playback timing is measured on SONG; later song changes check that both
// sides land on (and stay on) the same videoId even if it will not stream.
import { launch, openPopup } from './browser.mjs';

const RELAY = process.env.RELAY || 'http://127.0.0.1:8797';
const SONG = 'dQw4w9WgXcQ';
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const probe = b => b.page.evaluate(() => {
  const p = document.querySelector('#movie_player');
  const v = p?.querySelector('video');
  return {
    id: p?.getVideoData?.()?.video_id || null,
    t: v?.currentTime ?? null,
    paused: v ? v.paused : null,
    rate: v?.playbackRate,
    now: performance.timeOrigin + performance.now(),
    ad: Boolean(p?.classList.contains('ad-showing')),
    state: p?.getPlayerState?.()
  };
});

async function until(fn, timeout = 15000, every = 100) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return false;
}

// The test profiles are logged out, so YouTube shows ads; Premium has none.
const skipAd = b => b.page.evaluate(() => {
  const button = [...document.querySelectorAll('#movie_player button')].find(el => /^skip/i.test(el.innerText.trim()));
  button?.click();
});
const noAds = b => until(async () => {
  const s = await probe(b);
  if (s.ad) await skipAd(b);
  return !s.ad && s.t > 0.5 && s;
}, 90000, 500);

async function drift(a, b, samples = 30, gap = 200) {
  const diffs = [];
  for (let i = 0; i < samples; i++) {
    const [x, y] = await Promise.all([probe(a), probe(b)]);
    // Project B's position to the instant A was sampled.
    if (!x.ad && !y.ad && x.id === y.id && !x.paused && !y.paused) diffs.push(Math.abs(x.t - (y.t + (x.now - y.now) / 1000 * y.rate)) * 1000);
    await sleep(gap);
  }
  if (process.env.VERBOSE) console.log('   drift samples', diffs.map(Math.round).join(' '));
  diffs.sort((p, q) => p - q);
  return { n: diffs.length, median: Math.round(diffs[diffs.length >> 1] ?? NaN), max: Math.round(diffs.at(-1) ?? NaN) };
}

// Records every play/pause flip so a feedback loop shows up as a count.
const watchFlips = b => b.page.evaluate(() => {
  window.__flips = 0;
  const v = document.querySelector('#movie_player video');
  for (const type of ['play', 'pause']) v.addEventListener(type, () => window.__flips++);
});
const flips = b => b.page.evaluate(() => window.__flips);

async function main() {
  const [A, B] = await Promise.all([launch('A'), launch('B')]);
  for (const b of [A, B]) await b.worker.evaluate(relay => chrome.storage.local.set({ relay }), RELAY);

  try {
    // A is already listening when the Jam starts.
    await Promise.all([A.page.goto('https://music.youtube.com/'), B.page.goto('https://music.youtube.com/')]);
    await A.page.waitForSelector('ytmusic-app');
    await A.page.evaluate(id => document.body.dispatchEvent(new CustomEvent('yt-navigate', {
      bubbles: true, composed: true, detail: { endpoint: { watchEndpoint: { videoId: id } } }
    })), SONG);
    check('A plays the song on its own', Boolean(await noAds(A)));

    const popA = await openPopup(A);
    await popA.fill('#name', 'Ruth');
    await popA.click('#start');
    await popA.waitForSelector('#bigcode span');
    const code = (await popA.locator('#bigcode').innerText()).replace(/\s/g, '');
    check('host gets a 6 character code', /^[A-Z0-9]{6}$/.test(code), code);

    const popB = await openPopup(B);
    await popB.fill('#name', 'Sari');
    await popB.fill('#code', code);
    await popB.click('#join button');
    const caption = await until(async () => { const t = await popB.locator('#caption').innerText(); return t.includes('Ruth') && t; });
    check('guest popup shows the host', Boolean(caption), caption || '');
    const hostCaption = await until(async () => { const t = await popA.locator('#caption').innerText(); return t.includes('Sari') && t; });
    check('host popup shows the guest', Boolean(hostCaption), hostCaption || '');

    const joined = await until(async () => (await probe(B)).id === SONG, 20000);
    check('guest loads the host song', Boolean(joined));
    await noAds(B);
    await sleep(5000);
    let d = await drift(A, B);
    check('in sync after join (median < 50 ms)', d.median < 50, `median ${d.median} ms, max ${d.max} ms, n=${d.n}`);

    // Pause from the guest; nothing may flap afterwards.
    await Promise.all([watchFlips(A), watchFlips(B)]);
    await B.page.evaluate(() => addEventListener('pointerup', () => { window.__clickAt = performance.timeOrigin + performance.now(); }, true));
    await A.page.evaluate(() => document.querySelector('#movie_player video').addEventListener('pause', () => { window.__pauseAt = performance.timeOrigin + performance.now(); }, { once: true }));
    await B.page.click('ytmusic-player-bar #play-pause-button');
    const paused = await until(async () => (await probe(A)).paused, 3000, 10);
    const latency = Math.round(await A.page.evaluate(() => window.__pauseAt) - await B.page.evaluate(() => window.__clickAt));
    check('guest pause reaches host fast (< 300 ms)', Boolean(paused) && latency < 300, `${latency} ms click to pause`);
    await sleep(3000);
    const [sa, sb, fa, fb] = await Promise.all([probe(A), probe(B), flips(A), flips(B)]);
    check('both stay paused, no play/stop loop', sa.paused && sb.paused && fa <= 2 && fb <= 2, `flips A=${fa} B=${fb}`);
    check('paused at the same spot', Math.abs(sa.t - sb.t) < 0.3, `${Math.round(Math.abs(sa.t - sb.t) * 1000)} ms apart`);

    // Resume from the host with the keyboard.
    await A.page.locator('body').press(' ');
    const resumed = await until(async () => !(await probe(B)).paused, 3000, 10);
    check('host space resumes the guest', Boolean(resumed));
    for (let i = 0; process.env.TRACE && i < 60; i++) {
      const [x, y] = await Promise.all([probe(A), probe(B)]);
      const [da, db] = await Promise.all([A.page.evaluate(() => window.__jamDebug), B.page.evaluate(() => window.__jamDebug)]);
      console.log('   trace', Math.round(da.smoothed * 1000), Math.round(db.smoothed * 1000), 'off', da.offset.toFixed(1), db.offset.toFixed(1), 'lead', da.seekLead.toFixed(2), db.seekLead.toFixed(2), '|', Math.round((x.t - (y.t + (x.now - y.now) / 1000 * y.rate)) * 1000), 'ms', x.rate.toFixed(3), y.rate.toFixed(3), x.state, y.state);
      await sleep(200);
    }
    await sleep(5000);
    d = await drift(A, B, 20);
    check('in sync after resume (median < 50 ms)', d.median < 50, `median ${d.median} ms, max ${d.max} ms`);

    // Seek +10 s from the guest's keyboard.
    const before = (await probe(A)).t;
    await B.page.locator('body').press('Shift+ArrowRight');
    const jumped = await until(async () => (await probe(A)).t > before + 8, 4000, 20);
    check('guest seek moves the host', Boolean(jumped));
    await sleep(5000);
    d = await drift(A, B, 20);
    check('in sync after seek (median < 50 ms)', d.median < 50, `median ${d.median} ms, max ${d.max} ms`);

    // Click the progress bar on the host.
    const bar = await A.page.locator('ytmusic-player-bar #progress-bar').boundingBox();
    const aim = (await probe(A)).t < 100 ? 0.75 : 0.25; // always a big jump
    await A.page.mouse.click(bar.x + bar.width * aim, bar.y + bar.height / 2);
    await sleep(5000);
    const [pa, pb] = await Promise.all([probe(A), probe(B)]);
    const want = 213 * aim;
    check('progress bar seek moves both', Math.abs(pa.t - want) < 15 && Math.abs(pb.t - want) < 15, `aimed ~${want.toFixed(0)} s, A ${pa.t.toFixed(2)} s, B ${pb.t.toFixed(2)} s`);
    d = await drift(A, B, 20);
    check('in sync after progress bar seek (median < 50 ms)', d.median < 50, `median ${d.median} ms, max ${d.max} ms`);

    // Queue: guest adds a song from the Up next list with "Add to queue".
    const queued = await addToQueueFromUpNext(B);
    check('guest can use "Add to queue"', Boolean(queued), queued || '');
    const hostSees = await until(() => A.page.evaluate(() =>
      document.querySelector('#ytm-jam-root')?.shadowRoot.querySelectorAll('.queue li').length), 5000);
    check('host panel shows the queued song', hostSees === 1, `items ${hostSees}`);

    // Next on the host plays the queued song for both, and it sticks.
    await A.page.click('ytmusic-player-bar .next-button');
    const moved = await until(async () => {
      const [x, y] = await Promise.all([probe(A), probe(B)]);
      return x.id === queued && y.id === queued;
    }, 10000);
    check('next plays the queued song on both', Boolean(moved));
    await sleep(5000);
    const [na, nb] = await Promise.all([probe(A), probe(B)]);
    check('next does not bounce back', na.id === queued && nb.id === queued, `A ${na.id}, B ${nb.id}`);
    const left = await A.page.evaluate(() => document.querySelector('#ytm-jam-root')?.shadowRoot.querySelectorAll('.queue li').length);
    check('queue is empty after playing it', left === 0);

    // Guest picks a song directly: both switch.
    const picked = await clickUpNextRow(B, 0);
    const both = await until(async () => {
      const [x, y] = await Promise.all([probe(A), probe(B)]);
      return x.id === picked && y.id === picked;
    }, 10000);
    check('guest song click switches both', Boolean(both), picked || '');
    await sleep(4000);
    const [ca, cb] = await Promise.all([probe(A), probe(B)]);
    check('song click sticks on both', ca.id === picked && cb.id === picked, `A ${ca.id}, B ${cb.id}`);

    // Back to the playable song for a last timing check via the queue panel "play now".
    await B.page.evaluate(id => document.body.dispatchEvent(new CustomEvent('yt-navigate', {
      bubbles: true, composed: true, detail: { endpoint: { watchEndpoint: { videoId: id } } }
    })), SONG);
    await until(async () => (await probe(A)).id === SONG, 10000);
    await Promise.all([noAds(A), noAds(B)]);
    await sleep(4000);
    d = await drift(A, B, 30);
    check('in sync after switching songs (median < 50 ms)', d.median < 50, `median ${d.median} ms, max ${d.max} ms`);

    // Song end: both move on to the same next song, chosen by the host.
    const bar2 = await B.page.locator('ytmusic-player-bar #progress-bar').boundingBox();
    await B.page.mouse.click(bar2.x + bar2.width * 0.985, bar2.y + bar2.height / 2);
    const advanced = await until(async () => {
      const [x, y] = await Promise.all([probe(A), probe(B)]);
      return x.id !== SONG && x.id === y.id && x.id;
    }, 20000);
    check('at song end both advance to the same next song', Boolean(advanced), advanced || '');
    await sleep(4000);
    const [ea, eb] = await Promise.all([probe(A), probe(B)]);
    check('and stay together', ea.id === advanced && eb.id === advanced, `A ${ea.id}, B ${eb.id}`);

    // Host ends the Jam.
    await popA.bringToFront();
    await popA.click('#leave');
    const ended = await until(async () => !(await popB.locator('[data-view="ended"]').isHidden()), 5000);
    check('host ending the Jam ends it for the guest', Boolean(ended));
  } finally {
    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    await Promise.all([A.context.close(), B.context.close()]);
    process.exitCode = passed === results.length ? 0 : 1;
  }
}

// Song rows from a search, like a user typing in the search box.
async function searchRows(b, query) {
  await b.page.evaluate(q => document.body.dispatchEvent(new CustomEvent('yt-navigate', {
    bubbles: true, composed: true, detail: { endpoint: { searchEndpoint: { query: q, params: 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D' } } }
  })), query);
  const rows = b.page.locator('ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer');
  await rows.first().waitFor({ timeout: 15000 });
  return rows;
}

const rowVideoId = row => row.evaluate(el => el.data?.playlistItemData?.videoId);

async function addToQueueFromUpNext(b) {
  const rows = await searchRows(b, 'a-ha take on me');
  const row = rows.nth(0);
  const videoId = await rowVideoId(row);
  await row.hover();
  await row.locator('ytmusic-menu-renderer').last().locator('yt-button-shape button, button').last().click();
  const item = b.page.locator('ytmusic-popup-container tp-yt-iron-dropdown ytmusic-menu-popup-renderer #items > *', { hasText: 'Add to queue' }).first();
  await item.waitFor({ timeout: 5000 });
  await item.click();
  return videoId;
}

async function clickUpNextRow(b, index) {
  const rows = await searchRows(b, 'abba gimme gimme gimme');
  const row = rows.nth(index);
  const videoId = await rowVideoId(row);
  await row.locator('.title a, yt-formatted-string.title a').first().click();
  return videoId;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
