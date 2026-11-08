import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stripQaLaunchFlags } from './qa-runtime.mjs';

export const VITE_DEV_HOST = '127.0.0.1';
export const VITE_DEV_PORT = 1420;

export function desktopDevUrl(host = VITE_DEV_HOST, port = VITE_DEV_PORT) {
  return `http://${host}:${port}/`;
}

export function electronDevEnv(env = process.env) {
  return {
    ...stripQaLaunchFlags(env),
    YAQMC_VITE_DEV: '1',
  };
}

export function coreCargoArgs() {
  return ['build', '-p', 'yaqmc-core'];
}

export function coreBuildEnv(env = process.env) {
  return {
    ...env,
    CARGO_NET_GIT_FETCH_WITH_CLI: env.CARGO_NET_GIT_FETCH_WITH_CLI || 'true',
  };
}

export function checkDesktopDevDependencies(repositoryRoot) {
  const rootRequire = createRequire(path.join(repositoryRoot, 'package.json'));
  const desktopRequire = createRequire(
    path.join(repositoryRoot, 'apps', 'desktop', 'package.json'),
  );
  const missing = [];
  let viteCli;
  try {
    viteCli = path.join(path.dirname(rootRequire.resolve('vite/package.json')), 'bin', 'vite.js');
    if (!existsSync(viteCli)) missing.push('vite');
  } catch {
    missing.push('vite');
  }
  for (const name of ['esbuild', 'electron']) {
    try {
      desktopRequire.resolve(name);
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing desktop development dependencies: ${missing.join(', ')}. ` +
        'From the repository root, run: npm ci --include=dev --workspaces --include-workspace-root',
    );
  }
  return { viteCli };
}

export function watchDevProcess(child, name, controller) {
  child.once('error', (error) =>
    controller.abort(new Error(`${name} failed to start: ${error.message}`)),
  );
  child.once('exit', (code, signal) =>
    controller.abort(
      new Error(`${name} exited ${signal ? `with signal ${signal}` : `with code ${code}`}`),
    ),
  );
}

export function waitForTcp(host, port, timeoutMs = 30_000, signal) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let socket;
    let timer;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    const attempt = () => {
      if (settled) return;
      socket = net.connect({ host, port }, () => finish());
      socket.once('error', () => {
        if (settled) return;
        socket.destroy();
        if (Date.now() > deadline) {
          finish(new Error(`timed out waiting for ${host}:${port}`));
          return;
        }
        timer = setTimeout(attempt, 200);
      });
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    attempt();
  });
}

export async function waitForFile(filePath, timeoutMs = 30_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    if (existsSync(filePath)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    try {
      await delay(200, undefined, { signal });
    } catch (error) {
      throw signal?.reason ?? error;
    }
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await runDesktopDev();
  } catch (error) {
    console.error(`[dev:desktop] ${error.message}`);
    process.exitCode = 1;
  }
}

async function runDesktopDev() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
  // Fail before compiling Core when a pull/install omitted root or workspace dev tools.
  const { viteCli } = checkDesktopDevDependencies(repositoryRoot);
  const startup = new globalThis.AbortController();
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
    const cargo = spawnSync('cargo', coreCargoArgs(), {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: coreBuildEnv(process.env),
    });
    if (cargo.status !== 0) {
      process.exit(cargo.status ?? 1);
    }
    const stage = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, 'scripts', 'stage-core.mjs'), '--profile', 'debug'],
      {
        cwd: repositoryRoot,
        stdio: 'inherit',
        env: process.env,
      },
    );
    if (stage.status !== 0) {
      process.exit(stage.status ?? 1);
    }
  }

  try {
    const vite = spawnInherit(process.execPath, [viteCli], { cwd: repositoryRoot });
    children.push(vite);
    watchDevProcess(vite, 'Vite', startup);
    const builder = spawnInherit(
      process.execPath,
      [path.join(desktopRoot, 'scripts', 'build.mjs'), '--watch'],
      { cwd: desktopRoot },
    );
    children.push(builder);
    watchDevProcess(builder, 'Electron build watcher', startup);

    await waitForTcp(VITE_DEV_HOST, VITE_DEV_PORT, 30_000, startup.signal);
    await waitForFile(path.join(desktopRoot, 'dist', 'main', 'index.js'), 30_000, startup.signal);

    const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron');
    const electron = spawnInherit(electronBinary, ['.'], {
      cwd: desktopRoot,
      env: electronDevEnv(process.env),
    });
    children.push(electron);
    await new Promise((resolve, reject) => {
      const abort = () => reject(startup.signal.reason);
      startup.signal.addEventListener('abort', abort, { once: true });
      electron.once('error', reject);
      electron.once('exit', (code, signal) => {
        startup.signal.removeEventListener('abort', abort);
        if (code === 0) resolve();
        else
          reject(
            new Error(`Electron exited ${signal ? `with signal ${signal}` : `with code ${code}`}`),
          );
      });
      if (startup.signal.aborted) abort();
    });
  } finally {
    startup.abort();
    stop();
  }
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
