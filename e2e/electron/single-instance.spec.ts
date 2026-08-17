import { expect, test } from '@playwright/test';
import {
  e2eCoreDataDir,
  e2eCorePid,
  e2eCoreStatus,
  e2eHostPid,
  e2eIsCoreImageName,
  e2eMainHide,
  e2eMainVisible,
  e2ePidAlive,
  e2eProcessImage,
  e2eSecondInstanceHits,
  e2eStopOwnedCorePid,
  e2eWaitForPidExit,
  launchElectronFakeWindow,
  readCorePidFile,
  resolveE2eCoreBin,
  spawnSecondElectronHost,
  type SpawnedSecondHost,
} from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();

test.describe('SUP-05 second-launch', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(150_000);

  test('second process quits without a second Core and shows the first window', async () => {
    let first: Awaited<ReturnType<typeof launchElectronFakeWindow>> | undefined;
    let second: SpawnedSecondHost | undefined;
    let ownedCorePid: number | undefined;
    try {
      first = await launchElectronFakeWindow({ spawnCore: true });
      const { app } = first;
      await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');

      const hostPid = await e2eHostPid(app);
      expect(hostPid).toBeGreaterThan(0);

      const corePid = await e2eCorePid(app);
      expect(corePid).toBeGreaterThan(0);
      ownedCorePid = corePid ?? undefined;
      if (ownedCorePid === undefined) {
        throw new Error('first instance did not report a live Core pid');
      }

      const dataDir = await e2eCoreDataDir(app);
      expect(dataDir.length).toBeGreaterThan(0);
      expect(readCorePidFile(dataDir)).toBe(ownedCorePid);
      expect(e2ePidAlive(ownedCorePid)).toBe(true);
      expect(e2eIsCoreImageName(e2eProcessImage(ownedCorePid))).toBe(true);

      expect(await e2eMainVisible(app)).toBe(true);
      const hitsBefore = await e2eSecondInstanceHits(app);
      expect(await e2eMainHide(app)).toBe(true);
      await expect.poll(() => e2eMainVisible(app)).toBe(false);

      second = spawnSecondElectronHost({ spawnCore: true });
      expect(second.pid).not.toBe(hostPid);
      expect(second.pid).not.toBe(ownedCorePid);
      await second.waitForExit(30_000);

      expect(await e2eHostPid(app)).toBe(hostPid);
      await expect.poll(() => e2eCoreStatus(app)).toBe('ready');
      expect(await e2eCorePid(app)).toBe(ownedCorePid);
      expect(readCorePidFile(dataDir)).toBe(ownedCorePid);
      expect(e2ePidAlive(ownedCorePid)).toBe(true);
      expect(e2eIsCoreImageName(e2eProcessImage(ownedCorePid))).toBe(true);

      await expect.poll(() => e2eSecondInstanceHits(app)).toBeGreaterThan(hitsBefore);
      await expect.poll(() => e2eMainVisible(app)).toBe(true);
    } finally {
      try {
        second?.kill();
      } catch {
        // already gone
      }
      try {
        await first?.app.close();
      } catch {
        // already closed
      }
      if (ownedCorePid !== undefined) {
        const dead = await e2eWaitForPidExit(ownedCorePid, 15_000);
        if (!dead) {
          e2eStopOwnedCorePid(ownedCorePid);
          await e2eWaitForPidExit(ownedCorePid, 5_000);
        }
      }
    }
    if (
      ownedCorePid !== undefined &&
      e2ePidAlive(ownedCorePid) &&
      e2eIsCoreImageName(e2eProcessImage(ownedCorePid))
    ) {
      throw new Error(`orphan yaqmc-core pid ${String(ownedCorePid)} remains after shutdown`);
    }
  });
});
