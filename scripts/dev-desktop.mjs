import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const VITE_DEV_HOST = '127.0.0.1';
export const VITE_DEV_PORT = 1420;

export function desktopDevUrl(host = VITE_DEV_HOST, port = VITE_DEV_PORT) {
  return `http://${host}:${port}/`;
}

export function electronDevEnv(env = process.env) {
  return {
    ...env,
    YAQMC_VITE_DEV: '1',
  };
}

export function waitForTcp(host, port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

export async function waitForFile(filePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(200);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await runDesktopDev();
}

async function runDesktopDev() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
  const children = [];
  const stop = () => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(143);
  });

  if (process.env.YAQMC_SKIP_CORE_BUILD !== '1') {
    const cargo = spawnSync('cargo', ['build', '-p', 'yaqmc-core'], {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
    });
    if (cargo.status !== 0) {
      process.exit(cargo.status ?? 1);
    }
  }

  children.push(
    spawnInherit('npm', ['run', 'dev'], { cwd: repositoryRoot }),
    spawnInherit(process.execPath, [path.join(desktopRoot, 'scripts', 'build.mjs'), '--watch'], {
      cwd: desktopRoot,
    }),
  );

  await waitForTcp(VITE_DEV_HOST, VITE_DEV_PORT);
  await waitForFile(path.join(desktopRoot, 'dist', 'main', 'index.js'));

  const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron');
  const electron = spawnInherit(electronBinary, ['.'], {
    cwd: desktopRoot,
    env: electronDevEnv(process.env),
  });
  children.push(electron);
  electron.on('exit', (code) => {
    stop();
    process.exit(code ?? 1);
  });
}

function spawnInherit(command, args, options) {
  const commandPath = String(command);
  return spawn(commandPath, args, {
    stdio: 'inherit',
    shell:
      process.platform === 'win32' &&
      commandPath !== process.execPath &&
      !commandPath.endsWith('.exe'),
    ...options,
    env: options.env ?? process.env,
  });
}
