import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  easingTimeForProgress,
  LYRICS_STAGE_ENTER_EASING,
  LYRICS_STAGE_EXIT_EASING,
  LYRICS_STAGE_TRANSITION_MS,
  lyricsStageResumeElapsedMs,
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
    await expect(waitForLyricsStageClosed()).resolves.toBe(true);
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

  it('reports a reopen during exit as a superseded close without forcing the stage closed', async () => {
    vi.useFakeTimers();
    try {
      useLyricsStageStore.getState().registerSurface();
      useLyricsStageStore.getState().requestOpen();
      useLyricsStageStore.getState().notifyTransitionFinished(LYRICS_STAGE_ENTER_ANIMATION);
      useLyricsStageStore.getState().requestClose();
      const closed = waitForLyricsStageClosed();

      useLyricsStageStore.getState().requestOpen();
      await vi.advanceTimersByTimeAsync(LYRICS_STAGE_TRANSITION_MS * 4);

      await expect(closed).resolves.toBe(false);
      expect(useLyricsStageStore.getState().stage).toBe('entering');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forces closed only when an exit never reports completion', async () => {
    vi.useFakeTimers();
    try {
      useLyricsStageStore.getState().registerSurface();
      useLyricsStageStore.getState().requestOpen();
      useLyricsStageStore.getState().notifyTransitionFinished(LYRICS_STAGE_ENTER_ANIMATION);
      useLyricsStageStore.getState().requestClose();
      const closed = waitForLyricsStageClosed();

      await vi.advanceTimersByTimeAsync(LYRICS_STAGE_TRANSITION_MS + 250);

      await expect(closed).resolves.toBe(true);
      expect(useLyricsStageStore.getState().stage).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('lyrics stage resume timing', () => {
  it('inverts the CSS easing at both ends and stays monotonic', () => {
    for (const easing of [LYRICS_STAGE_ENTER_EASING, LYRICS_STAGE_EXIT_EASING]) {
      expect(easingTimeForProgress(easing, 0)).toBeCloseTo(0, 3);
      expect(easingTimeForProgress(easing, 1)).toBeCloseTo(1, 3);
      let previous = 0;
      for (let progress = 0.1; progress <= 1; progress += 0.1) {
        const time = easingTimeForProgress(easing, progress);
        expect(time).toBeGreaterThanOrEqual(previous);
        previous = time;
      }
    }
    // Symmetric ease-in-out passes its midpoint at half time.
    expect(easingTimeForProgress(LYRICS_STAGE_EXIT_EASING, 0.5)).toBeCloseTo(0.5, 3);
  });

  it('starts a fresh transition at zero and resumes an interrupted one from its position', () => {
    expect(lyricsStageResumeElapsedMs('entering', null)).toBe(0);
    expect(lyricsStageResumeElapsedMs('exiting', null)).toBe(0);
    // Fully hidden means an enter has not progressed; fully open means an exit has not.
    expect(lyricsStageResumeElapsedMs('entering', 1)).toBe(0);
    expect(lyricsStageResumeElapsedMs('exiting', 0)).toBe(0);
    expect(lyricsStageResumeElapsedMs('exiting', 0.5)).toBe(LYRICS_STAGE_TRANSITION_MS / 2);
    const halfwayEnter = lyricsStageResumeElapsedMs('entering', 0.5);
    // The decelerating enter covers its first half early.
    expect(halfwayEnter).toBeGreaterThan(0);
    expect(halfwayEnter).toBeLessThan(LYRICS_STAGE_TRANSITION_MS / 2);
  });
});
