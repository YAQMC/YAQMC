import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { NativeApplication } from './application/native-application';
import { MusicProviderRoot } from './application/provider-root';
import { fakeMusicProvider } from './providers/fake/fake-music-provider';
import { installPackagedConsoleForward } from './application/logger';
import { getHostBridge, getYaqmcClient } from './application/yaqmc-runtime';
import { LyricsSurfaceApp, LyricsUnlockControl } from './surfaces/LyricsSurfaceApp';
import type { SurfaceKind } from './application/preferences';
import './i18n';
import './styles/index.css';

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
} else {
  reactRoot.render(
    <StrictMode>
      {getHostBridge().kind !== 'fake' && requestedProvider !== 'fake' ? (
        <NativeApplication initialProviderId={requestedProvider ?? undefined} />
      ) : (
        <MusicProviderRoot provider={fakeMusicProvider}>
          <App />
        </MusicProviderRoot>
      )}
    </StrictMode>,
  );
}
