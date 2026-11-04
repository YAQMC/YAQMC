import { create } from 'zustand';

export type LyricsStageState = 'closed' | 'entering' | 'open' | 'exiting';

export const LYRICS_STAGE_ENTER_ANIMATION = 'lyrics-stage-enter';
export const LYRICS_STAGE_EXIT_ANIMATION = 'lyrics-stage-exit';
export const LYRICS_STAGE_TRANSITION_MS = 500;
/** Must match the easing of the `.lyrics-stage` enter/exit rules in styles/components.css. */
export const LYRICS_STAGE_ENTER_EASING = [0.2, 0, 0, 1] as const;
export const LYRICS_STAGE_EXIT_EASING = [0.7, 0, 0.3, 1] as const;

type Bezier = readonly [number, number, number, number];

function bezierAxis(p1: number, p2: number, s: number): number {
  const inverse = 1 - s;
  return 3 * inverse * inverse * s * p1 + 3 * inverse * s * s * p2 + s * s * s;
}

/** Time fraction at which a monotonic CSS cubic-bezier easing reaches `progress`. */
export function easingTimeForProgress([x1, y1, x2, y2]: Bezier, progress: number): number {
  const target = Math.min(1, Math.max(0, progress));
  let low = 0;
  let high = 1;
  for (let step = 0; step < 32; step += 1) {
    const mid = (low + high) / 2;
    if (bezierAxis(y1, y2, mid) < target) low = mid;
    else high = mid;
  }
  return bezierAxis(x1, x2, (low + high) / 2);
}

/**
 * Elapsed time to start a stage keyframe at, so an interrupted transition continues from where
 * the stage currently is instead of snapping to the keyframe's first frame.
 * `hiddenFraction` is 0 when fully open and 1 when fully below the viewport.
 */
export function lyricsStageResumeElapsedMs(
  direction: 'entering' | 'exiting',
  hiddenFraction: number | null,
): number {
  if (hiddenFraction === null || !Number.isFinite(hiddenFraction)) return 0;
  const progress = direction === 'entering' ? 1 - hiddenFraction : hiddenFraction;
  const easing = direction === 'entering' ? LYRICS_STAGE_ENTER_EASING : LYRICS_STAGE_EXIT_EASING;
  return Math.round(easingTimeForProgress(easing, progress) * LYRICS_STAGE_TRANSITION_MS);
}

interface LyricsStageMachine {
  stage: LyricsStageState;
  generation: number;
  surfaceCount: number;
  requestOpen: () => void;
  requestClose: () => void;
  notifyTransitionFinished: (animationName: string, generation?: number) => void;
  registerSurface: () => () => void;
  forceClosed: () => void;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export const useLyricsStageStore = create<LyricsStageMachine>((set, get) => ({
  stage: 'closed',
  generation: 0,
  surfaceCount: 0,
  requestOpen: () => {
    const { stage } = get();
    if (stage === 'open' || stage === 'entering') return;
    const generation = get().generation + 1;
    if (prefersReducedMotion()) {
      set({ stage: 'open', generation });
      return;
    }
    set({ stage: 'entering', generation });
  },
  requestClose: () => {
    const { stage, surfaceCount } = get();
    if (stage === 'closed' || stage === 'exiting') return;
    const generation = get().generation + 1;
    if (prefersReducedMotion() || surfaceCount === 0) {
      set({ stage: 'closed', generation });
      return;
    }
    set({ stage: 'exiting', generation });
  },
  notifyTransitionFinished: (animationName, generation) => {
    const current = get();
    if (generation !== undefined && generation !== current.generation) return;
    if (animationName === LYRICS_STAGE_ENTER_ANIMATION && current.stage === 'entering') {
      set({ stage: 'open' });
    }
    if (animationName === LYRICS_STAGE_EXIT_ANIMATION && current.stage === 'exiting') {
      set({ stage: 'closed' });
    }
  },
  registerSurface: () => {
    set((state) => ({ surfaceCount: state.surfaceCount + 1 }));
    return () => set((state) => ({ surfaceCount: Math.max(0, state.surfaceCount - 1) }));
  },
  forceClosed: () => set({ stage: 'closed', generation: get().generation + 1 }),
}));

export function resetLyricsStageForTests(): void {
  useLyricsStageStore.setState({ stage: 'closed', generation: 0, surfaceCount: 0 });
}

/**
 * Resolves `true` once the stage is closed, or `false` if a reopen superseded the close.
 * The watchdog only forces `closed` while an exit is still in flight (a lost animationend);
 * it never tears down a stage the user has reopened.
 */
export function waitForLyricsStageClosed(
  timeoutMs = LYRICS_STAGE_TRANSITION_MS + 250,
): Promise<boolean> {
  const initial = useLyricsStageStore.getState().stage;
  if (initial === 'closed') return Promise.resolve(true);
  if (initial !== 'exiting') return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(closed);
    };
    const timer = setTimeout(() => {
      if (useLyricsStageStore.getState().stage !== 'exiting') return finish(false);
      useLyricsStageStore.getState().forceClosed();
      finish(true);
    }, timeoutMs);
    unsubscribe = useLyricsStageStore.subscribe((state) => {
      if (state.stage === 'closed') finish(true);
      else if (state.stage === 'entering' || state.stage === 'open') finish(false);
    });
  });
}
