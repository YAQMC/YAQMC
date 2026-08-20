import type { BrowserWindow, WebContents } from 'electron';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LyricsSurfaceKind, LyricsSurfaces } from './lyrics-surfaces';
import type { LyricsUnlockOverlays } from './lyrics-unlock';

export const OVERLAY_VISUAL_DOCUMENT_GUARD =
  'if (!document.documentElement.dataset.surface && !document.documentElement.dataset.surfaceUnlock) return;';

const SAMPLE_MS = 1_200;

export type RectDump = { x: number; y: number; width: number; height: number };

export type WindowLifecycleDump = {
  role: string;
  browserWindowId: number | null;
  webContentsId: number | null;
  visible: boolean | null;
  focused: boolean | null;
  minimized: boolean | null;
  maximized: boolean | null;
  fullScreen: boolean | null;
  alwaysOnTop: boolean | null;
  transparent: boolean | null;
  opacity: number | null;
  hasShadow: boolean | null;
  bounds: RectDump | null;
  contentBounds: RectDump | null;
  backgroundThrottling: boolean | null;
  locked: boolean | null;
  painted: Record<string, unknown> | null;
};

export type RendererLifecycleDump = {
  visibilityState: string | null;
  hidden: boolean | null;
  hasFocus: boolean | null;
  surface: string;
  surfaceUnlock: string;
  surfaceVisual: string;
  compositorProbe: string;
  innerWidth: number | null;
  innerHeight: number | null;
};

export type ProbeSampleSlice = {
  rafFps: number | null;
  rafFrames: number | null;
  rafP95Ms: number | null;
  rafMaxMs: number | null;
  ipcSnapshotHz: number | null;
  storeHz: number | null;
  positionHz: number | null;
  lyricsMutationHz: number | null;
  panelCommits: number | null;
  visibilityState: string | null;
  hidden: boolean | null;
  hasFocus: boolean | null;
  surfaceVisual: string | null;
  visualIdle: boolean | null;
  wallClockTimedOut: boolean | null;
  viewport: { width: number; height: number } | null;
  error?: string;
};

export type DiagStep = {
  label: string;
  at: number;
  windows: WindowLifecycleDump[];
  mainHost: WindowLifecycleDump | null;
  mainRenderer: RendererLifecycleDump | null;
  mainSample: ProbeSampleSlice | null;
  hostSnapshotHz: number | null;
};

export type UiPerfDiagReport = {
  variant: string;
  switches: string[];
  backgroundThrottlingCreate: boolean;
  steps: DiagStep[];
  cause: string;
};

export type UiPerfDiagDeps = {
  variant: string;
  switches: string[];
  outputPath: string;
  log: (message: string) => void;
  mainWindow: () => BrowserWindow | undefined;
  lyrics: LyricsSurfaces;
  unlock: LyricsUnlockOverlays;
  invokeCore: (method: string, params?: unknown) => Promise<unknown>;
  snapshotHits: () => number;
  setMainBackgroundThrottling: (enabled: boolean) => void;
  quit: () => void;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRect(value: unknown): RectDump | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.x !== 'number' ||
    typeof rec.y !== 'number' ||
    typeof rec.width !== 'number' ||
    typeof rec.height !== 'number'
  ) {
    return null;
  }
  return { x: rec.x, y: rec.y, width: rec.width, height: rec.height };
}

function readBackgroundThrottling(contents: WebContents | undefined): boolean | null {
  if (!contents) return null;
  const record = contents as WebContents & {
    backgroundThrottling?: boolean;
    getBackgroundThrottling?: () => boolean;
  };
  if (typeof record.getBackgroundThrottling === 'function') {
    try {
      return record.getBackgroundThrottling();
    } catch {
      return null;
    }
  }
  return typeof record.backgroundThrottling === 'boolean' ? record.backgroundThrottling : null;
}

