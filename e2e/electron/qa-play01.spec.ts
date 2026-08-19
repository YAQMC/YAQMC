import { expect, test, type Page } from '@playwright/test';
import {
  e2eCoreStatus,
  e2eLyricsBounds,
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

type Snapshot = {
  queue?: Array<{ id?: string }>;
  currentIndex?: number | null;
  positionMs?: number;
  isPlaying?: boolean;
  isMuted?: boolean;
  volume?: number;
  repeat?: string;
  shuffle?: boolean;
  sessionId?: number;
  snapshotRevision?: number;
  lastSeekRevision?: number;
  sampledAtMs?: number;
  playbackState?: string;
};

function trackId(snapshot: Snapshot): string {
  const index = snapshot.currentIndex ?? 0;
  return snapshot.queue?.[index]?.id ?? '';
}

test.describe('PLAY-01 native renderer + production Core', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(180_000);

  let session: Awaited<ReturnType<typeof launchElectronNativeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronNativeWindow({ spawnCore: true });
  });

  test.afterAll(async () => {
    try {
      await session?.app.close();
    } catch {
      // already closed
    }
  });

  test('play/pause/next/previous/volume/mute/repeat/shuffle/seek through window.yaqmc', async () => {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    expect(page.url()).not.toMatch(/[?&]provider=fake/);
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');

    await rendererInvoke(page, 'player_play_tracks', {
      request: {
        tracks: [fixtureTrack('ui-a', 8_000), fixtureTrack('ui-b', 8_000)],
        shuffle: false,
      },
    });
    const playStarted = Date.now();
    await rendererInvoke(page, 'player_play');
    await expect
      .poll(async () => rendererInvoke<Snapshot>(page, 'player_snapshot'), { timeout: 12_000 })
      .toEqual(expect.objectContaining({ isPlaying: true }));
    const playing = await rendererInvoke<Snapshot>(page, 'player_snapshot');
    expect(trackId(playing)).toBe('ui-a');
    expect(playing.sessionId).toBeGreaterThan(0);
    expect(playing.sampledAtMs).toBeGreaterThan(0);

    await rendererInvoke(page, 'player_pause');
    await expect
      .poll(async () => rendererInvoke<Snapshot>(page, 'player_snapshot'), { timeout: 8_000 })
      .toEqual(expect.objectContaining({ isPlaying: false }));

    await rendererInvoke(page, 'player_play');
    await rendererInvoke(page, 'player_set_volume', { volume: 0.37 });
    const volume = await rendererInvoke<Snapshot>(page, 'player_snapshot');
    expect(Math.abs((volume.volume ?? 0) - 0.37)).toBeLessThan(0.05);

    const mutedBefore = volume.isMuted === true;
    await rendererInvoke(page, 'player_toggle_muted');
    const muted = await rendererInvoke<Snapshot>(page, 'player_snapshot');
    expect(muted.isMuted).toBe(!mutedBefore);
    await rendererInvoke(page, 'player_toggle_muted');

    await rendererInvoke(page, 'player_set_repeat', { mode: 'one' });
    expect((await rendererInvoke<Snapshot>(page, 'player_snapshot')).repeat).toBe('one');
    await rendererInvoke(page, 'player_set_repeat', { mode: 'all' });
    await rendererInvoke(page, 'player_set_repeat', { mode: 'off' });

    await rendererInvoke(page, 'player_next');
    await expect
      .poll(async () => trackId(await rendererInvoke<Snapshot>(page, 'player_snapshot')), {
        timeout: 8_000,
      })
      .toBe('ui-b');
    await rendererInvoke(page, 'player_previous');
    await expect
      .poll(async () => trackId(await rendererInvoke<Snapshot>(page, 'player_snapshot')), {
        timeout: 8_000,
      })
      .toBe('ui-a');

    await rendererInvoke(page, 'player_set_shuffle', { enabled: true });
    expect((await rendererInvoke<Snapshot>(page, 'player_snapshot')).shuffle).toBe(true);
    await rendererInvoke(page, 'player_set_shuffle', { enabled: false });

    const seekIntent = Date.now();
    await rendererInvoke(page, 'player_seek', { positionMs: 1_800 });
    await expect
      .poll(
        async () => {
          const snap = await rendererInvoke<Snapshot>(page, 'player_snapshot');
          return Math.abs((snap.positionMs ?? 0) - 1_800) <= 250;
        },
        { timeout: 6_000 },
      )
      .toBe(true);
    const seekMs = Date.now() - seekIntent;
    const afterSeek = await rendererInvoke<Snapshot>(page, 'player_snapshot');
    expect(Math.abs((afterSeek.positionMs ?? 0) - 1_800)).toBeLessThanOrEqual(250);
    expect((afterSeek.lastSeekRevision ?? 0) > 0 || (afterSeek.snapshotRevision ?? 0) > 0).toBe(
      true,
    );
    expect(seekMs).toBeGreaterThan(0);
    expect(playStarted).toBeGreaterThan(0);
  });

  test('lyrics surfaces open against the live player clock', async () => {
    const { app, page } = session;
    await expect.poll(() => e2eCoreStatus(app), { timeout: 30_000 }).toBe('ready');
    await rendererInvoke(page, 'player_set_lyrics', {
      document: {
        songId: 'ui-a',
        syncMode: 'line',
        metadata: { sourceLabel: 'qa', offsetMs: 0 },
        vocalists: [],
        lines: [
          { id: 'l0', startMs: 0, endMs: 900, text: 'line-zero', words: [] },
          { id: 'l1', startMs: 900, endMs: 2_000, text: 'line-one', words: [] },
        ],
      },
    });
    await rendererInvoke(page, 'player_seek', { positionMs: 200 });
    const early = await rendererInvoke<{ lineIndex?: number; timestampMs?: number }>(
      page,
      'lyrics_surface_projection',
    );
    expect(early.lineIndex).toBe(0);

    for (const kind of ['desktop', 'island'] as E2eLyricsKind[]) {
      await e2eLyricsShow(app, kind);
      await expect.poll(async () => e2eLyricsBounds(app, kind), { timeout: 15_000 }).not.toBeNull();
    }

    await rendererInvoke(page, 'player_seek', { positionMs: 1_200 });
    await expect
      .poll(async () => rendererInvoke<{ lineIndex?: number }>(page, 'lyrics_surface_projection'), {
        timeout: 6_000,
      })
      .toEqual(expect.objectContaining({ lineIndex: 1 }));
  });

  test('window chrome and diagnostics export stay on the native renderer path', async () => {
    const { page } = session;
    const logDir = await rendererInvoke<string>(page, 'diagnostics_open_log_folder');
    expect(logDir.toLowerCase()).toContain('logs');
    await rendererInvoke(page, 'window.minimize');
    await session.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.restore();
    });
  });

  test('PLAT-06 repository LIVE script against this Core', async () => {
    const { page } = session;
    const port = 19_592;
    await rendererInvoke(page, 'local_api_set_port', { port });
    const status = await rendererInvoke<{ state?: string; enabled?: boolean }>(
      page,
      'local_api_set_enabled',
      { enabled: true },
    );
    expect(status.enabled).toBe(true);
    const token = await rendererInvoke<string>(page, 'local_api_reveal_token');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(8);
    const { spawnSync } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const script = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../scripts/migration/plat06-local-api-sse.mjs',
    );
    const result = spawnSync(process.execPath, [script, '--events', '3', '--timeout', '8000'], {
      env: {
        ...process.env,
        YAQMC_API_HOST: '127.0.0.1',
        YAQMC_API_PORT: String(port),
        YAQMC_API_TOKEN: token,
      },
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('"ok"');
    expect(result.stdout).not.toContain(token);
  });
});
