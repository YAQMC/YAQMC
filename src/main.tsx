import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { MusicProviderRoot } from './application/provider-root';
import { fakeMusicProvider } from './providers/fake/fake-music-provider';
import { qqMusicProvider } from './providers/qqmusic/qq-music-provider';
import { isTauri } from '@tauri-apps/api/core';
import { LyricsSurfaceApp } from './surfaces/LyricsSurfaceApp';
import type { SurfaceKind } from './application/preferences';
import './i18n';

const root = document.getElementById('root');
if (!root) throw new Error('Application root element is missing.');

const parameters = new URLSearchParams(window.location.search);
const requestedSurface = parameters.get('surface');
const surface = ['desktop', 'island'].includes(requestedSurface ?? '')
  ? (requestedSurface as SurfaceKind)
  : null;
if (surface) document.documentElement.dataset.surface = surface;

const requestedProvider = parameters.get('provider');
const provider = isTauri() && requestedProvider !== 'fake' ? qqMusicProvider : fakeMusicProvider;

createRoot(root).render(
  <StrictMode>
    {surface ? (
      <LyricsSurfaceApp kind={surface} />
    ) : (
      <MusicProviderRoot provider={provider}>
        <App />
      </MusicProviderRoot>
    )}
  </StrictMode>,
);
