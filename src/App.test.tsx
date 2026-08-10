import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PreferencesModule from './application/preferences';
import i18n from './i18n';
import { defaultPreferences, usePreferencesStore } from './application/preferences';
import { initialPlayerState, usePlayerStore } from './application/player-store';
import {
  setFullscreenPortForTests,
  useLyricsPresentationStore,
  type FullscreenPort,
} from './application/lyrics-presentation';
import App from './App';

vi.mock('./application/native-player-runtime', () => ({
  isNativeRuntime: false,
  useNativePlayerRuntime: vi.fn(),
}));

vi.mock('./application/use-lyrics-coordinator', () => ({ useLyricsCoordinator: vi.fn() }));
vi.mock('./application/platform-integration', () => ({
  usePlatformDiagnosticsRuntime: vi.fn(),
}));
vi.mock('./application/use-theme', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));
vi.mock('./application/use-catalog', () => ({
  useCatalog: () => ({ status: 'loading', home: null, library: null, message: null }),
}));
vi.mock('./application/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof PreferencesModule>();
  return { ...actual, usePreferencesRuntime: vi.fn() };
});

vi.mock('./components/AppBackground', () => ({ AppBackground: () => null }));
vi.mock('./components/PlayerBar', () => ({ PlayerBar: () => null }));
vi.mock('./components/QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('./components/LyricsPanel', () => ({ LyricsPanel: () => null }));
vi.mock('./components/Sidebar', () => ({
  Sidebar: ({
    route,
    onNavigate,
  }: {
    route: { page: string };
    onNavigate: (route: { page: 'search' }) => void;
  }) => (
    <aside>
      <output data-testid="active-route">{route.page}</output>
      <button type="button" onClick={() => onNavigate({ page: 'search' })}>
        Navigate to search
      </button>
    </aside>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class ControlledFullscreenPort implements FullscreenPort {
  fullscreen = false;
  failWrite = false;
  writeGate: Promise<void> | null = null;
  writes: boolean[] = [];

  async read() {
    return this.fullscreen;
  }

  async write(value: boolean) {
    this.writes.push(value);
    if (this.writeGate) await this.writeGate;
    if (this.failWrite) throw new Error('native fullscreen denial');
    this.fullscreen = value;
  }

  async subscribe() {
    return () => undefined;
  }
}

describe('App TopBar history navigation', () => {
  let port: ControlledFullscreenPort;
  let restorePort: () => void;

  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    port = new ControlledFullscreenPort();
    restorePort = setFullscreenPortForTests(port);
    usePlayerStore.setState(initialPlayerState);
    usePreferencesStore.setState(defaultPreferences);
  });

  afterEach(() => {
    cleanup();
    restorePort();
  });

  it('gates TopBar Back and Forward on confirmed fullscreen exit', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Navigate to search' }));
    await waitFor(() => expect(screen.getByTestId('active-route')).toHaveTextContent('search'));

    const delayedExit = deferred<void>();
    port.fullscreen = true;
    port.writeGate = delayedExit.promise;
    act(() => {
      usePlayerStore.setState({ lyricsOpen: true });
      useLyricsPresentationStore.setState({ fullscreen: true });
    });

    fireEvent.click(screen.getByTitle('Go back'));
    expect(screen.getByTestId('active-route')).toHaveTextContent('search');
    await waitFor(() => expect(port.writes).toEqual([false]));

    delayedExit.resolve();
    await waitFor(() => expect(screen.getByTestId('active-route')).toHaveTextContent('home'));

    port.writeGate = null;
    port.failWrite = true;
    port.fullscreen = true;
    act(() => {
      usePlayerStore.setState({ lyricsOpen: true });
      useLyricsPresentationStore.setState({ fullscreen: true });
    });

    fireEvent.click(screen.getByTitle('Go forward'));
    expect(screen.getByTestId('active-route')).toHaveTextContent('home');
    await waitFor(() => {
      expect(useLyricsPresentationStore.getState()).toEqual(
        expect.objectContaining({ pending: false, error: 'native fullscreen denial' }),
      );
    });
    expect(screen.getByTestId('active-route')).toHaveTextContent('home');

    port.failWrite = false;
    fireEvent.click(screen.getByTitle('Go forward'));
    await waitFor(() => expect(screen.getByTestId('active-route')).toHaveTextContent('search'));
  });
});
