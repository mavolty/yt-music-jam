import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

async function exists(path) { try { await access(path); return true; } catch { return false; } }
export async function browserPath() {
  if (process.env.CHROMIUM_PATH) {
    if (!await exists(process.env.CHROMIUM_PATH)) throw new Error('CHROMIUM_PATH does not point to a browser executable.');
    return process.env.CHROMIUM_PATH;
  }
  if (await exists(chromium.executablePath())) return chromium.executablePath();
  const roots = [resolve('.cache/browsers'), join(homedir(), '.cache/ms-playwright'), join(homedir(), 'Library/Caches/ms-playwright')];
  for (const root of roots) {
    if (!await exists(root)) continue;
    const candidates = (await readdir(root)).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const candidate of candidates) {
      for (const binary of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-win/chrome.exe', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
        const path = join(root, candidate, binary);
        if (await exists(path)) return path;
      }
    }
  }
  throw new Error('Chromium is not installed. Set CHROMIUM_PATH, or install it locally with PLAYWRIGHT_BROWSERS_PATH=.cache/browsers npx --no-install playwright install chromium.');
}
