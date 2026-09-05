/// <reference lib="dom" />
import { expect, type Page } from '@playwright/test';

/** Real Android renderer/bridge branches, with the Core IPC boundary kept offline. */
export async function installAndroidFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const core = async () => {
      const bridgePath = '/packages/yaqmc-client/src/bridges/fake.ts';
      const fixturesPath = '/src/providers/fake/fixtures.ts';
      const [{ createFakeBridge }, { homeFeed }] = await Promise.all([
        import(/* @vite-ignore */ bridgePath),
        import(/* @vite-ignore */ fixturesPath),
      ]);
      return createFakeBridge({ catalog: { getHome: async () => homeFeed } });
    };
    let pending: ReturnType<typeof core> | undefined;
    const getCore = () => (pending ??= core());
    Reflect.set(window, 'yaqmc', {
      kind: 'android',
      platform: 'android',
      invoke: async (method: string, params: unknown) =>
        method === 'host.coreStatus'
          ? { status: 'ready' }
          : method === 'player_set_lyrics'
            ? null
            : (await getCore()).invoke(method, params),
      on: (channel: string, callback: (value: unknown) => void) => {
        let disposed = false;
        let stop: (() => void) | undefined;
        void getCore().then((bridge) => {
          if (!disposed) stop = bridge.listen(channel, callback);
        });
        return () => {
          disposed = true;
          stop?.();
        };
      },
    });
  });
}

export async function openAndroidFixture(page: Page): Promise<void> {
  await installAndroidFixture(page);
  await page.goto('/?provider=fake');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-host-kind', 'android');
}

/** Synthetic content is injected into existing stores only in the test runner. */
export async function loadLongPlayerContent(page: Page, synchronized = false): Promise<void> {
  await page.evaluate(
    async ({ synchronized }) => {
      const playerPath = '/src/application/player-store.ts';
      const lyricsPath = '/src/application/lyrics-store.ts';
      const { usePlayerStore } = await import(/* @vite-ignore */ playerPath);
      const { useLyricsStore } = await import(/* @vite-ignore */ lyricsPath);
      const state = usePlayerStore.getState();
      const original = state.queue[state.currentIndex];
      if (!original) throw new Error('Player fixture is not hydrated');
      const song = {
        ...original,
        title: 'An exceptionally long song title — 很长的歌曲名称用于检验横屏控件不能相互覆盖',
        artists: [{ ...original.artists[0], name: 'A long artist name 与另一位很长名字的创作者' }],
      };
      usePlayerStore.setState({ queue: [song], currentIndex: 0, positionMs: 0, isPlaying: false });
      useLyricsStore.setState({
        songId: song.id,
        status: 'ready',
        error: null,
        document: {
          songId: song.id,
          syncMode: synchronized ? 'line' : 'unsynchronized',
          metadata: { sourceLabel: 'Responsive regression fixture', offsetMs: 0 },
          vocalists: [],
          lines: Array.from({ length: 40 }, (_, index) => ({
            id: 'regression-' + index,
            text:
              index === 0
                ? 'First real lyric must remain visible'
                : 'Lyric ' + index + ' — 清晰可读的一行歌词',
            startMs: synchronized ? index * 5000 : null,
            endMs: synchronized ? (index + 1) * 5000 : null,
            words: [],
          })),
        },
      });
    },
    { synchronized },
  );
}
