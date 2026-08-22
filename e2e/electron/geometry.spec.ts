import { expect, test } from '@playwright/test';
import {
  e2eBrowserWindowUrls,
  e2eCoreStatus,
  e2eLyricsBounds,
  e2eLyricsFlushGeometry,
  e2eLyricsSetBounds,
  e2eLyricsShow,
  launchElectronFakeWindow,
  resolveE2eCoreBin,
  type E2eLyricsBounds,
  type E2eLyricsKind,
} from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();

/** FACT island Regular size from `LYRICS_SURFACE_GEOMETRY.island`. */
const ISLAND_FACT = { width: 520, height: 156 } as const;
const ISLAND_TARGET = { x: 140, y: 48, width: 520, height: 156 };
const DESKTOP_TARGET = { x: 80, y: 60, width: 780, height: 190 };

async function waitForSurface(app: Parameters<typeof e2eLyricsShow>[0], kind: E2eLyricsKind) {
  await e2eLyricsShow(app, kind);
  await expect.poll(async () => e2eLyricsBounds(app, kind), { intervals: [250] }).not.toBeNull();
  await expect
    .poll(() => e2eBrowserWindowUrls(app).some((url) => url.includes(`surface=${kind}`)), {
      intervals: [250],
    })
    .toBe(true);
}

test.describe('SURF-03 lyrics geometry persist', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(120_000);

  test('restores desktop lyrics bounds after relaunch', async () => {
    const first = await launchElectronFakeWindow({ spawnCore: true });
    let saved: E2eLyricsBounds | undefined;
    try {
      await expect.poll(() => e2eCoreStatus(first.app), { timeout: 60_000 }).toBe('ready');
      await waitForSurface(first.app, 'desktop');
      expect(await e2eLyricsSetBounds(first.app, 'desktop', DESKTOP_TARGET)).toBe(true);
      await e2eLyricsFlushGeometry(first.app, 'desktop');
      const current = await e2eLyricsBounds(first.app, 'desktop');
      expect(current).toEqual(expect.objectContaining({ width: 780, height: 190 }));
      if (!current) {
        throw new Error('desktop bounds missing after flush');
      }
      saved = current;
    } finally {
      await first.app.close();
    }

    const second = await launchElectronFakeWindow({ spawnCore: true });
    try {
      await expect.poll(() => e2eCoreStatus(second.app), { timeout: 60_000 }).toBe('ready');
      await waitForSurface(second.app, 'desktop');
      await expect
        .poll(async () => e2eLyricsBounds(second.app, 'desktop'), {
          timeout: 15_000,
          intervals: [250],
        })
        .toEqual(saved);
    } finally {
      await second.app.close();
    }
  });

  test('creates Lyrics Island at FACT size, persists, restores, and stays isolated from desktop', async () => {
    const first = await launchElectronFakeWindow({ spawnCore: true });
    let savedIsland: E2eLyricsBounds | undefined;
    let savedDesktop: E2eLyricsBounds | undefined;
    try {
      await expect.poll(() => e2eCoreStatus(first.app), { timeout: 60_000 }).toBe('ready');
      await waitForSurface(first.app, 'island');
      const created = await e2eLyricsBounds(first.app, 'island');
      expect(created).toEqual(expect.objectContaining(ISLAND_FACT));

      await waitForSurface(first.app, 'desktop');
      expect(await e2eLyricsSetBounds(first.app, 'island', ISLAND_TARGET)).toBe(true);
      expect(await e2eLyricsSetBounds(first.app, 'desktop', DESKTOP_TARGET)).toBe(true);
      await e2eLyricsFlushGeometry(first.app, 'island');
      await e2eLyricsFlushGeometry(first.app, 'desktop');

      const island = await e2eLyricsBounds(first.app, 'island');
      const desktop = await e2eLyricsBounds(first.app, 'desktop');
      expect(island).toEqual(expect.objectContaining(ISLAND_FACT));
      expect(desktop).toEqual(expect.objectContaining({ width: 780, height: 190 }));
      expect(island).not.toEqual(desktop);
      if (!island || !desktop) {
        throw new Error('surface bounds missing after flush');
      }
      savedIsland = island;
      savedDesktop = desktop;
    } finally {
      await first.app.close();
    }

    const second = await launchElectronFakeWindow({ spawnCore: true });
    try {
      await expect.poll(() => e2eCoreStatus(second.app), { timeout: 60_000 }).toBe('ready');
      await waitForSurface(second.app, 'island');
      await waitForSurface(second.app, 'desktop');
      await expect
        .poll(async () => e2eLyricsBounds(second.app, 'island'), {
          timeout: 15_000,
          intervals: [250],
        })
        .toEqual(savedIsland);
      await expect
        .poll(async () => e2eLyricsBounds(second.app, 'desktop'), {
          timeout: 15_000,
          intervals: [250],
        })
        .toEqual(savedDesktop);
      expect(savedIsland).not.toEqual(savedDesktop);
      const urls = e2eBrowserWindowUrls(second.app);
      expect(urls.some((url) => url.includes('surface=island'))).toBe(true);
      expect(urls.some((url) => url.includes('surface=desktop'))).toBe(true);
      expect(urls.some((url) => url.includes('unlockSurface='))).toBe(false);
    } finally {
      await second.app.close();
    }
  });
});
