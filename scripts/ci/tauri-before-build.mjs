import { spawnSync } from 'node:child_process';
import { repositoryRoot } from './repo.mjs';
import { verifyFrontendDist } from './verify-frontend-dist.mjs';

function runNpmBuild() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.env.YAQMC_PREBUILT_FRONTEND === '1') {
  const info = verifyFrontendDist();
  process.stdout.write(`Using prebuilt frontend dist for ${info.gitSha}\n`);
  process.exit(0);
}

runNpmBuild();
