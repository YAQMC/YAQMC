import { expect, test, type Page } from '@playwright/test';
import {
  e2eCoreStatus,
  e2eLyricsHide,
  e2eLyricsIsLocked,
  e2eLyricsIsVisible,
  e2eLyricsPage,
  e2eLyricsSetBounds,
  e2eLyricsShow,
  e2eLyricsUnlockPage,
  e2eOpenSettingsHits,
  e2ePlayerSnapshotHits,
  e2eUnlockWindowVisible,
  launchElectronNativeWindow,
  resolveE2eCoreBin,
  type E2eLyricsKind,
} from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();

function fixtureTrack(id: string, durationMs: number) {
  return {
    id,
    title: id,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', title: 'Album' },
    artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000000' },
    durationMs,
    trackNumber: 1,
    isFavorite: false,
    quality: 'standard' as const,
    availability: { status: 'available' as const },
  };
}

type PlayerSnapshot = {
  queue?: Array<{ id?: string }>;
  currentIndex?: number | null;
  isPlaying?: boolean;
};

function trackId(snapshot: PlayerSnapshot | null | undefined): string {
  if (!snapshot) {
    return '';
  }
  const index = snapshot.currentIndex ?? 0;
  return snapshot.queue?.[index]?.id ?? '';
}

async function rendererInvoke<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    async ({ methodName, payload }) => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke =
        yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke(methodName, payload) as Promise<T>;
    },
    { methodName: method, payload: params },
  );
}

async function persistSurfaceEnabled(
  page: Page,
  patch: Partial<Record<E2eLyricsKind, boolean>>,
  interaction: 'interactive' | 'passive-locked' = 'interactive',
) {
  const raw = await rendererInvoke<string>(page, 'app_preferences_get');
  const parsed =
    raw && raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : { version: 2 };
  const surfaces =
    parsed.surfaces && typeof parsed.surfaces === 'object'
      ? { ...(parsed.surfaces as Record<string, Record<string, unknown>>) }
      : {};
  if (patch.desktop !== undefined) {
    surfaces.desktop = { ...(surfaces.desktop ?? {}), enabled: patch.desktop, interaction };
  }
  if (patch.island !== undefined) {
    surfaces.island = { ...(surfaces.island ?? {}), enabled: patch.island, interaction };
  }
  parsed.surfaces = surfaces;
  await rendererInvoke(page, 'app_preferences_set', { value: JSON.stringify(parsed) });
}

async function waitForLyricsPage(
  app: Parameters<typeof e2eLyricsShow>[0],
  page: Page,
  kind: E2eLyricsKind,
) {
  await persistSurfaceEnabled(page, { [kind]: true });
  await e2eLyricsShow(app, kind);
  await expect.poll(() => e2eLyricsPage(app, kind), { timeout: 15_000 }).not.toBeUndefined();
  await expect.poll(() => e2eLyricsIsVisible(app, kind), { timeout: 15_000 }).toBe(true);
  const lyricsPage = await e2eLyricsPage(app, kind);
  if (!lyricsPage) {
    throw new Error(`lyrics ${kind} page missing`);
  }
  return lyricsPage;
}

async function hoverSurface(lyricsPage: Page, kind: E2eLyricsKind) {
  const surface = lyricsPage.locator(
    kind === 'desktop' ? '.lyrics-surface--desktop' : '.lyrics-surface--island',
  );
  await expect(surface).toBeVisible();
  await lyricsPage.waitForTimeout(180);
  await surface.hover({ position: { x: 48, y: 36 } });
  await surface.hover({ position: { x: 72, y: 40 } });
  await expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-hover');
  return surface;
}

