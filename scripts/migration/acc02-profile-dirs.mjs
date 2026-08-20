/**
 * ACC-02 long-path and Unicode Core/Electron profile boot (Windows).
 * Isolated trees — not the ACC-04 daily-driver profile.
 *
 * Vite must already serve 127.0.0.1:1420. Desktop main must be built.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForTcp } from '../dev-desktop.mjs';
import { APP_IDENTIFIER, isSameOrInsidePath, resolveProductionCoreRoots, stripQaLaunchFlags } from '../qa-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron');

function coreBin() {
  const name = 'yaqmc-core.exe';
  const cargo = process.env.CARGO_TARGET_DIR;
  const candidates = [
    process.env.YAQMC_CORE_BIN,
    cargo ? path.join(cargo, 'debug', name) : undefined,
    path.join(repoRoot, 'target', 'debug', name),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 8_000,
    });
  } catch {
    // already gone
  }
}

function longPathExists(target) {
  const prefixed = target.startsWith('\\\\?\\') ? target : `\\\\?\\${target}`;
  try {
    return existsSync(target) || existsSync(prefixed);
  } catch {
    return false;
  }
}

function waitCoreReady(logPath, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (longPathExists(logPath) && readFileSync(logPath, 'utf8').includes('core ready')) {
          resolve();
          return;
        }
      } catch {
        try {
          const prefixed = `\\\\?\\${logPath}`;
          if (existsSync(prefixed) && readFileSync(prefixed, 'utf8').includes('core ready')) {
            resolve();
            return;
          }
        } catch {
          // rotating / MAX_PATH
        }
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${logPath}`));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function longPathsEnabled() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '(Get-ItemProperty -Path HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8_000 },
    ).trim();
    return out === '1';
  } catch {
    return null;
  }
}

async function boot(label, roaming, local, userData, port) {
  const production = resolveProductionCoreRoots({ env: process.env });
  const candidate = path.join(roaming, APP_IDENTIFIER);
  if (isSameOrInsidePath(candidate, production.dataDir) || isSameOrInsidePath(production.dataDir, candidate)) {
    throw new Error(`ACC-02 profile probe refused: ${candidate} overlaps production Core data`);
  }
  mkdirSync(roaming, { recursive: true });
  mkdirSync(local, { recursive: true });
  mkdirSync(userData, { recursive: true });
  const env = stripQaLaunchFlags(process.env);
  env.YAQMC_VITE_DEV = '1';
  env.APPDATA = roaming;
  env.LOCALAPPDATA = local;
  delete env.YAQMC_ELECTRON_E2E;
  delete env.YAQMC_DESKTOP_SMOKE;
  delete env.YAQMC_QA_MODE;
  delete env.YAQMC_QA_ROOT;
  const bin = coreBin();
  if (bin) env.YAQMC_CORE_BIN = bin;
  const stderrPath = path.join(os.tmpdir(), `yaqmc-acc02-${label}.stderr.txt`);
  const stderr = writeFileSync(stderrPath, '');
  void stderr;
  const child = spawn(
    electronBinary,
    ['.', `--remote-debugging-port=${String(port)}`, `--user-data-dir=${userData}`, '--lang=en-US'],
    {
      cwd: desktopRoot,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  );
  const chunks = [];
  child.stderr?.on('data', (buf) => chunks.push(buf));
  const logPath = path.join(local, 'org.yaqmc.desktop', 'logs', 'host.log');
  const meta = {
    label,
    roaming,
    roamingChars: roaming.length,
    localChars: local.length,
    userDataChars: userData.length,
    logPath,
    logPathChars: logPath.length,
    stderrPath,
  };
  try {
    await waitCoreReady(logPath);
    writeFileSync(stderrPath, Buffer.concat(chunks).toString('utf8'));
    return { ...meta, ok: true };
  } catch (error) {
    writeFileSync(stderrPath, Buffer.concat(chunks).toString('utf8'));
    return {
      ...meta,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      logExists: longPathExists(logPath),
      stderr: Buffer.concat(chunks).toString('utf8').slice(-2_000),
    };
  } finally {
    killTree(child.pid);
  }
}

async function main() {
  await waitForTcp('127.0.0.1', 1420, 5_000).catch(() => {
    throw new Error('Vite is not serving 127.0.0.1:1420');
  });
  if (!coreBin()) throw new Error('set YAQMC_CORE_BIN');

  const root = path.join(os.tmpdir(), 'yaqmc-acc02-profiles');
  rmSync(root, { recursive: true, force: true });
  const longOver = `L${'a'.repeat(180)}`;
  const longSafe = `L${'a'.repeat(80)}`;
  const cases = [
    {
      label: 'long-path-over-max',
      roaming: path.join(root, 'long-over', longOver, 'Roaming'),
      local: path.join(root, 'long-over', longOver, 'Local'),
      userData: path.join(root, 'long-over', longOver, 'electron-user'),
      port: 9251,
    },
    {
      label: 'long-path-under-260',
      roaming: path.join(root, 'long-safe', longSafe, 'Roaming'),
      local: path.join(root, 'long-safe', longSafe, 'Local'),
      userData: path.join(root, 'long-safe', longSafe, 'electron-user'),
      port: 9252,
    },
    {
      label: 'unicode',
      roaming: path.join(root, 'unicode', '验收-日本語-프로필', 'Roaming'),
      local: path.join(root, 'unicode', '验收-日本語-프로필', 'Local'),
      userData: path.join(root, 'unicode', '验收-日本語-프로필', 'electron-user'),
      port: 9253,
    },
  ];

  const results = [];
  for (const row of cases) {
    results.push(await boot(row.label, row.roaming, row.local, row.userData, row.port));
  }
  const out = {
    capturedAt: new Date().toISOString(),
    longPathsEnabled: longPathsEnabled(),
    results,
  };
  writeFileSync(path.join(os.tmpdir(), 'yaqmc-acc02-profiles.json'), `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  const required = results.filter((row) => row.label !== 'long-path-over-max');
  if (required.some((row) => !row.ok)) process.exit(1);
}

await main();