export function dumpBrowserWindow(
  window: BrowserWindow | undefined,
  extras: { role: string; locked?: boolean | null; painted?: Record<string, unknown> | null },
): WindowLifecycleDump {
  if (!window || window.isDestroyed()) {
    return {
      role: extras.role,
      browserWindowId: null,
      webContentsId: null,
      visible: null,
      focused: null,
      minimized: null,
      maximized: null,
      fullScreen: null,
      alwaysOnTop: null,
      transparent: null,
      opacity: null,
      hasShadow: null,
      bounds: null,
      contentBounds: null,
      backgroundThrottling: null,
      locked: extras.locked ?? null,
      painted: extras.painted ?? null,
    };
  }
  return {
    role: extras.role,
    browserWindowId: window.id,
    webContentsId: window.webContents.id,
    visible: window.isVisible(),
    focused: window.isFocused(),
    minimized: window.isMinimized(),
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    alwaysOnTop: window.isAlwaysOnTop(),
    transparent: window.getBackgroundColor() === '#00000000' || extras.role !== 'main',
    opacity: window.getOpacity(),
    hasShadow: typeof window.hasShadow === 'function' ? window.hasShadow() : null,
    bounds: asRect(window.getBounds()),
    contentBounds: asRect(window.getContentBounds()),
    backgroundThrottling: readBackgroundThrottling(window.webContents),
    locked: extras.locked ?? null,
    painted: extras.painted ?? null,
  };
}

export function sliceProbeSample(raw: unknown): ProbeSampleSlice {
  if (!raw || typeof raw !== 'object') {
    return {
      rafFps: null,
      rafFrames: null,
      rafP95Ms: null,
      rafMaxMs: null,
      ipcSnapshotHz: null,
      storeHz: null,
      positionHz: null,
      lyricsMutationHz: null,
      panelCommits: null,
      visibilityState: null,
      hidden: null,
      hasFocus: null,
      surfaceVisual: null,
      visualIdle: null,
      wallClockTimedOut: null,
      viewport: null,
      error: 'empty-sample',
    };
  }
  const rec = raw as Record<string, unknown>;
  const viewport =
    rec.viewport && typeof rec.viewport === 'object'
      ? (rec.viewport as { width: number; height: number })
      : null;
  return {
    rafFps: typeof rec.rafFps === 'number' ? rec.rafFps : null,
    rafFrames: typeof rec.rafFrames === 'number' ? rec.rafFrames : null,
    rafP95Ms: typeof rec.rafP95Ms === 'number' ? rec.rafP95Ms : null,
    rafMaxMs: typeof rec.rafMaxMs === 'number' ? rec.rafMaxMs : null,
    ipcSnapshotHz: typeof rec.ipcSnapshotHz === 'number' ? rec.ipcSnapshotHz : null,
    storeHz: typeof rec.storeHz === 'number' ? rec.storeHz : null,
    positionHz: typeof rec.positionHz === 'number' ? rec.positionHz : null,
    lyricsMutationHz: typeof rec.lyricsMutationHz === 'number' ? rec.lyricsMutationHz : null,
    panelCommits: typeof rec.panelCommits === 'number' ? rec.panelCommits : null,
    visibilityState: typeof rec.visibilityState === 'string' ? rec.visibilityState : null,
    hidden: typeof rec.hidden === 'boolean' ? rec.hidden : null,
    hasFocus: typeof rec.hasFocus === 'boolean' ? rec.hasFocus : null,
    surfaceVisual: typeof rec.surfaceVisual === 'string' ? rec.surfaceVisual : null,
    visualIdle: typeof rec.visualIdle === 'boolean' ? rec.visualIdle : null,
    wallClockTimedOut: rec.wallClockTimedOut === true,
    viewport,
  };
}

function approx(left: number | null, right: number | null, slack: number): boolean {
  if (left === null || right === null) return false;
  return Math.abs(left - right) <= slack;
}

