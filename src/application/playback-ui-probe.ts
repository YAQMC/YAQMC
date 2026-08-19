import { getYaqmcClient } from './yaqmc-runtime';
import { getEstimatedPositionMs, usePlayerStore } from './player-store';
import { usePreferencesStore } from './preferences';
import { useLyricsStageStore } from './lyrics-stage-machine';
import { lyricsPerfCounters } from './lyrics-perf-counters';

export type CompositorProbeMode =
  | 'off'
  | 'no-backdrop'
  | 'no-artwork-blur'
  | 'no-line-blur'
  | 'no-filters'
  | 'no-progress-raf'
  | 'no-enter-artwork';

export interface LyricsCompositorInspect {
  platform: string | null;
  graphicsMode: string | null;
  coverLayout: string | null;
  lyricsOpen: boolean;
  isPlaying: boolean;
  timelineRevision: number;
  snapshotRevision: number;
  stageWillChange: string;
  stageTransform: string;
  stageAnimation: string;
  scenePlaybackState: string | null;
  sceneProgress: string;
  sceneContainerType: string;
  backdropTransform: string;
  backdropFilter: string;
  backdropWillChange: string;
  discPresent: boolean;
  discPlaying: boolean;
  discAnimation: string;
  discPlayState: string;
  discTransform: string;
  discWillChange: string;
  discFilter: string;
  discBoxShadow: string;
  viewportBeforeBackdrop: string;
  activeLineFilter: string;
  inactiveLineFilter: string;
  cssAnimationCount: number;
  cssRunningCount: number;
  lyricsStage: string;
  lyricsGeneration: number;
  positionMs: number;
}

export interface PlaybackUiProbeSample {
  durationMs: number;
  rafFrames: number;
  rafFps: number;
  rafP50Ms: number;
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
  lyricsMutations: number;
  lyricsMutationHz: number;
  ipcSnapshots: number;
  ipcSnapshotHz: number;
  compositorProbe: CompositorProbeMode;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  artworkFilter: string;
  artworkPreblurred: boolean;
  topbarBackdrop: string;
  inactiveLineFilter: string;
  lyrics: LyricsCompositorInspect;
  rafStuck: boolean;
  wallClockTimedOut: boolean;
}

export interface LyricsHangInspect {
  at: number;
  href: string;
  route: string | null;
  probePhase: string;
  lyricsOpen: boolean;
  lyricsStage: string;
  lyricsGeneration: number;
  isPlaying: boolean;
  positionMs: number;
  snapshotRevision: number;
  timelineRevision: number;
  lastRafAt: number;
  rafAgeMs: number;
  panelCommits: number;
  lastPanelCommitAgeMs: number;
  longTasks: number;
  interpolation: {
    activeLine: string | null;
    sceneProgress: string;
    wordProgress: string;
    scenePlaybackState: string | null;
  };
  cssAnimations: Array<{ name: string; playState: string }>;
  lyrics: LyricsCompositorInspect;
  errors: string[];
}

