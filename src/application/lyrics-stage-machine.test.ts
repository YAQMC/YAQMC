import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LYRICS_STAGE_ENTER_ANIMATION,
  LYRICS_STAGE_EXIT_ANIMATION,
  resetLyricsStageForTests,
  useLyricsStageStore,
  waitForLyricsStageClosed,
} from './lyrics-stage-machine';

describe('lyrics stage machine', () => {
  let reducedMotion = false;

  beforeEach(() => {
    resetLyricsStageForTests();
    reducedMotion = false;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(
        () =>
          ({
            matches: reducedMotion,
            media: '(prefers-reduced-motion: reduce)',
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
          }) as unknown as MediaQueryList,
      ),
    );
  });

  afterEach(() => {
    resetLyricsStageForTests();
    vi.unstubAllGlobals();
  });

  it('opens through entering then open, and closes through exiting then closed', () => {
    const unregister = useLyricsStageStore.getState().registerSurface();
    useLyricsStageStore.getState().requestOpen();
    expect(useLyricsStageStore.getState().stage).toBe('entering');

    useLyricsStageStore.getState().notifyTransitionFinished(LYRICS_STAGE_ENTER_ANIMATION);
    expect(useLyricsStageStore.getState().stage).toBe('open');

    useLyricsStageStore.getState().requestClose();
    expect(useLyricsStageStore.getState().stage).toBe('exiting');

    useLyricsStageStore.getState().notifyTransitionFinished(LYRICS_STAGE_EXIT_ANIMATION);
    expect(useLyricsStageStore.getState().stage).toBe('closed');
    unregister();
  });

  it('closes immediately when no surface is mounted', async () => {
    useLyricsStageStore.setState({ stage: 'open', surfaceCount: 0 });
    useLyricsStageStore.getState().requestClose();
    expect(useLyricsStageStore.getState().stage).toBe('closed');
    await expect(waitForLyricsStageClosed()).resolves.toBeUndefined();
  });

  it('skips both directions when reduced motion is requested', () => {
    reducedMotion = true;
    useLyricsStageStore.getState().registerSurface();
    useLyricsStageStore.getState().requestOpen();
    expect(useLyricsStageStore.getState().stage).toBe('open');
    useLyricsStageStore.getState().requestClose();
    expect(useLyricsStageStore.getState().stage).toBe('closed');
  });

  it('reverses an in-flight enter into exit without a second machine', () => {
    useLyricsStageStore.getState().registerSurface();
    useLyricsStageStore.getState().requestOpen();
    expect(useLyricsStageStore.getState().stage).toBe('entering');
    useLyricsStageStore.getState().requestClose();
    expect(useLyricsStageStore.getState().stage).toBe('exiting');
  });

  it('ignores a stale enter completion after close has started a newer generation', () => {
    useLyricsStageStore.getState().registerSurface();
    useLyricsStageStore.getState().requestOpen();
    const enterGeneration = useLyricsStageStore.getState().generation;
    useLyricsStageStore.getState().requestClose();
    useLyricsStageStore
      .getState()
      .notifyTransitionFinished(LYRICS_STAGE_ENTER_ANIMATION, enterGeneration);
    expect(useLyricsStageStore.getState().stage).toBe('exiting');
  });

  it('does not start a second exit generation while already exiting', () => {
    useLyricsStageStore.getState().registerSurface();
    useLyricsStageStore.getState().requestOpen();
    useLyricsStageStore.getState().notifyTransitionFinished(LYRICS_STAGE_ENTER_ANIMATION);
    useLyricsStageStore.getState().requestClose();
    const generation = useLyricsStageStore.getState().generation;
    useLyricsStageStore.getState().requestClose();
    expect(useLyricsStageStore.getState()).toMatchObject({ stage: 'exiting', generation });
  });

  it('reopens from exiting on the same machine without a second store', () => {
    useLyricsStageStore.getState().registerSurface();
    useLyricsStageStore.getState().requestOpen();
    useLyricsStageStore.getState().notifyTransitionFinished(LYRICS_STAGE_ENTER_ANIMATION);
    useLyricsStageStore.getState().requestClose();
    useLyricsStageStore.getState().requestOpen();
    expect(useLyricsStageStore.getState().stage).toBe('entering');
  });
});