export function inferUiPerfCause(steps: readonly DiagStep[]): string {
  const byLabel = new Map(steps.map((step) => [step.label, step]));
  const alone = byLabel.get('A-fullscreen-only');
  const desktop = byLabel.get('B-desktop-open');
  const desktopClosed = byLabel.get('C-desktop-closed');
  const island = byLabel.get('D-island-open');
  const both = byLabel.get('E-both-open');
  const throttleTrue = byLabel.get('B2-desktop-open-main-throttling-true');
  const throttleFalse = byLabel.get('B3-desktop-open-main-throttling-false');
  const refocus = byLabel.get('B4-desktop-open-main-refocus');
  const parts: string[] = [];

  const collapsed = (step: DiagStep | undefined) => {
    const fps = step?.mainSample?.rafFps;
    const p95 = step?.mainSample?.rafP95Ms;
    return (typeof fps === 'number' && fps > 0 && fps < 60) || (typeof p95 === 'number' && p95 > 80);
  };
  const displayRate = (step: DiagStep | undefined) => {
    const fps = step?.mainSample?.rafFps;
    return typeof fps === 'number' && fps >= 60;
  };

  if (displayRate(alone) && collapsed(desktop)) {
    parts.push(
      `open Desktop: Fullscreen rAF ${alone?.mainSample?.rafFps?.toFixed(1)} Hz → ${desktop?.mainSample?.rafFps?.toFixed(1)} Hz`,
    );
    if (approx(desktop?.mainSample?.rafFps ?? null, desktop?.mainSample?.ipcSnapshotHz ?? null, 2.5)) {
      parts.push(
        `visible Fullscreen updates ≈ Core snapshots (${desktop?.mainSample?.ipcSnapshotHz?.toFixed(1)} Hz)`,
      );
    }
  }
  if (desktop?.mainRenderer?.hidden === true && alone?.mainRenderer?.hidden !== true) {
    parts.push('main document.hidden became true when Desktop opened (occlusion/visibility)');
  }
  if (desktop?.mainHost?.focused === false && alone?.mainHost?.focused === true) {
    parts.push('main lost focus when Desktop opened (overlay show() activation)');
  }
  if (desktop?.mainSample?.visualIdle === true && alone?.mainSample?.visualIdle !== true) {
    parts.push('main visualIdle became true (overlay idle leaked onto Fullscreen)');
  }
  if (
    desktop?.mainSample?.surfaceVisual === 'idle' &&
    (desktop.mainRenderer?.surface === '' || !desktop.mainRenderer?.surface)
  ) {
    parts.push('main document data-surface-visual=idle without data-surface (host throttle mis-targeted)');
  }
  if (displayRate(desktopClosed) && collapsed(desktop)) {
    parts.push('close Desktop: Fullscreen rAF recovered');
  } else if (collapsed(desktop) && collapsed(desktopClosed)) {
    parts.push('close Desktop: Fullscreen rAF did not recover');
  }
  if (displayRate(alone) && collapsed(island)) {
    parts.push(
      `open Island: Fullscreen rAF ${alone?.mainSample?.rafFps?.toFixed(1)} Hz → ${island?.mainSample?.rafFps?.toFixed(1)} Hz`,
    );
  }
  if (collapsed(both)) {
    parts.push(
      `open both: Fullscreen rAF ${both?.mainSample?.rafFps?.toFixed(1)} Hz snapshots ${both?.mainSample?.ipcSnapshotHz?.toFixed(1)} Hz`,
    );
  }
  if (collapsed(throttleTrue) && collapsed(throttleFalse)) {
    parts.push(
      'main setBackgroundThrottling true/false did not restore display-rate rAF (not the Electron create-time flag)',
    );
  } else if (displayRate(throttleFalse) && collapsed(throttleTrue)) {
    parts.push('main setBackgroundThrottling(false) restored display-rate rAF');
  }
  if (displayRate(refocus) && collapsed(desktop)) {
    parts.push('mainWindow.focus() restored display-rate rAF (foreground/focus, not HWND size)');
  }
  const desktopBounds = desktop?.windows.find((row) => row.role === 'lyrics-desktop');
  if (desktopBounds?.bounds && desktopBounds.contentBounds) {
    parts.push(
      `Desktop bounds ${desktopBounds.bounds.width}×${desktopBounds.bounds.height} content ${desktopBounds.contentBounds.width}×${desktopBounds.contentBounds.height}`,
    );
  }
  const islandBounds = island?.windows.find((row) => row.role === 'lyrics-island');
  if (islandBounds?.bounds && islandBounds.contentBounds) {
    parts.push(
      `Island bounds ${islandBounds.bounds.width}×${islandBounds.bounds.height} content ${islandBounds.contentBounds.width}×${islandBounds.contentBounds.height}`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : 'no overlay-driven Fullscreen rAF collapse measured';
}

const PAINTED_SCRIPT = `(function () {
  var root = document.querySelector('.lyrics-surface') || document.querySelector('.lyrics-surface-root') || document.body;
  var box = root ? root.getBoundingClientRect() : null;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    paintedWidth: box ? box.width : null,
    paintedHeight: box ? box.height : null,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    surface: document.documentElement.dataset.surface || '',
    surfaceUnlock: document.documentElement.dataset.surfaceUnlock || '',
    surfaceVisual: document.documentElement.dataset.surfaceVisual || '',
  };
})()`;

const RENDERER_SCRIPT = `(function () {
  return {
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    surface: document.documentElement.dataset.surface || '',
    surfaceUnlock: document.documentElement.dataset.surfaceUnlock || '',
    surfaceVisual: document.documentElement.dataset.surfaceVisual || '',
    compositorProbe: document.documentElement.dataset.compositorProbe || '',
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  };
})()`;

async function execJson<T>(contents: WebContents, script: string): Promise<T | null> {
  if (contents.isDestroyed()) return null;
  try {
    return (await contents.executeJavaScript(script, true)) as T;
  } catch {
    return null;
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`ui-perf-diag timeout: ${label}`);
}

function fixtureTrack(id: string, artworkSrc: string) {
  return {
    id,
    title: id,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', title: 'Album' },
    artwork: { src: artworkSrc, alt: 'Cover', dominantColor: '#334422' },
    durationMs: 180_000,
    trackNumber: 1,
    isFavorite: false,
    quality: 'standard',
    availability: { status: 'available' },
  };
}

function lyricDocument(songId: string) {
  return {
    songId,
    syncMode: 'word',
    metadata: { sourceLabel: 'ui-perf-diag', offsetMs: 0 },
    vocalists: [],
    lines: Array.from({ length: 48 }, (_, index) => ({
      id: `l${String(index)}`,
      startMs: index * 2_400,
      endMs: (index + 1) * 2_400,
      text: `probe-line-${String(index)} ${'lyric '.repeat(10)}`,
      words: Array.from({ length: 6 }, (__, wordIndex) => ({
        text: `w${String(wordIndex)}`,
        startMs: index * 2_400 + wordIndex * 400,
        endMs: index * 2_400 + (wordIndex + 1) * 400,
      })),
    })),
  };
}

async function sampleMain(window: BrowserWindow): Promise<ProbeSampleSlice> {
  const script = `(async function () {
    var probe = window.__YAQMC_PLAYBACK_UI_PROBE__;
    if (!probe || typeof probe.sample !== 'function') {
      return { error: 'probe-missing' };
    }
    return probe.sample(${String(SAMPLE_MS)});
  })()`;
  const timeout = delay(SAMPLE_MS + 4_000).then(() => ({ error: 'sample-timeout' }));
  const raw = await Promise.race([execJson<unknown>(window.webContents, script), timeout]);
  return sliceProbeSample(raw);
}

export async function runUiPerfDiagSequence(deps: UiPerfDiagDeps): Promise<UiPerfDiagReport> {
  const window = deps.mainWindow();
  if (!window || window.isDestroyed()) {
    throw new Error('ui-perf-diag: main window missing');
  }

  await waitUntil(
    async () => {
      const ready = await execJson<boolean>(
        window.webContents,
        `Boolean(document.querySelector('.app-shell') && window.__YAQMC_PLAYBACK_UI_PROBE__ && typeof window.__YAQMC_PLAYBACK_UI_PROBE__.sample === 'function')`,
      );
      return ready === true;
    },
    90_000,
    'app-shell+probe',
  );

  const artworkSrc = await execJson<string>(
    window.webContents,
    `window.__YAQMC_PLAYBACK_UI_PROBE__.makeArtwork()`,
  );
  await execJson(window.webContents, `window.__YAQMC_PLAYBACK_UI_PROBE__.enableFpsOverlay()`);
  await execJson(window.webContents, `window.__YAQMC_PLAYBACK_UI_PROBE__.enableArtworkBackground()`);
  window.maximize();

  try {
    await deps.invokeCore('player_play_tracks', {
      request: { tracks: [fixtureTrack('ui-perf-diag', artworkSrc ?? '')], shuffle: false },
    });
    await deps.invokeCore('player_play');
    await deps.invokeCore('player_set_lyrics', { document: lyricDocument('ui-perf-diag') });
  } catch (error) {
    deps.log(`ui-perf-diag playback setup failed ${String(error)}`);
  }
  await execJson(window.webContents, `window.__YAQMC_PLAYBACK_UI_PROBE__.openLyrics()`);
  await waitUntil(async () => {
    return (
      (await execJson<boolean>(
        window.webContents,
        `Boolean(document.querySelector('.lyrics-stage'))`,
      )) === true
    );
  }, 20_000, 'lyrics-stage');
  await execJson(window.webContents, `window.__YAQMC_PLAYBACK_UI_PROBE__.enterFullscreen()`);
  await delay(800);

  const dumpAll = async (): Promise<WindowLifecycleDump[]> => {
    const rows: WindowLifecycleDump[] = [];
    const main = deps.mainWindow();
    rows.push(dumpBrowserWindow(main, { role: 'main', locked: false }));
    for (const kind of ['desktop', 'island'] as const) {
      const surface = deps.lyrics.get(kind) as BrowserWindow | undefined;
      const painted = surface && !surface.isDestroyed()
        ? await execJson<Record<string, unknown>>(surface.webContents, PAINTED_SCRIPT)
        : null;
      rows.push(
        dumpBrowserWindow(surface, {
          role: kind === 'desktop' ? 'lyrics-desktop' : 'lyrics-island',
          locked: deps.lyrics.isLocked(kind),
          painted,
        }),
      );
      const unlock = deps.unlock.get(kind) as BrowserWindow | undefined;
      rows.push(
        dumpBrowserWindow(unlock, {
          role: kind === 'desktop' ? 'unlock-desktop' : 'unlock-island',
          locked: null,
        }),
      );
    }
    return rows;
  };

  const capture = async (label: string): Promise<DiagStep> => {
    const hitsBefore = deps.snapshotHits();
    const started = Date.now();
    const main = deps.mainWindow();
    if (!main || main.isDestroyed()) {
      throw new Error(`ui-perf-diag: main missing at ${label}`);
    }
    const renderer = await execJson<RendererLifecycleDump>(main.webContents, RENDERER_SCRIPT);
    const sample = await sampleMain(main);
    const hostSnapshotHz = ((deps.snapshotHits() - hitsBefore) * 1_000) / Math.max(1, Date.now() - started);
    const step: DiagStep = {
      label,
      at: Date.now(),
      windows: await dumpAll(),
      mainHost: dumpBrowserWindow(main, { role: 'main', locked: false }),
      mainRenderer: renderer,
      mainSample: sample,
      hostSnapshotHz,
    };
    deps.log(
      `ui-perf-diag ${label} raf=${sample.rafFps?.toFixed(1)} snap=${sample.ipcSnapshotHz?.toFixed(1)} hidden=${String(renderer?.hidden)} visual=${renderer?.surfaceVisual || sample.surfaceVisual || ''} focused=${String(step.mainHost?.focused)}`,
    );
    return step;
  };

  const setSurface = async (kind: LyricsSurfaceKind, enabled: boolean) => {
    const method = enabled ? 'enableLyricsSurface' : 'disableLyricsSurface';
    await execJson(window.webContents, `window.__YAQMC_PLAYBACK_UI_PROBE__.${method}(${JSON.stringify(kind)})`);
    await delay(enabled ? 700 : 400);
  };

  const steps: DiagStep[] = [];
  steps.push(await capture('A-fullscreen-only'));

  await setSurface('desktop', true);
  steps.push(await capture('B-desktop-open'));

  deps.setMainBackgroundThrottling(true);
  await delay(200);
  steps.push(await capture('B2-desktop-open-main-throttling-true'));
  deps.setMainBackgroundThrottling(false);
  await delay(200);
  steps.push(await capture('B3-desktop-open-main-throttling-false'));
  const current = deps.mainWindow();
  current?.focus();
  await delay(200);
  steps.push(await capture('B4-desktop-open-main-refocus'));

  await setSurface('desktop', false);
  steps.push(await capture('C-desktop-closed'));

  await setSurface('island', true);
  steps.push(await capture('D-island-open'));
  await setSurface('island', false);
  steps.push(await capture('D2-island-closed'));

  await setSurface('desktop', true);
  await setSurface('island', true);
  steps.push(await capture('E-both-open'));
  await setSurface('desktop', false);
  await setSurface('island', false);
  steps.push(await capture('E2-both-closed'));

  const report: UiPerfDiagReport = {
    variant: deps.variant,
    switches: deps.switches,
    backgroundThrottlingCreate: false,
    steps,
    cause: inferUiPerfCause(steps),
  };

  await mkdir(path.dirname(deps.outputPath), { recursive: true });
  const tmpPath = `${deps.outputPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(tmpPath, deps.outputPath);
  deps.log(`ui-perf-diag wrote ${deps.outputPath}`);
  deps.log(`ui-perf-diag cause ${report.cause}`);
  if (process.env.YAQMC_UI_PERF_DIAG_QUIT === '1') {
    deps.quit();
  }
  return report;
}
