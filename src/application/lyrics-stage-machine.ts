import { create } from 'zustand';

export type LyricsStageState = 'closed' | 'entering' | 'open' | 'exiting';

export const LYRICS_STAGE_ENTER_ANIMATION = 'lyrics-stage-enter';
export const LYRICS_STAGE_EXIT_ANIMATION = 'lyrics-stage-exit';
export const LYRICS_STAGE_TRANSITION_MS = 500;

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

function prefersReducedMotion(): boolean {
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

export function waitForLyricsStageClosed(
  timeoutMs = LYRICS_STAGE_TRANSITION_MS + 250,
): Promise<void> {
  if (useLyricsStageStore.getState().stage === 'closed') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(() => {
      useLyricsStageStore.getState().forceClosed();
      finish();
    }, timeoutMs);
    unsubscribe = useLyricsStageStore.subscribe((state) => {
      if (state.stage === 'closed') finish();
    });
  });
}
