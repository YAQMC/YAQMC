/**
 * PLAY-03 Windows: sample Core clock on the ACC-04 daily-driver CDP.
 * Brief minimize/restore. Does not sign HUMAN. Isolated from E2E fake tracks.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { assertProductionAttachAllowed } from '../qa-runtime.mjs';

assertProductionAttachAllowed(process.env, 'ACC-02 PLAY-03 CDP probe');

const port = Number(process.env.YAQMC_ACC02_CDP || 9232);

function restoreDailyDriver() {
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class Acc02Win {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@',
    '$conn = Get-NetTCPConnection -LocalPort 9232 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1',
    'if (-not $conn) { throw "no listener on 9232" }',
    '$proc = Get-Process -Id $conn.OwningProcess',
    'if ($proc.MainWindowHandle -eq 0) { throw "no MainWindowHandle" }',
    '[void][Acc02Win]::ShowWindowAsync($proc.MainWindowHandle, 9)',
    '[void][Acc02Win]::SetForegroundWindow($proc.MainWindowHandle)',
  ].join('\n');
  execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
}

async function invoke(page, method, params) {
  return page.evaluate(
    async ({ methodName, payload }) => {
      const yaqmc = globalThis.yaqmc;
      if (!yaqmc || typeof yaqmc.invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return yaqmc.invoke(methodName, payload);
    },
    { methodName: method, payload: params },
  );
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
const page =
  browser.contexts().flatMap((context) => context.pages()).find((item) => {
    const url = item.url();
    return url.includes('127.0.0.1:1420') && !url.includes('surface=') && !url.includes('unlockSurface=');
  }) ?? browser.contexts().flatMap((context) => context.pages())[0];
if (!page) throw new Error('no daily-driver page');

const snap0 = await invoke(page, 'player_snapshot');
if (snap0.isPlaying !== true) {
  await invoke(page, 'player_play');
  await delay(500);
}

const visibleA = await invoke(page, 'player_snapshot');
const projA = await invoke(page, 'lyrics_surface_projection');
await delay(2_000);
const visibleB = await invoke(page, 'player_snapshot');
const projB = await invoke(page, 'lyrics_surface_projection');

await invoke(page, 'window.minimize');
await delay(400);
const hiddenState = await page.evaluate(() => ({
  hidden: document.hidden,
  visibility: document.visibilityState,
}));
const minA = await invoke(page, 'player_snapshot');
const minProjA = await invoke(page, 'lyrics_surface_projection');
await delay(2_500);
const minB = await invoke(page, 'player_snapshot');
const minProjB = await invoke(page, 'lyrics_surface_projection');
restoreDailyDriver();

const report = {
  capturedAt: new Date().toISOString(),
  cdp: port,
  hiddenState,
  visible: {
    positionDeltaMs: (visibleB.positionMs ?? 0) - (visibleA.positionMs ?? 0),
    lineA: projA.lineIndex,
    lineB: projB.lineIndex,
    isPlayingA: visibleA.isPlaying,
    isPlayingB: visibleB.isPlaying,
  },
  minimized: {
    positionDeltaMs: (minB.positionMs ?? 0) - (minA.positionMs ?? 0),
    lineA: minProjA.lineIndex,
    lineB: minProjB.lineIndex,
    isPlayingA: minA.isPlaying,
    isPlayingB: minB.isPlaying,
    positionA: minA.positionMs,
    positionB: minB.positionMs,
  },
  note: 'Daily-driver CDP. Not PASS-HUMAN. Restore best-effort after minimize.',
};
const out = path.join(os.tmpdir(), 'yaqmc-play03-daily-driver.json');
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await browser.close();
