import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

const windowMocks = vi.hoisted(() => ({
  isMaximized: vi.fn().mockResolvedValue(false),
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  onResized: vi.fn().mockResolvedValue(() => undefined),
}));

const nativeRuntime = vi.hoisted(() => ({ value: false }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: windowMocks.isMaximized,
    minimize: windowMocks.minimize,
    toggleMaximize: windowMocks.toggleMaximize,
    close: windowMocks.close,
    onResized: windowMocks.onResized,
  }),
}));

vi.mock('../application/native-player-runtime', () => ({
  get isNativeRuntime() {
    return nativeRuntime.value;
  },
}));

function renderTopBar(native: boolean) {
  nativeRuntime.value = native;
  return render(
    <TopBar
      canGoBack
      canGoForward
      theme="dark"
      onBack={() => undefined}
      onForward={() => undefined}
      onSearch={() => undefined}
      onToggleTheme={() => undefined}
    />,
  );
}

describe('TopBar', () => {
  beforeEach(() => {
    nativeRuntime.value = false;
  });

  it('keeps native window controls hidden outside the desktop runtime', () => {
    const { container } = renderTopBar(false);
    expect(screen.queryByLabelText('Minimize')).toBeNull();
    expect(container.querySelector('[data-tauri-drag-region]')).toBeNull();
  });

  it('renders self-drawn window controls and a drag region in the desktop runtime', () => {
    const { container } = renderTopBar(true);
    expect(screen.getByLabelText('Minimize')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximize')).toBeInTheDocument();
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeNull();
  });
});
