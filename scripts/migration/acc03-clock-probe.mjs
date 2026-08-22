/**
 * Short isolated-player clock probe. Not the 120 s ACC-03 jitter capture.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { waitForTcp } from '../dev-desktop.mjs';
import {
  cleanupQaSandbox,
  createQaSandbox,
  electronQaArgs,
  qaElectronEnv,
} from '../qa-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron');
const port = 9260;

function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 8_000,
    });
  } catch {
    // gone
  }
}

const sandbox = createQaSandbox({ purpose: 'acc03-clock-probe' });
const env = qaElectronEnv(process.env, sandbox, { YAQMC_VITE_DEV: '1' });
delete env.YAQMC_ELECTRON_E2E;
const child = spawn(
  electronBinary,
  electronQaArgs(sandbox, [`--remote-debugging-port=${String(port)}`, '--lang=en-US']),
  { cwd: desktopRoot, env, stdio: 'ignore', windowsHide: true },
);
try {
  await waitForTcp('127.0.0.1', port, 45_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
  const page =
    browser.contexts().flatMap((context) => context.pages())[0] ??
    (await browser.contexts()[0]?.waitForEvent('page'));
  if (!page) throw new Error('no page');
  await page.waitForSelector('.app-shell', { timeout: 60_000 });
  const inv = (method, params) =>
    page.evaluate(async ({ methodName, payload }) => globalThis.yaqmc.invoke(methodName, payload), {
      methodName: method,
      payload: params,
    });
  await inv('player_play_tracks', {
    request: {
      tracks: [
        {
          id: 'clock-probe',
          title: 'clock-probe',
          artists: [{ id: 'a', name: 'A' }],
          album: { id: 'b', title: 'B' },
          artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000' },
          durationMs: 120_000,
          trackNumber: 1,
          isFavorite: false,
          quality: 'standard',
          availability: { status: 'available' },
        },
      ],
      shuffle: false,
    },
  });
  await inv('player_play');
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    const snap = await inv('player_snapshot');
    samples.push({
      t: Date.now(),
      positionMs: snap.positionMs,
      isPlaying: snap.isPlaying,
      playbackState: snap.playbackState,
    });
    await delay(1_000);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        deltaMs: (samples.at(-1)?.positionMs ?? 0) - (samples[0]?.positionMs ?? 0),
        samples,
      },
      null,
      2,
    )}\n`,
  );
  await browser.close();
  cleanupQaSandbox(sandbox.root);
} finally {
  killTree(child.pid);
}
