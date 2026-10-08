import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { relayOrigin } from '../extension/crypto.js';

const args = process.argv.slice(2);
const outputArg = args.indexOf('--output');
const relayArg = args.indexOf('--relay-url');
const output = resolve(outputArg >= 0 ? args[outputArg + 1] : 'dist/extension');
if (!output.startsWith(`${process.cwd()}/`)) throw new Error('Build output must remain inside this repository.');
await mkdir(output, { recursive: true });
for (const name of await readdir('extension')) await copyFile(`extension/${name}`, `${output}/${name}`);
const manifest = JSON.parse(await readFile(`${output}/manifest.json`, 'utf8'));
if (relayArg >= 0) {
  const origin = relayOrigin(args[relayArg + 1]);
  manifest.host_permissions.push(`${origin}/*`);
  manifest.optional_host_permissions = [];
  const popupPath = `${output}/popup.js`;
  const popup = await readFile(popupPath, 'utf8');
  await writeFile(popupPath, popup + `\nelement('relay').value = ${JSON.stringify(origin)};\n`);
}
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
await mkdir('artifacts', { recursive: true });
if (outputArg < 0) {
  execFileSync('python3', ['-c', 'import pathlib,sys,zipfile; source=pathlib.Path(sys.argv[1]); archive=pathlib.Path(sys.argv[2]); z=zipfile.ZipFile(archive,"w",zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(source)) for p in sorted(source.iterdir()) if p.is_file()]; z.close()', output, resolve('artifacts/yt-music-together.zip')]);
  console.log('Chrome extension built: dist/extension');
  console.log('Installable archive: artifacts/yt-music-together.zip');
} else console.log(`Chrome extension built: ${output}`);
