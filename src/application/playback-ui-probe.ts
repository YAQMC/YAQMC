import { getYaqmcClient } from './yaqmc-runtime';
import { usePlayerStore } from './player-store';
import { usePreferencesStore } from './preferences';

export type CompositorProbeMode =
  | 'off'
  | 'no-backdrop'
  | 'no-artwork-blur'
  | 'no-line-blur'
  | 'no-filters'
  | 'no-progress-raf'
  | 'no-enter-artwork';

export interface PlaybackUiProbeSample {
  durationMs: number;
  rafFrames: number;
  rafFps: number;
  rafP95Ms: number;
  rafMaxMs: number;
  longTasks: number;
  storeUpdates: number;
  storeHz: number;
  positionUpdates: number;
  positionHz: number;
  snapshotRevision: number;
  playerBarMutations: number;
  playerBarMutationHz: number;
  ipcSnapshots: number;
  ipcSnapshotHz: number;
  compositorProbe: CompositorProbeMode;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  artworkFilter: string;
  artworkPreblurred: boolean;
  topbarBackdrop: string;
  inactiveLineFilter: string;
}

type ProbeHost = Window & {
  __YAQMC_PLAYBACK_UI_PROBE__?: {
    sample: (durationMs?: number) => Promise<PlaybackUiProbeSample>;
    sampleLyricsRouteTransition: (
      direction: 'open' | 'close',
    ) => Promise<PlaybackUiProbeSample>;
    setCompositorProbe: (mode: CompositorProbeMode) => void;
    enableArtworkBackground: () => void;
    enableFpsOverlay: () => void;
    enableLyricsSurface: (kind: 'desktop' | 'island') => void;
    makeArtwork: () => string;
  };
};

export function enableArtworkBackgroundProbe(): void {
  usePreferencesStore.getState().updateAppearance({
    backgroundMode: 'artwork',
    artworkInfluence: 80,
  });
}

export function enableFpsOverlayProbe(): void {
  usePreferencesStore.getState().updateDebug({ showFpsCounter: true });
}

export function enableLyricsSurfaceProbe(kind: 'desktop' | 'island'): void {
  usePreferencesStore.getState().updateSurface(kind, { enabled: true });
}

export function makeProbeArtworkDataUri(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas 2d missing');
  const gradient = context.createLinearGradient(0, 0, 1920, 1080);
  gradient.addColorStop(0, '#1b2414');
  gradient.addColorStop(0.45, '#6d8f3a');
  gradient.addColorStop(1, '#0c1008');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1920, 1080);
  for (let index = 0; index < 80; index += 1) {
    context.fillStyle = `rgba(255,255,255,${(index % 7) / 40})`;
    context.fillRect((index * 97) % 1920, (index * 53) % 1080, 220, 140);
  }
  return canvas.toDataURL('image/jpeg', 0.92);
}

const PROBE_MODES: readonly CompositorProbeMode[] = [
  'off',
  'no-backdrop',
  'no-artwork-blur',
  'no-line-blur',
  'no-filters',
  'no-progress-raf',
  'no-enter-artwork',
];

export function compositorProbeMode(): CompositorProbeMode {
  const value = document.documentElement.dataset.compositorProbe;
  return PROBE_MODES.find((mode) => mode === value) ?? 'off';
}

export function setCompositorProbe(mode: CompositorProbeMode): void {
  if (mode === 'off') {
    delete document.documentElement.dataset.compositorProbe;
    return;
  }
  document.documentElement.dataset.compositorProbe = mode;
}

export async function samplePlaybackUi(durationMs = 1_500): Promise<PlaybackUiProbeSample> {
  const client = getYaqmcClient();
  let storeUpdates = 0;
  let positionUpdates = 0;
  let lastPosition = usePlayerStore.getState().positionMs;
  let ipcSnapshots = 0;
  let longTasks = 0;
  const stopStore = usePlayerStore.subscribe((state) => {
    storeUpdates += 1;
    if (state.positionMs !== lastPosition) {
      positionUpdates += 1;
      lastPosition = state.positionMs;
    }
  });
  const stopIpc = client.on('player://snapshot', () => {
    ipcSnapshots += 1;
  });
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) longTasks += 1;
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      observer = null;
    }
  }
  const bar = document.querySelector('[data-yaqmc="player-bar"]');
  let playerBarMutations = 0;
  const mutationObserver =
    bar === null
      ? null
      : new MutationObserver((records) => {
          playerBarMutations += records.length;
        });
  mutationObserver?.observe(bar as Node, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  const frameTimes: number[] = [];
  const started = performance.now();
  let previous: number | null = null;
  let rafFrames = 0;
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      rafFrames += 1;
      if (previous !== null) frameTimes.push(now - previous);
      previous = now;
      if (now - started >= durationMs) {
        resolve();
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });

  mutationObserver?.disconnect();
  observer?.disconnect();
  stopStore();
  stopIpc();
  const elapsed = Math.max(1, performance.now() - started);
  const sorted = [...frameTimes].sort((left, right) => left - right);
  const perSecond = 1_000 / elapsed;
  const artwork = document.querySelector('.app-background__image');
  const topbar = document.querySelector('.topbar');
  const inactiveLine = document.querySelector('.lyrics-line:not([data-active])');
  return {
    durationMs: elapsed,
    rafFrames,
    rafFps: rafFrames * perSecond,
    rafP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    rafMaxMs: sorted[sorted.length - 1] ?? 0,
    longTasks,
    storeUpdates,
    storeHz: storeUpdates * perSecond,
    positionUpdates,
    positionHz: positionUpdates * perSecond,
    snapshotRevision: usePlayerStore.getState().snapshotRevision,
    playerBarMutations,
    playerBarMutationHz: playerBarMutations * perSecond,
    ipcSnapshots,
    ipcSnapshotHz: ipcSnapshots * perSecond,
    compositorProbe: compositorProbeMode(),
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    artworkFilter: artwork ? getComputedStyle(artwork).filter : '',
    artworkPreblurred: artwork instanceof HTMLElement && artwork.dataset.preblurred === 'true',
    topbarBackdrop: topbar ? getComputedStyle(topbar).backdropFilter : '',
    inactiveLineFilter: inactiveLine ? getComputedStyle(inactiveLine).filter : '',
  };
}

export async function sampleLyricsRouteTransition(
  direction: 'open' | 'close',
): Promise<PlaybackUiProbeSample> {
  const sampling = samplePlaybackUi(550);
  if (direction === 'open') usePlayerStore.getState().openLyrics();
  else usePlayerStore.getState().closePanels();
  return sampling;
}

export function installPlaybackUiProbe(): () => void {
  const host = window as ProbeHost;
  host.__YAQMC_PLAYBACK_UI_PROBE__ = {
    sample: samplePlaybackUi,
    sampleLyricsRouteTransition,
    setCompositorProbe,
    enableArtworkBackground: enableArtworkBackgroundProbe,
    enableFpsOverlay: enableFpsOverlayProbe,
    enableLyricsSurface: enableLyricsSurfaceProbe,
    makeArtwork: makeProbeArtworkDataUri,
  };
  return () => {
    delete host.__YAQMC_PLAYBACK_UI_PROBE__;
  };
}
