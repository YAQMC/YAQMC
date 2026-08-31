import { useEffect } from 'react';
import { installPlaybackUiProbe } from '../application/playback-ui-probe';
import { usePreferencesStore } from '../application/preferences';
import { FpsOverlay } from '../components/FpsOverlay';

export function ApplicationPlaybackDiagnostics() {
  const showFpsCounter = usePreferencesStore((state) => state.debug.showFpsCounter);
  useEffect(() => installPlaybackUiProbe(), []);
  return showFpsCounter ? <FpsOverlay /> : null;
}

export function SurfacePlaybackDiagnostics() {
  useEffect(() => installPlaybackUiProbe({ heartbeat: false }), []);
  return null;
}
