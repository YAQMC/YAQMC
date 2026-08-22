import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

const windowMocks = vi.hoisted(() => ({
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  setFullscreen: vi.fn().mockResolvedValue(undefined),
}));

const nativeRuntime = vi.hoisted(() => ({ value: false }));

vi.mock('../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    host: {
      window: windowMocks,
      shell: { openExternal: async () => undefined },
    },
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
    windowMocks.minimize.mockClear();
    windowMocks.toggleMaximize.mockClear();
    windowMocks.close.mockClear();
  });

  it('keeps native window controls hidden outside the desktop runtime', () => {
    const { container } = renderTopBar(false);
    expect(screen.queryByLabelText('Minimize')).toBeNull();
    expect(container.querySelector('.yaqmc-drag')).toBeNull();
  });

  it('renders self-drawn window controls and an Electron drag region in the desktop runtime', () => {
    const { container } = renderTopBar(true);
    expect(screen.getByLabelText('Minimize')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximize')).toBeInTheDocument();
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    const drag = container.querySelector('.topbar__drag');
    expect(drag).not.toBeNull();
    expect(drag).toHaveClass('yaqmc-drag');
  });

  it('routes window chrome through YaqmcClient host.window', () => {
    renderTopBar(true);
    fireEvent.click(screen.getByLabelText('Minimize'));
    fireEvent.click(screen.getByLabelText('Maximize'));
    expect(screen.getByLabelText('Restore')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(windowMocks.minimize).toHaveBeenCalledTimes(1);
    expect(windowMocks.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(windowMocks.close).toHaveBeenCalledTimes(1);
  });
});
