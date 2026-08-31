import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeApplication } from './native-application';
import { installPackagedConsoleForward } from './logger';
import { getHostBridge, getYaqmcClient } from './yaqmc-runtime';
import { LyricsSurfaceApp, LyricsUnlockControl } from '../surfaces/LyricsSurfaceApp';
import type { SurfaceKind } from './preferences';
import '../i18n';
import '../styles/index.css';

export function bootstrapApplication(options: { developmentApplication?: ReactNode } = {}): void {
  installPackagedConsoleForward();
  getYaqmcClient();

  const root = document.getElementById('root');
  if (!root) throw new Error('Application root element is missing.');

  const parameters = new URLSearchParams(window.location.search);
  const requestedSurface = parameters.get('surface');
  const surface = ['desktop', 'island'].includes(requestedSurface ?? '')
    ? (requestedSurface as SurfaceKind)
    : null;
  if (surface) document.documentElement.dataset.surface = surface;
  const requestedUnlockSurface = parameters.get('unlockSurface');
  const unlockSurface = ['desktop', 'island'].includes(requestedUnlockSurface ?? '')
    ? (requestedUnlockSurface as SurfaceKind)
    : null;
  if (unlockSurface) document.documentElement.dataset.surfaceUnlock = unlockSurface;

  const requestedProvider = parameters.get('provider');
  const reactRoot = createRoot(root);

  if (unlockSurface || surface) {
    reactRoot.render(
      <StrictMode>
        {unlockSurface ? (
          <LyricsUnlockControl kind={unlockSurface} />
        ) : (
          <LyricsSurfaceApp kind={surface!} />
        )}
      </StrictMode>,
    );
    return;
  }

  if (
    options.developmentApplication &&
    (getHostBridge().kind === 'fake' || requestedProvider === 'fake')
  ) {
    reactRoot.render(<StrictMode>{options.developmentApplication}</StrictMode>);
    return;
  }

  reactRoot.render(
    <StrictMode>
      <NativeApplication initialProviderId={requestedProvider ?? undefined} />
    </StrictMode>,
  );
}
