import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

for (const directory of ['.cache/config', '.cache/tool-temp', '.cache/tools']) await mkdir(directory, { recursive: true });
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: resolve('.cache/config'), XDG_CACHE_HOME: resolve('.cache/tools'), TMPDIR: resolve('.cache/tool-temp') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
