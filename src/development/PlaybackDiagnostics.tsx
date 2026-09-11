import { useEffect } from 'react';
import { isPlaybackDiagnosticsBuild } from '../application/diagnostics-profile';
import { installPlaybackUiProbe } from '../application/playback-ui-probe';
import { usePreferencesStore } from '../application/preferences';
import { FpsOverlay } from '../components/FpsOverlay';

export function ApplicationPlaybackDiagnostics() {
  const showFpsCounter = usePreferencesStore((state) => state.debug.showFpsCounter);
  useEffect(() => installPlaybackUiProbe(), []);
  // Default off: the overlay only appears after the explicit debug toggle.
  return showFpsCounter && isPlaybackDiagnosticsBuild() ? <FpsOverlay /> : null;
}

export function SurfacePlaybackDiagnostics() {
  useEffect(() => installPlaybackUiProbe({ heartbeat: false }), []);
  return null;
}
