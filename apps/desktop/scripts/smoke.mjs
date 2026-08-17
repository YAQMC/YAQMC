import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = createRequire(import.meta.url)('electron');

const child = spawn(electronBinary, ['.'], {
  cwd: root,
  env: {
    ...process.env,
    YAQMC_DESKTOP_SMOKE: '1',
    ELECTRON_DISABLE_GPU: '1',
  },
  stdio: 'inherit',
});

const timeout = setTimeout(() => {
  child.kill();
  process.stderr.write('desktop smoke timed out\n');
  process.exit(1);
}, 45_000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  process.exit(code ?? 1);
});
