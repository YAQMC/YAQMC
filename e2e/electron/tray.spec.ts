import { expect, test } from '@playwright/test';
import {
  e2eArmOpenSettingsListener,
  e2eCoreInvoke,
  e2eCorePid,
  e2eCoreStatus,
  e2eIsCoreImageName,
  e2eLastPlayerSnapshot,
  e2eMainHide,
  e2eMainVisible,
  e2eOpenSettingsEventSeen,
  e2eOpenSettingsHits,
  e2ePidAlive,
  e2ePlayerSnapshotHits,
  e2eProcessImage,
  e2eStopOwnedCorePid,
  e2eTrayActive,
  e2eTrayClick,
  e2eWaitForHostExit,
  e2eWaitForPidExit,
  launchElectronFakeWindow,
  resolveE2eCoreBin,
} from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();

const TRAY_TRACKS = [
  {
    id: 'tray-one',
    title: 'Tray One',
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', title: 'Album' },
    artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000000' },
    durationMs: 10_000,
    trackNumber: 1,
    isFavorite: false,
    quality: 'lossless' as const,
    availability: { status: 'available' as const },
  },
  {
    id: 'tray-two',
    title: 'Tray Two',
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', title: 'Album' },
    artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000000' },
    durationMs: 10_000,
    trackNumber: 2,
    isFavorite: false,
    quality: 'lossless' as const,
    availability: { status: 'available' as const },
  },
];

test.describe('PLAT-01 tray click', () => {
  let session: Awaited<ReturnType<typeof launchElectronFakeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronFakeWindow({ tray: true });
  });

  test.afterAll(async () => {
    try {
      await session?.app.close();
    } catch {
      // already closed
    }
  });

  test('programmatic show-hide toggles the main window', async () => {
    const { app } = session;
    await expect.poll(() => e2eTrayActive(app)).toBe(true);
    await expect.poll(() => e2eMainVisible(app)).toBe(true);

    expect(await e2eTrayClick(app, 'show-hide')).toBe(true);
    await expect.poll(() => e2eMainVisible(app)).toBe(false);

    expect(await e2eTrayClick(app, 'show-hide')).toBe(true);
    await expect.poll(() => e2eMainVisible(app)).toBe(true);
  });

  test('settings raises the main window and fans out app://open-settings', async () => {
    const { app, page } = session;
    await expect.poll(() => e2eTrayActive(app)).toBe(true);
    expect(await e2eMainHide(app)).toBe(true);
    await expect.poll(() => e2eMainVisible(app)).toBe(false);

    const hitsBefore = await e2eOpenSettingsHits(app);
    await e2eArmOpenSettingsListener(page);
    expect(await e2eTrayClick(app, 'settings')).toBe(true);

    await expect.poll(() => e2eMainVisible(app)).toBe(true);
    await expect.poll(() => e2eOpenSettingsHits(app)).toBeGreaterThan(hitsBefore);
    await expect.poll(() => e2eOpenSettingsEventSeen(page)).toBe(true);
  });
});

test.describe('PLAT-01 tray player and quit', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(120_000);

  let session: Awaited<ReturnType<typeof launchElectronFakeWindow>> | undefined;
  let ownedCorePid: number | undefined;
  let quitHost = false;

  test.beforeAll(async () => {
    session = await launchElectronFakeWindow({ tray: true, spawnCore: true });
  });

  test.afterAll(async () => {
    if (!quitHost) {
      try {
        await session?.app.close();
      } catch {
        // already closed
      }
    }
    if (ownedCorePid !== undefined) {
      const dead = await e2eWaitForPidExit(ownedCorePid, 15_000);
      if (!dead) {
        e2eStopOwnedCorePid(ownedCorePid);
        await e2eWaitForPidExit(ownedCorePid, 5_000);
      }
    }
    if (
      ownedCorePid !== undefined &&
      e2ePidAlive(ownedCorePid) &&
      e2eIsCoreImageName(e2eProcessImage(ownedCorePid))
    ) {
      throw new Error(`orphan yaqmc-core pid ${String(ownedCorePid)} remains after tray suite`);
    }
  });

  test('play/pause, next, and previous reach Core through the tray handler', async () => {
    const { app } = session!;
    await expect.poll(() => e2eTrayActive(app)).toBe(true);
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');
    const corePid = await e2eCorePid(app);
    expect(corePid).toBeGreaterThan(0);
    ownedCorePid = corePid ?? undefined;

    await e2eCoreInvoke(app, 'player_hydrate_queue', { tracks: TRAY_TRACKS });
    await expect
      .poll(async () => e2eLastPlayerSnapshot(app), { timeout: 15_000 })
      .toEqual(expect.objectContaining({ queueLength: 2, currentIndex: 0 }));

    const hitsAfterHydrate = await e2ePlayerSnapshotHits(app);
    expect(await e2eTrayClick(app, 'next')).toBe(true);
    await expect
      .poll(async () => e2eLastPlayerSnapshot(app), { timeout: 15_000 })
      .toEqual(expect.objectContaining({ currentIndex: 1, queueLength: 2 }));
    expect(await e2ePlayerSnapshotHits(app)).toBeGreaterThan(hitsAfterHydrate);

    expect(await e2eTrayClick(app, 'previous')).toBe(true);
    await expect
      .poll(async () => e2eLastPlayerSnapshot(app), { timeout: 15_000 })
      .toEqual(expect.objectContaining({ currentIndex: 0, queueLength: 2 }));

    const beforeToggle = await e2eLastPlayerSnapshot(app);
    expect(await e2eTrayClick(app, 'play-pause')).toBe(true);
    await expect
      .poll(async () => e2eLastPlayerSnapshot(app), { timeout: 15_000 })
      .toEqual(
        expect.objectContaining({
          queueLength: 2,
        }),
      );
    await expect
      .poll(async () => {
        const snap = await e2eLastPlayerSnapshot(app);
        if (!snap) {
          return false;
        }
        const moved =
          snap.playbackState !== 'idle' ||
          snap.errorCode !== null ||
          snap.snapshotRevision > (beforeToggle?.snapshotRevision ?? 0);
        return moved;
      })
      .toBe(true);
    expect(await e2eCorePid(app)).toBe(ownedCorePid);
    expect(e2eIsCoreImageName(e2eProcessImage(ownedCorePid!))).toBe(true);
  });

  test('quit uses host shutdown and leaves no orphan Core', async () => {
    const { app } = session!;
    await expect.poll(() => e2eTrayActive(app)).toBe(true);
    expect(ownedCorePid).toBeGreaterThan(0);
    expect(e2ePidAlive(ownedCorePid!)).toBe(true);

    expect(await e2eTrayClick(app, 'quit')).toBe(true);
    quitHost = true;
    await e2eWaitForHostExit(app, 20_000);
    await expect.poll(() => e2ePidAlive(ownedCorePid!), { timeout: 15_000 }).toBe(false);
  });
});
