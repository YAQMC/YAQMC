import { describe, expect, it } from 'vitest';
import {
  OVERLAY_VISUAL_DOCUMENT_GUARD,
  inferUiPerfCause,
  sliceProbeSample,
  type DiagStep,
} from './ui-perf-diag';

function step(
  label: string,
  sample: {
    rafFps: number;
    ipcSnapshotHz: number;
    rafP95Ms?: number;
    visualIdle?: boolean;
    surfaceVisual?: string;
  },
  renderer?: { hidden?: boolean; surface?: string; surfaceVisual?: string },
  windows: DiagStep['windows'] = [],
  focused = true,
): DiagStep {
  return {
    label,
    at: 0,
    windows,
    mainHost: {
      role: 'main',
      browserWindowId: 1,
      webContentsId: 1,
      visible: true,
      focused,
      minimized: false,
      maximized: false,
      fullScreen: true,
      alwaysOnTop: false,
      transparent: false,
      opacity: 1,
      hasShadow: true,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      contentBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      backgroundThrottling: false,
      locked: false,
      painted: null,
    },
    mainRenderer: {
      visibilityState: renderer?.hidden ? 'hidden' : 'visible',
      hidden: renderer?.hidden ?? false,
      hasFocus: true,
      surface: renderer?.surface ?? '',
      surfaceUnlock: '',
      surfaceVisual: renderer?.surfaceVisual ?? '',
      compositorProbe: '',
      innerWidth: 1920,
      innerHeight: 1080,
    },
    mainSample: {
      rafFps: sample.rafFps,
      rafFrames: Math.round(sample.rafFps),
      rafP95Ms: sample.rafP95Ms ?? 1_000 / sample.rafFps,
      rafMaxMs: 1_000 / sample.rafFps,
      ipcSnapshotHz: sample.ipcSnapshotHz,
      storeHz: sample.ipcSnapshotHz,
      positionHz: sample.ipcSnapshotHz,
      lyricsMutationHz: sample.ipcSnapshotHz,
      panelCommits: 4,
      visibilityState: renderer?.hidden ? 'hidden' : 'visible',
      hidden: renderer?.hidden ?? false,
      hasFocus: true,
      surfaceVisual: sample.surfaceVisual ?? '',
      visualIdle: sample.visualIdle ?? false,
      wallClockTimedOut: false,
      viewport: { width: 1920, height: 1080 },
    },
    hostSnapshotHz: sample.ipcSnapshotHz,
  };
}

describe('ui-perf overlay lifecycle inference', () => {
  it('names snapshot-cadence collapse plus document.hidden as the overlay-open cause', () => {
    const cause = inferUiPerfCause([
      step('A-fullscreen-only', { rafFps: 239, ipcSnapshotHz: 4.1 }),
      step(
        'B-desktop-open',
        { rafFps: 4.0, ipcSnapshotHz: 4.1, visualIdle: true },
        { hidden: true },
        [
          {
            role: 'lyrics-desktop',
            browserWindowId: 2,
            webContentsId: 3,
            visible: true,
            focused: false,
            minimized: false,
            maximized: false,
            fullScreen: false,
            alwaysOnTop: true,
            transparent: true,
            opacity: 1,
            hasShadow: false,
            bounds: { x: 100, y: 800, width: 940, height: 190 },
            contentBounds: { x: 100, y: 800, width: 940, height: 190 },
            backgroundThrottling: false,
            locked: false,
            painted: { paintedWidth: 940, paintedHeight: 190 },
          },
        ],
      ),
      step('C-desktop-closed', { rafFps: 236, ipcSnapshotHz: 4.1 }),
    ]);
    expect(cause).toContain('4.0 Hz');
    expect(cause).toContain('Core snapshots');
    expect(cause).toContain('document.hidden became true');
    expect(cause).toContain('close Desktop: Fullscreen rAF recovered');
    expect(cause).toContain('940×190');
  });

  it('flags a mis-targeted overlay idle dataset on the main document', () => {
    const cause = inferUiPerfCause([
      step('A-fullscreen-only', { rafFps: 240, ipcSnapshotHz: 4 }),
      step(
        'B-desktop-open',
        { rafFps: 4, ipcSnapshotHz: 4, visualIdle: true, surfaceVisual: 'idle' },
        { hidden: false, surface: '', surfaceVisual: 'idle' },
      ),
    ]);
    expect(cause).toContain('host throttle mis-targeted');
  });

  it('names a 254 ms frame-time stall plus overlay focus-steal when rAF stays above 4 Hz', () => {
    const cause = inferUiPerfCause([
      step(
        'A-fullscreen-only',
        { rafFps: 240, ipcSnapshotHz: 4.1, rafP95Ms: 4.3 },
        undefined,
        [],
        true,
      ),
      step(
        'B-desktop-open',
        { rafFps: 44.9, ipcSnapshotHz: 3.7, rafP95Ms: 254 },
        { hidden: false },
        [],
        false,
      ),
      step(
        'C-desktop-closed',
        { rafFps: 239, ipcSnapshotHz: 4.1, rafP95Ms: 4.3 },
        undefined,
        [],
        false,
      ),
    ]);
    expect(cause).toContain('44.9 Hz');
    expect(cause).toContain('overlay show() activation');
    expect(cause).toContain('close Desktop: Fullscreen rAF recovered');
  });

  it('slices probe samples used by the in-process (no CDP) path', () => {
    expect(sliceProbeSample({ rafFps: 4.2, ipcSnapshotHz: 4.1, hidden: true }).rafFps).toBe(4.2);
    expect(sliceProbeSample(null).error).toBe('empty-sample');
  });

  it('refuses to write overlay idle onto documents without a surface role', () => {
    expect(OVERLAY_VISUAL_DOCUMENT_GUARD).toContain('dataset.surface');
    expect(OVERLAY_VISUAL_DOCUMENT_GUARD).toContain('dataset.surfaceUnlock');
  });
});
