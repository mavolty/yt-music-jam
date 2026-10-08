import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

for (const directory of ['extension', 'relay', 'scripts']) {
  for (const name of await readdir(directory)) {
    if (/\.(m?js)$/.test(name)) execFileSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'pipe' });
  }
}
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['storage']);
assert.deepEqual(manifest.host_permissions, ['https://music.youtube.com/*']);
assert.equal(manifest.background.type, 'module');
assert(!manifest.web_accessible_resources);
for (const script of manifest.content_scripts) assert.deepEqual(script.matches, ['https://music.youtube.com/*']);
for (const name of ['adapter.js', 'content.js']) {
  const source = await readFile(`extension/${name}`, 'utf8');
  assert(!/\bfetch\s*\(|new WebSocket|chrome\.cookies|document\.cookie/.test(source), `${name} must not access credentials or the network`);
}
console.log('JavaScript syntax and extension permission/privacy checks passed. No unit tests run.');
