import { expect, test, type Page } from '@playwright/test';
import {
  e2eCoreStatus,
  e2eLyricsHide,
  e2eLyricsPage,
  e2eLyricsShow,
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

function lyricDocumentFor(songId: string, texts: [string, string]) {
  return {
    songId,
    syncMode: 'line' as const,
    metadata: { sourceLabel: 'qa', offsetMs: 0 },
    vocalists: [],
    lines: [
      { id: `${songId}-l0`, startMs: 0, endMs: 1_200, text: texts[0], words: [] },
      { id: `${songId}-l1`, startMs: 1_200, endMs: 4_000, text: texts[1], words: [] },
    ],
  };
}

const lyricDocument = lyricDocumentFor('ui-clock', ['line-zero', 'line-one']);
const lyricDocumentB = lyricDocumentFor('ui-clock-b', ['line-b-zero', 'line-b-one']);

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

async function samplePlaybackUi(page: Page, durationMs = 1_200) {
  return page.evaluate(async (ms) => {
    const probe = Reflect.get(globalThis, '__YAQMC_PLAYBACK_UI_PROBE__') as
      | { sample?: (durationMs?: number) => Promise<Record<string, number>> }
      | undefined;
    if (typeof probe?.sample !== 'function') {
      throw new Error('playback UI probe is missing');
    }
    return probe.sample(ms);
  }, durationMs);
}

async function expectActiveLyric(page: Page, text: string) {
  await expect(page.locator('.lyrics-surface__line[data-active]')).toContainText(text, {
    timeout: 8_000,
  });
}

async function waitForLyricsPage(app: Parameters<typeof e2eLyricsShow>[0], kind: E2eLyricsKind) {
  await e2eLyricsShow(app, kind);
  return expect.poll(() => e2eLyricsPage(app, kind), { timeout: 15_000 }).not.toBeUndefined();
}

test.describe('Playback UI + lyrics surfaces (native renderer + production Core)', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(180_000);

  let session: Awaited<ReturnType<typeof launchElectronNativeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronNativeWindow({ spawnCore: true });
  });

  test.afterAll(async () => {
    try {
      if (session) {
        await rendererInvoke(session.page, 'player_set_volume', { volume: 0.72 }).catch(
          () => undefined,
        );
        await rendererInvoke(session.page, 'player_pause').catch(() => undefined);
        await e2eLyricsHide(session.app, 'desktop').catch(() => undefined);
        await e2eLyricsHide(session.app, 'island').catch(() => undefined);
        await session.app.close();
      }
    } catch {
      // already closed
    }
  });

  test('playing does not lock main-thread rAF to the snapshot clock', async () => {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');

    await rendererInvoke(page, 'player_pause').catch(() => undefined);
    const idle = await samplePlaybackUi(page, 1_000);

    await rendererInvoke(page, 'player_play_tracks', {
      request: {
        tracks: [fixtureTrack('ui-clock', 120_000), fixtureTrack('ui-clock-b', 120_000)],
        shuffle: false,
      },
    });
    await rendererInvoke(page, 'player_play');
    await expect
      .poll(async () => rendererInvoke<{ isPlaying?: boolean }>(page, 'player_snapshot'), {
        timeout: 12_000,
      })
      .toEqual(expect.objectContaining({ isPlaying: true }));

    const playing = await samplePlaybackUi(page, 1_200);
    console.log(
      JSON.stringify({
        probe: 'playback-ui',
        gpu: 'disabled-e2e',
        idle,
        playing,
      }),
    );
    expect(playing.storeHz).toBeLessThan(12);
    expect(playing.ipcSnapshotHz).toBeLessThan(12);
    expect(playing.rafFps).toBeGreaterThan(Math.max(24, idle.rafFps - 20));
    expect(playing.rafFps).toBeGreaterThan(playing.ipcSnapshotHz * 2);
  });

  test('player sliders keep local drafts while playback snapshots arrive', async () => {
    const { page } = session;
    await expect
      .poll(async () => rendererInvoke<{ isPlaying?: boolean }>(page, 'player_snapshot'), {
        timeout: 8_000,
      })
      .toEqual(expect.objectContaining({ isPlaying: true }));

    const progress = page.getByRole('slider', { name: 'Playback position' });
    const volume = page.getByRole('slider', { name: 'Volume' });
    await expect(progress).toBeVisible();
    await expect(volume).toBeVisible();
    await progress.dispatchEvent('pointerdown');
    await progress.fill('3000');
    await volume.dispatchEvent('pointerdown');
    await volume.fill('0.31');
    await page.waitForTimeout(900);
    expect(Number(await progress.inputValue())).toBe(3_000);
    expect(Number(await volume.inputValue())).toBeCloseTo(0.31, 2);
    await progress.dispatchEvent('pointerup');
    await volume.dispatchEvent('pointerup');
    await rendererInvoke(page, 'player_set_volume', { volume: 0.72 });
    await rendererInvoke(page, 'player_pause').catch(() => undefined);
  });

  test('Desktop Lyrics syncs across open-before-play, seek, track change, and reopen', async () => {
    const { app, page } = session;
    await rendererInvoke(page, 'player_pause').catch(() => undefined);
    await rendererInvoke(page, 'player_set_lyrics', { document: lyricDocument });

    await waitForLyricsPage(app, 'desktop');
    let lyricsPage = await e2eLyricsPage(app, 'desktop');
    expect(lyricsPage).toBeDefined();
    await rendererInvoke(page, 'player_play');
    await rendererInvoke(page, 'player_seek', { positionMs: 200 });
    await expectActiveLyric(lyricsPage!, 'line-zero');

    await rendererInvoke(page, 'player_seek', { positionMs: 1_600 });
    await expectActiveLyric(lyricsPage!, 'line-one');

    await rendererInvoke(page, 'player_next');
    await rendererInvoke(page, 'player_set_lyrics', { document: lyricDocumentB });
    await expectActiveLyric(lyricsPage!, 'line-b-zero');

    await e2eLyricsHide(app, 'desktop');
    await waitForLyricsPage(app, 'desktop');
    lyricsPage = await e2eLyricsPage(app, 'desktop');
    await expectActiveLyric(lyricsPage!, 'line-b-zero');

    await lyricsPage!.locator('.lyrics-surface--desktop').hover({ position: { x: 40, y: 40 } });
    await expect(lyricsPage!.locator('.lyrics-surface--desktop')).toHaveAttribute(
      'data-interaction-state',
      'visible-interactive-hover',
    );
    await expect(lyricsPage!.locator('.lyrics-surface__controls .icon-button').first()).toBeVisible();
  });

  test('Lyrics Island hover stays expanded across the progress/control region', async () => {
    const { app, page } = session;
    await rendererInvoke(page, 'player_play').catch(() => undefined);
    await waitForLyricsPage(app, 'island');
    const island = await e2eLyricsPage(app, 'island');
    expect(island).toBeDefined();
    const surface = island!.locator('.lyrics-surface--island');
    await expect(surface).toBeVisible();
    await island!.waitForTimeout(150);
    const card = island!.locator('.island-card');
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    await card.hover({
      position: { x: Math.round((box?.width ?? 80) / 2), y: Math.max(8, Math.round((box?.height ?? 20) - 8)) },
    });
    await expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-hover');
    const states: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      states.push((await surface.getAttribute('data-interaction-state')) ?? '');
      await island!.waitForTimeout(60);
    }
    expect(new Set(states)).toEqual(new Set(['visible-interactive-hover']));
  });
});
