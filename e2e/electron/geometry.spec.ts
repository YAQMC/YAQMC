import { expect, test } from '@playwright/test';
import {
  e2eCoreStatus,
  e2eLyricsBounds,
  e2eLyricsFlushGeometry,
  e2eLyricsSetBounds,
  e2eLyricsShow,
  launchElectronFakeWindow,
  resolveE2eCoreBin,
} from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();

test.describe('SURF-03 lyrics geometry persist', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(120_000);

  test('restores desktop lyrics bounds after relaunch', async () => {
    const target = { x: 80, y: 60, width: 780, height: 190 };
    const first = await launchElectronFakeWindow({ spawnCore: true });
    let saved: { x: number; y: number; width: number; height: number } | null = null;
    try {
      await expect.poll(() => e2eCoreStatus(first.app), { timeout: 60_000 }).toBe('ready');
      await e2eLyricsShow(first.app, 'desktop');
      await expect
        .poll(async () => e2eLyricsBounds(first.app, 'desktop'), { intervals: [250] })
        .not.toBeNull();
      expect(await e2eLyricsSetBounds(first.app, 'desktop', target)).toBe(true);
      await e2eLyricsFlushGeometry(first.app, 'desktop');
      saved = await e2eLyricsBounds(first.app, 'desktop');
      expect(saved).toEqual(expect.objectContaining({ width: 780, height: 190 }));
    } finally {
      await first.app.close();
    }

    const second = await launchElectronFakeWindow({ spawnCore: true });
    try {
      await expect.poll(() => e2eCoreStatus(second.app), { timeout: 60_000 }).toBe('ready');
      await e2eLyricsShow(second.app, 'desktop');
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
});
