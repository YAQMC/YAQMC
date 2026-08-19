import { expect, test, type Page } from '@playwright/test';
import {
  e2eCoreStatus,
  e2eLyricsHide,
  e2eLyricsShow,
  launchElectronNativeWindow,
  resolveE2eCoreBin,
} from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();
const gpuRequested = process.env.YAQMC_E2E_GPU === '1';

function fixtureTrack(id: string, artworkSrc: string) {
  return {
    id,
    title: id,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', title: 'Album' },
    artwork: { src: artworkSrc, alt: 'Cover', dominantColor: '#334422' },
    durationMs: 120_000,
    trackNumber: 1,
    isFavorite: false,
    quality: 'standard' as const,
    availability: { status: 'available' as const },
  };
}

function lyricDocument(songId: string) {
  return {
    songId,
    syncMode: 'line' as const,
    metadata: { sourceLabel: 'gpu-probe', offsetMs: 0 },
    vocalists: [],
    lines: Array.from({ length: 36 }, (_, index) => ({
      id: `l${String(index)}`,
      startMs: index * 1_200,
      endMs: (index + 1) * 1_200,
      text: `probe-line-${String(index)} ${'lyric '.repeat(8)}`,
      words: [],
    })),
  };
}

async function rendererInvoke<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    async ({ methodName, payload }) => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke = yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke(methodName, payload) as Promise<T>;
    },
    { methodName: method, payload: params },
  );
}

async function probeCall<T>(
  page: Page,
  name:
    | 'sample'
    | 'setCompositorProbe'
    | 'enableArtworkBackground'
    | 'enableFpsOverlay'
    | 'enableLyricsSurface'
    | 'makeArtwork',
  arg?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ methodName, payload }) => {
      const probe = Reflect.get(globalThis, '__YAQMC_PLAYBACK_UI_PROBE__') as
        Record<string, (...args: unknown[]) => unknown> | undefined;
      const method = probe?.[methodName];
      if (typeof method !== 'function') {
        throw new Error('playback UI probe is missing');
      }
      return method(payload) as T;
    },
    { methodName: name, payload: arg },
  );
}

async function sampleGpu(page: Page, durationMs = 1_200) {
  return probeCall<Record<string, number | string>>(page, 'sample', durationMs);
}

test.describe('Windows GPU-on playback compositor probe', () => {
  test.skip(!gpuRequested, 'opt-in GPU-on probe; run with YAQMC_E2E_GPU=1');
  test.skip(!coreBin, 'yaqmc-core binary not found');
  test.setTimeout(240_000);

  let session: Awaited<ReturnType<typeof launchElectronNativeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronNativeWindow({ spawnCore: true, gpu: true });
  });

  test.afterAll(async () => {
    try {
      await e2eLyricsHide(session.app, 'desktop').catch(() => undefined);
      await e2eLyricsHide(session.app, 'island').catch(() => undefined);
      await session?.app.close();
    } catch {
      // already closed
    }
  });

  test('captures GPU-on FPS A/B for idle, playing, lyrics, and seek-drag', async () => {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');

    const gpu = await app.evaluate(async ({ app: electronApp }) => ({
      featureStatus: electronApp.getGPUFeatureStatus(),
      info: await electronApp.getGPUInfo('basic'),
    }));

    const artworkSrc = await probeCall<string>(page, 'makeArtwork');
    await probeCall(page, 'enableArtworkBackground');
    await probeCall(page, 'enableFpsOverlay');
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.maximize();
    });
    await rendererInvoke(page, 'player_pause').catch(() => undefined);
    const idle = await sampleGpu(page, 1_000);

    await rendererInvoke(page, 'player_play_tracks', {
      request: {
        tracks: [fixtureTrack('gpu-clock', artworkSrc), fixtureTrack('gpu-clock-b', artworkSrc)],
        shuffle: false,
      },
    });
    await rendererInvoke(page, 'player_play');
    await expect
      .poll(async () => rendererInvoke<{ isPlaying?: boolean }>(page, 'player_snapshot'), {
        timeout: 12_000,
      })
      .toEqual(expect.objectContaining({ isPlaying: true }));

    const playingDefault = await sampleGpu(page, 1_200);
    const ab: Record<string, Record<string, number | string>> = {};
    for (const mode of [
      'no-backdrop',
      'no-artwork-blur',
      'no-filters',
      'no-progress-raf',
    ] as const) {
      await probeCall(page, 'setCompositorProbe', mode);
      ab[mode] = await sampleGpu(page, 1_000);
    }
    await probeCall(page, 'setCompositorProbe', 'off');

    const progress = page.getByRole('slider', { name: 'Playback position' });
    const box = await progress.boundingBox();
    expect(box).not.toBeNull();
    const sampleDrag = sampleGpu(page, 1_200);
    await page.mouse.move((box?.x ?? 0) + 24, (box?.y ?? 0) + Math.round((box?.height ?? 8) / 2));
    await page.mouse.down();
    for (let index = 0; index < 24; index += 1) {
      await page.mouse.move(
        (box?.x ?? 0) + 24 + (index % 12) * 18,
        (box?.y ?? 0) + Math.round((box?.height ?? 8) / 2),
      );
    }
    const seekDrag = await sampleDrag;
    await page.mouse.up();

    await rendererInvoke(page, 'player_set_lyrics', { document: lyricDocument('gpu-clock') });
    await page.getByRole('button', { name: 'Open lyrics page' }).click();
    await expect(page.locator('.lyrics-stage')).toBeVisible({ timeout: 8_000 });
    const lyricsWindowed = await sampleGpu(page, 1_000);
    await page.keyboard.press('F11');
    await expect(page.locator('.lyrics-stage[data-fullscreen]')).toBeVisible({ timeout: 8_000 });
    const fullscreen = await sampleGpu(page, 1_200);
    await probeCall(page, 'setCompositorProbe', 'no-line-blur');
    const fullscreenNoLineBlur = await sampleGpu(page, 1_000);
    await probeCall(page, 'setCompositorProbe', 'no-filters');
    const fullscreenNoFilters = await sampleGpu(page, 1_000);
    await probeCall(page, 'setCompositorProbe', 'off');
    await page.keyboard.press('Escape');

    await e2eLyricsShow(app, 'desktop');
    const desktop = await sampleGpu(page, 1_000);
    await e2eLyricsShow(app, 'island');
    const desktopAndIsland = await sampleGpu(page, 1_000);

    const report = {
      probe: 'windows-gpu-on',
      gpuDisabledEnv: process.env.ELECTRON_DISABLE_GPU ?? null,
      gpu,
      idle,
      playingDefault,
      ab,
      seekDrag,
      lyricsWindowed,
      fullscreen,
      fullscreenNoLineBlur,
      fullscreenNoFilters,
      desktop,
      desktopAndIsland,
    };
    console.log(JSON.stringify(report));
    expect(idle.rafFps).toBeGreaterThan(20);
    expect(playingDefault.rafFps).toBeGreaterThan(1);
  });
});
