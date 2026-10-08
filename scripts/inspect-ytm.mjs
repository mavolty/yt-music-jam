import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserPath } from './browser-path.mjs';

await mkdir('.cache/browser-temp', { recursive: true });
const executablePath = await browserPath();
const context = await chromium.launchPersistentContext(resolve('.cache/inspect-profile'), {
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  env: { ...process.env, TMPDIR: resolve('.cache/browser-temp') },
});
try {
  const page = await context.newPage();
  const songArg = process.argv.indexOf('--probe-song');
  const song = songArg >= 0 ? process.argv[songArg + 1] : '';
  if (song && !/^[\w-]{11}$/.test(song)) throw new Error('Use a public video ID for the read-only playback probe.');
  await page.goto(song ? `https://music.youtube.com/watch?v=${song}` : 'https://music.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  const result = await page.evaluate(() => {
    const tags = ['ytmusic-app', 'ytmusic-player', 'ytmusic-player-bar', 'ytmusic-player-queue'];
    return {
      title: document.title,
      publicPlaybackProbe: (() => {
        const element = document.querySelector('ytmusic-player');
        const api = element?.polymerController?.playerApi || element?.inst?.playerApi;
        const queueElement = document.querySelector('ytmusic-player-queue');
        const queue = queueElement?.polymerController?.queue || queueElement?.inst?.queue;
        return { duration: api?.getDuration?.() || 0, playerState: api?.getPlayerState?.(), nativeQueueLength: queue?.getItems?.().length || 0 };
      })(),
      elements: tags.map(tag => {
        const node = document.querySelector(tag);
        if (!node) return { tag, present: false };
        const functions = new Set();
        for (let proto = node; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            try { if (typeof node[name] === 'function' && /queue|player|state|item|play|pause|seek|index/i.test(name)) functions.add(name); } catch {}
          }
        }
        const controllers = [node, node.polymerController, node.inst].filter(Boolean);
        return { tag, present: true, functions: [...functions], controllers: controllers.map(c => ({
          kind: c === node ? 'element' : c === node.polymerController ? 'polymerController' : 'inst',
          relevantFields: Object.keys(c).filter(k => /queue|player|store|item|manager/i.test(k)),
          queueAvailable: !!c.queue, queueRead: typeof c.queue?.getItems === 'function',
          queueWrite: typeof c.queue?.store?.dispatch === 'function',
          playerAvailable: !!c.playerApi, playerState: typeof c.playerApi?.getPlayerState === 'function',
          queueLength: typeof c.queue?.getItems === 'function' ? c.queue.getItems().length : null,
        })) };
      }),
    };
  });
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/public-player-inspection.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await context.close(); }