type ProbeHost = Window & {
  __YAQMC_PLAYBACK_UI_PROBE__?: {
    sample: (durationMs?: number) => Promise<PlaybackUiProbeSample>;
    sampleLyricsRouteTransition: (
      direction: 'open' | 'close',
    ) => Promise<PlaybackUiProbeSample>;
    inspectLyricsCompositor: () => LyricsCompositorInspect;
    inspectHang: () => LyricsHangInspect;
    openLyrics: () => void;
    closeLyrics: () => void;
    ping: () => { at: number; rafAgeMs: number };
    selectLyricsPreset: (id: string) => void;
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

export function selectLyricsPresetProbe(id: string): void {
  usePreferencesStore.getState().selectLyricsPreset(id);
}

export function inspectLyricsCompositor(): LyricsCompositorInspect {
  const stage = document.querySelector('.lyrics-stage');
  const scene = document.querySelector('.lyrics-scene');
  const backdrop = document.querySelector('.lyrics-stage__backdrop');
  const disc = document.querySelector('.lyrics-stage__disc-spin') ?? document.querySelector('.lyrics-stage__disc');
  const viewport = document.querySelector('.lyrics-stage__viewport');
  const activeLine = document.querySelector('.lyrics-line[data-active]');
  const inactiveLine = document.querySelector('.lyrics-line:not([data-active])');
  const animations = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
  const stageStyle = stage ? getComputedStyle(stage) : null;
  const sceneStyle = scene ? getComputedStyle(scene) : null;
  const backdropStyle = backdrop ? getComputedStyle(backdrop) : null;
  const discStyle = disc ? getComputedStyle(disc) : null;
  const player = usePlayerStore.getState();
  return {
    platform: document.documentElement.getAttribute('data-platform'),
    graphicsMode: document.documentElement.getAttribute('data-graphics-mode'),
    coverLayout: stage?.getAttribute('data-cover-layout') ?? scene?.getAttribute('data-cover-layout') ?? null,
    lyricsOpen: player.lyricsOpen,
    isPlaying: player.isPlaying,
    timelineRevision: player.timelineRevision,
    snapshotRevision: player.snapshotRevision,
    stageWillChange: stageStyle?.willChange ?? '',
    stageTransform: stageStyle?.transform ?? '',
    stageAnimation: stageStyle?.animationName ?? '',
    scenePlaybackState: scene instanceof HTMLElement ? scene.dataset.playbackState ?? null : null,
    sceneProgress: sceneStyle?.getPropertyValue('--scene-progress') ?? '',
    sceneContainerType: sceneStyle?.containerType ?? '',
    backdropTransform: backdropStyle?.transform ?? '',
    backdropFilter: backdropStyle?.filter ?? '',
    backdropWillChange: backdropStyle?.willChange ?? '',
    discPresent: disc !== null,
    discPlaying: disc instanceof HTMLElement && disc.hasAttribute('data-playing'),
    discAnimation: discStyle?.animationName ?? '',
    discPlayState: discStyle?.animationPlayState ?? '',
    discTransform: discStyle?.transform ?? '',
    discWillChange: discStyle?.willChange ?? '',
    discFilter: discStyle?.filter ?? '',
    discBoxShadow: discStyle?.boxShadow ?? '',
    viewportBeforeBackdrop: viewport ? getComputedStyle(viewport, '::before').backdropFilter : '',
    activeLineFilter: activeLine ? getComputedStyle(activeLine).filter : '',
    inactiveLineFilter: inactiveLine ? getComputedStyle(inactiveLine).filter : '',
    cssAnimationCount: animations.length,
    cssRunningCount: animations.filter((animation) => animation.playState === 'running').length,
    lyricsStage: useLyricsStageStore.getState().stage,
    lyricsGeneration: useLyricsStageStore.getState().generation,
    positionMs: getEstimatedPositionMs(),
  };
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

let lastRafAt = 0;
let rafHeartbeat = 0;
const probeErrors: string[] = [];

function rafAgeMs(now = performance.now()): number {
  return lastRafAt === 0 ? -1 : now - lastRafAt;
}

function startRafHeartbeat(): () => void {
  const beat = (now: number) => {
    lastRafAt = now;
    rafHeartbeat = window.requestAnimationFrame(beat);
  };
  rafHeartbeat = window.requestAnimationFrame(beat);
  return () => window.cancelAnimationFrame(rafHeartbeat);
}

function noteProbeError(message: string): void {
  probeErrors.push(message);
  if (probeErrors.length > 40) probeErrors.splice(0, probeErrors.length - 40);
}

function animationNameOf(animation: Animation): string {
  if ('animationName' in animation && typeof animation.animationName === 'string') {
    return animation.animationName;
  }
  return animation.id || animation.constructor.name;
}

export function inspectHang(): LyricsHangInspect {
  const now = performance.now();
  const player = usePlayerStore.getState();
  const stage = useLyricsStageStore.getState();
  const scene = document.querySelector('.lyrics-scene');
  const activeLine = document.querySelector('.lyrics-line[data-active]');
  const animations =
    typeof document.getAnimations === 'function'
      ? document.getAnimations().slice(0, 24).map((animation) => ({
          name: animationNameOf(animation),
          playState: animation.playState,
        }))
      : [];
  let longTasks = 0;
  try {
    longTasks = performance.getEntriesByType('longtask').filter((entry) => entry.duration >= 50).length;
  } catch {
    longTasks = -1;
  }
  return {
    at: now,
    href: window.location.href,
    route: document.querySelector('[data-testid="active-route"]')?.textContent ?? null,
    probePhase: document.documentElement.dataset.probePhase ?? '',
    lyricsOpen: player.lyricsOpen,
    lyricsStage: stage.stage,
    lyricsGeneration: stage.generation,
    isPlaying: player.isPlaying,
    positionMs: getEstimatedPositionMs(),
    snapshotRevision: player.snapshotRevision,
    timelineRevision: player.timelineRevision,
    lastRafAt,
    rafAgeMs: rafAgeMs(now),
    panelCommits: lyricsPerfCounters.panelCommits,
    lastPanelCommitAgeMs:
      lyricsPerfCounters.lastPanelCommitAt === 0 ? -1 : now - lyricsPerfCounters.lastPanelCommitAt,
    longTasks,
    interpolation: {
      activeLine: activeLine?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null,
      sceneProgress:
        scene instanceof HTMLElement ? getComputedStyle(scene).getPropertyValue('--scene-progress') : '',
      wordProgress:
        activeLine instanceof HTMLElement
          ? getComputedStyle(activeLine).getPropertyValue('--word-progress')
          : '',
      scenePlaybackState: scene instanceof HTMLElement ? scene.dataset.playbackState ?? null : null,
    },
    cssAnimations: animations,
    lyrics: inspectLyricsCompositor(),
    errors: [...probeErrors],
  };
}

export function pingPlaybackUiProbe(): { at: number; rafAgeMs: number; href: string; phase: string } {
  return {
    at: performance.now(),
    rafAgeMs: rafAgeMs(),
    href: window.location.href,
    phase: document.documentElement.dataset.probePhase ?? '',
  };
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
  const lyricsRoot = document.querySelector('.lyrics-stage') ?? document.querySelector('.lyrics-scene');
  let playerBarMutations = 0;
  let lyricsMutations = 0;
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
  const lyricsObserver =
    lyricsRoot === null
      ? null
      : new MutationObserver((records) => {
          lyricsMutations += records.length;
        });
  lyricsObserver?.observe(lyricsRoot as Node, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  const frameTimes: number[] = [];
  const started = performance.now();
  let previous: number | null = null;
  let rafFrames = 0;
  let wallClockTimedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      wallClockTimedOut = timedOut;
      resolve();
    };
    const wall = window.setTimeout(() => finish(true), durationMs + 250);
    const tick = (now: number) => {
      if (settled) return;
      lastRafAt = now;
      rafFrames += 1;
      if (previous !== null) frameTimes.push(now - previous);
      previous = now;
      if (now - started >= durationMs) {
        window.clearTimeout(wall);
        finish(false);
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });

  mutationObserver?.disconnect();
  lyricsObserver?.disconnect();
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
    rafP50Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] ?? 0,
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
    lyricsMutations,
    lyricsMutationHz: lyricsMutations * perSecond,
    ipcSnapshots,
    ipcSnapshotHz: ipcSnapshots * perSecond,
    compositorProbe: compositorProbeMode(),
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    artworkFilter: artwork ? getComputedStyle(artwork).filter : '',
    artworkPreblurred: artwork instanceof HTMLElement && artwork.dataset.preblurred === 'true',
    topbarBackdrop: topbar ? getComputedStyle(topbar).backdropFilter : '',
    inactiveLineFilter: inactiveLine ? getComputedStyle(inactiveLine).filter : '',
    lyrics: inspectLyricsCompositor(),
    rafStuck: wallClockTimedOut && rafFrames < 3,
    wallClockTimedOut,
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
  const stopHeartbeat = startRafHeartbeat();
  const onWindowError = (event: ErrorEvent) => {
    noteProbeError(event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    noteProbeError(String(event.reason));
  };
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onRejection);
  host.__YAQMC_PLAYBACK_UI_PROBE__ = {
    sample: samplePlaybackUi,
    sampleLyricsRouteTransition,
    inspectLyricsCompositor,
    inspectHang,
    openLyrics: () => usePlayerStore.getState().openLyrics(),
    closeLyrics: () => usePlayerStore.getState().closePanels(),
    ping: pingPlaybackUiProbe,
    selectLyricsPreset: selectLyricsPresetProbe,
    setCompositorProbe,
    enableArtworkBackground: enableArtworkBackgroundProbe,
    enableFpsOverlay: enableFpsOverlayProbe,
    enableLyricsSurface: enableLyricsSurfaceProbe,
    makeArtwork: makeProbeArtworkDataUri,
  };
  return () => {
    stopHeartbeat();
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onRejection);
    delete host.__YAQMC_PLAYBACK_UI_PROBE__;
  };
}
