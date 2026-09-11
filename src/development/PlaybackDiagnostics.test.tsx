import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DiagnosticsProfileModule from '../application/diagnostics-profile';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import { ApplicationPlaybackDiagnostics } from './PlaybackDiagnostics';

const profile = vi.hoisted(() => ({ qaBuild: true }));

vi.mock('../application/diagnostics-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof DiagnosticsProfileModule>();
  return { ...actual, isPlaybackDiagnosticsBuild: () => profile.qaBuild };
});

vi.mock('../application/playback-ui-probe', () => ({
  installPlaybackUiProbe: vi.fn(() => () => undefined),
}));

function setFpsCounter(showFpsCounter: boolean) {
  usePreferencesStore.setState({ ...defaultPreferences, debug: { showFpsCounter } });
}

describe('ApplicationPlaybackDiagnostics', () => {
  beforeEach(() => {
    profile.qaBuild = true;
    setFpsCounter(false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    profile.qaBuild = true;
    setFpsCounter(false);
  });

  it('renders the HUD only in a QA build with the debug counter enabled', () => {
    const disabled = render(<ApplicationPlaybackDiagnostics />);
    expect(disabled.container.querySelector('.fps-overlay')).toBeNull();
    disabled.unmount();

    setFpsCounter(true);
    const enabled = render(<ApplicationPlaybackDiagnostics />);
    expect(enabled.container.querySelector('.fps-overlay')).not.toBeNull();
  });

  it('never renders the HUD in a production build, even with the debug counter enabled', () => {
    profile.qaBuild = false;
    setFpsCounter(true);
    const { container } = render(<ApplicationPlaybackDiagnostics />);

    expect(container).toBeEmptyDOMElement();
    expect(container.querySelector('.fps-overlay')).toBeNull();
    expect(screen.queryByText('FPS')).toBeNull();
  });
});
