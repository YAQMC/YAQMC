import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientRoot = path.join(repositoryRoot, 'packages', 'yaqmc-client');
const vitest = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');

const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    '--config',
    path.join(clientRoot, 'vitest.config.ts'),
    'src/bridges/p7-fake-playback.test.ts',
  ],
  { cwd: clientRoot, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