async function appRegion(lyricsPage: Page, selector: string) {
  return lyricsPage.evaluate(
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node ? getComputedStyle(node).getPropertyValue('-webkit-app-region').trim() : '';
    })()`,
  ) as Promise<string>;
}

test.describe('SURF-02 lyrics surface controls + lock ownership', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(180_000);

  let session: Awaited<ReturnType<typeof launchElectronNativeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronNativeWindow({ spawnCore: true });
  });

  test.afterAll(async () => {
    try {
      if (session) {
        await rendererInvoke(session.page, 'lyrics_surfaces_unlock_all').catch(() => undefined);
        await rendererInvoke(session.page, 'lyrics_surface_reset_position', {
          kind: 'desktop',
        }).catch(() => undefined);
        await rendererInvoke(session.page, 'lyrics_surface_reset_position', {
          kind: 'island',
        }).catch(() => undefined);
        await e2eLyricsHide(session.app, 'desktop').catch(() => undefined);
        await e2eLyricsHide(session.app, 'island').catch(() => undefined);
        await session.app.close();
      }
    } catch {
      // already closed
    }
  });

  test('boots Core and hydrates a two-track queue', async () => {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');
    await rendererInvoke(page, 'lyrics_surfaces_unlock_all').catch(() => undefined);
    await rendererInvoke(page, 'player_play_tracks', {
      request: {
        tracks: [fixtureTrack('surf-control-a', 120_000), fixtureTrack('surf-control-b', 120_000)],
        shuffle: false,
      },
    });
    await rendererInvoke(page, 'player_play');
    await expect
      .poll(async () => rendererInvoke<PlayerSnapshot>(page, 'player_snapshot'), {
        timeout: 12_000,
      })
      .toEqual(expect.objectContaining({ isPlaying: true }));
    expect(trackId(await rendererInvoke<PlayerSnapshot>(page, 'player_snapshot'))).toBe(
      'surf-control-a',
    );
  });

  for (const kind of ['desktop', 'island'] as const) {
    test(`${kind} operation buttons reach player/host handlers and stay out of drag`, async () => {
      const { app, page } = session;
      await rendererInvoke(page, 'lyrics_surfaces_unlock_all').catch(() => undefined);
      const lyricsPage = await waitForLyricsPage(app, page, kind);
      const role = await lyricsPage.evaluate(() => {
        const yaqmc = Reflect.get(globalThis, 'yaqmc');
        return yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'windowRole') : null;
      });
      expect(role).toBe(kind === 'desktop' ? 'lyrics-desktop' : 'lyrics-island');

      await hoverSurface(lyricsPage, kind);
      expect(await appRegion(lyricsPage, '.lyrics-surface__drag')).toBe('drag');
      expect(await appRegion(lyricsPage, '.lyrics-surface__controls')).toBe('no-drag');
      expect(await appRegion(lyricsPage, '.lyrics-surface__controls .icon-button')).toBe('no-drag');

      await lyricsPage.getByRole('button', { name: 'Next track' }).click();
      await expect
        .poll(async () => trackId(await rendererInvoke<PlayerSnapshot>(page, 'player_snapshot')), {
          timeout: 8_000,
        })
        .toBe('surf-control-b');

      await hoverSurface(lyricsPage, kind);
      await lyricsPage.getByRole('button', { name: 'Previous track' }).click();
      await expect
        .poll(async () => trackId(await rendererInvoke<PlayerSnapshot>(page, 'player_snapshot')), {
          timeout: 8_000,
        })
        .toBe('surf-control-a');

      const beforeToggle = await rendererInvoke<PlayerSnapshot>(page, 'player_snapshot');
      await hoverSurface(lyricsPage, kind);
      const playOrPause = lyricsPage.getByRole('button', { name: /^(Play|Pause)$/ });
      await playOrPause.click();
      await expect
        .poll(async () => rendererInvoke<PlayerSnapshot>(page, 'player_snapshot'), {
          timeout: 8_000,
        })
        .toEqual(expect.objectContaining({ isPlaying: !beforeToggle.isPlaying }));
      await rendererInvoke(page, 'player_play').catch(() => undefined);

      const settingsHits = await e2eOpenSettingsHits(app);
      await hoverSurface(lyricsPage, kind);
      await lyricsPage.getByRole('button', { name: 'Settings' }).click();
      await expect.poll(() => e2eOpenSettingsHits(app)).toBe(settingsHits + 1);
    });

    test(`${kind} lock stays host-owned until the matching unlock overlay is clicked`, async () => {
      const { app, page } = session;
      const other: E2eLyricsKind = kind === 'desktop' ? 'island' : 'desktop';
      await persistSurfaceEnabled(page, { desktop: true, island: true });
      const lyricsPage = await waitForLyricsPage(app, page, kind);
      await e2eLyricsShow(app, other);
      await expect.poll(() => e2eLyricsIsVisible(app, other), { timeout: 15_000 }).toBe(true);

      const surface = await hoverSurface(lyricsPage, kind);
      await lyricsPage.getByRole('button', { name: 'Lock as passive overlay' }).click();
      await expect.poll(() => e2eLyricsIsLocked(app, kind)).toBe(true);
      await expect.poll(() => e2eUnlockWindowVisible(app, kind)).toBe(true);
      expect(await e2eLyricsIsLocked(app, other)).toBe(false);
      await expect(surface).toHaveAttribute('data-interaction-state', 'visible-passive-locked');
      await expect(lyricsPage.locator('.lyrics-surface__controls')).toHaveCount(0);

      await lyricsPage.mouse.move(80, 40);
      await lyricsPage.mouse.move(120, 48);
      await lyricsPage.mouse.move(24, 24);
      await expect(surface).toHaveAttribute('data-interaction-state', 'visible-passive-locked');
      await expect(surface).not.toHaveClass(/lyrics-surface--interactive/);
      await expect(lyricsPage.locator('.lyrics-surface__controls')).toHaveCount(0);

      const hitsBefore = await e2ePlayerSnapshotHits(app);
      await rendererInvoke(page, 'player_seek', { positionMs: 1_800 });
      await expect
        .poll(() => e2ePlayerSnapshotHits(app), { timeout: 8_000 })
        .toBeGreaterThan(hitsBefore);
      expect(await e2eLyricsIsLocked(app, kind)).toBe(true);

      await rendererInvoke(page, 'player_next');
      await expect
        .poll(async () => trackId(await rendererInvoke<PlayerSnapshot>(page, 'player_snapshot')), {
          timeout: 8_000,
        })
        .toBe('surf-control-b');
      await rendererInvoke(page, 'player_previous').catch(() => undefined);

      expect(
        await e2eLyricsSetBounds(app, kind, { x: 96, y: 72, width: 640, height: 190 }),
      ).toBe(true);
      await lyricsPage.mouse.move(24, 24);
      await lyricsPage.mouse.move(0, 0);
      await page.waitForTimeout(1_200);
      expect(await e2eLyricsIsLocked(app, kind)).toBe(true);
      expect(await e2eLyricsIsLocked(app, other)).toBe(false);
      await expect(surface).toHaveAttribute('data-interaction-state', 'visible-passive-locked');
      await expect(lyricsPage.locator('.lyrics-surface__controls')).toHaveCount(0);
      await expect(lyricsPage.getByRole('button', { name: 'Play' })).toHaveCount(0);
      await expect(lyricsPage.getByRole('button', { name: 'Pause' })).toHaveCount(0);

      await expect.poll(() => e2eLyricsUnlockPage(app, kind), { timeout: 10_000 }).not.toBeUndefined();
      const unlockPage = await e2eLyricsUnlockPage(app, kind);
      if (!unlockPage) {
        throw new Error(`unlock overlay for ${kind} missing`);
      }
      const unlockName = kind === 'desktop' ? 'Unlock Desktop Lyrics' : 'Unlock Lyrics Island';
      await unlockPage.getByRole('button', { name: unlockName }).click();
      await expect.poll(() => e2eLyricsIsLocked(app, kind)).toBe(false);
      await expect.poll(() => e2eUnlockWindowVisible(app, kind)).toBe(false);
    });

    test(`${kind} close targets that surface only`, async () => {
      const { app, page } = session;
      const other: E2eLyricsKind = kind === 'desktop' ? 'island' : 'desktop';
      await rendererInvoke(page, 'lyrics_surfaces_unlock_all').catch(() => undefined);
      await persistSurfaceEnabled(page, { desktop: true, island: true });
      await expect.poll(() => e2eLyricsIsVisible(app, kind), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => e2eLyricsIsVisible(app, other), { timeout: 15_000 }).toBe(true);
      const lyricsPage = await e2eLyricsPage(app, kind);
      if (!lyricsPage) {
        throw new Error(`lyrics ${kind} page missing`);
      }
      await hoverSurface(lyricsPage, kind);
      await lyricsPage.getByRole('button', { name: 'Close' }).click();
      await expect.poll(() => e2eLyricsIsVisible(app, kind)).toBe(false);
      await expect.poll(() => e2eLyricsIsVisible(app, other)).toBe(true);
    });
  }
});
