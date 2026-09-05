import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { TopBar } from './TopBar';

const windowMocks = vi.hoisted(() => ({
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  setFullscreen: vi.fn().mockResolvedValue(undefined),
}));

const nativeRuntime = vi.hoisted(() => ({ value: false }));
const hostKind = vi.hoisted(() => ({ value: undefined as 'android' | undefined }));

vi.mock('../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    bridge: hostKind.value ? { kind: hostKind.value } : undefined,
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
    resetAccountRuntimeForTest();
    nativeRuntime.value = false;
    hostKind.value = undefined;
    windowMocks.minimize.mockClear();
    windowMocks.toggleMaximize.mockClear();
    windowMocks.close.mockClear();
  });

  it('keeps native window controls hidden outside the desktop runtime', () => {
    const { container } = renderTopBar(false);
    expect(screen.queryByLabelText('Minimize')).toBeNull();
    expect(container.querySelector('.yaqmc-drag')).toBeNull();
  });

  it('does not advertise a desktop keyboard shortcut in the Android shell', () => {
    hostKind.value = 'android';
    renderTopBar(true);
    expect(screen.queryByText('Ctrl K')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Minimize')).not.toBeInTheDocument();
  });

  it('retains the desktop search shortcut without adding it to the button name', () => {
    renderTopBar(true);
    expect(screen.getByText('Ctrl K')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
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

  it('exposes the Android account and settings entry without desktop window controls', () => {
    const onAccount = vi.fn();
    hostKind.value = 'android';
    render(
      <TopBar
        canGoBack={false}
        canGoForward={false}
        theme="dark"
        onBack={() => undefined}
        onForward={() => undefined}
        onSearch={() => undefined}
        onToggleTheme={() => undefined}
        onAccount={onAccount}
      />,
    );

    fireEvent.click(screen.getByLabelText('Open application settings'));
    expect(onAccount).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Minimize')).toBeNull();
    expect(screen.getByLabelText('Open application settings').querySelector('svg')).toBeNull();
    expect(screen.getByLabelText('Open application settings')).toHaveTextContent('L');
  });

  it('uses the authenticated account avatar for the Android settings entry', () => {
    hostKind.value = 'android';
    useAccountStore.setState({
      snapshot: {
        state: 'authenticated',
        profile: {
          avatarUrl: 'https://q.qlogo.cn/topbar-avatar.png',
          nickname: 'Mobile Listener',
          maskedIdentity: '10******01',
        },
        entitlement: {
          tier: 'free',
          membership: 'inactive',
          expiresAtMs: null,
          permittedQualities: ['standard'],
          observedMaximumQuality: 'standard',
          restrictions: [],
        },
        revision: 1,
        capabilities: {
          qrLogin: true,
          favoriteRead: true,
          favoriteWrite: false,
          playlistRead: true,
          playlistWrite: false,
          recentHistoryRead: true,
        },
      },
    });

    render(
      <TopBar
        canGoBack={false}
        canGoForward={false}
        theme="dark"
        onBack={() => undefined}
        onForward={() => undefined}
        onSearch={() => undefined}
        onToggleTheme={() => undefined}
        onAccount={() => undefined}
      />,
    );

    expect(screen.getByRole('img', { name: 'Mobile Listener account avatar' })).toHaveAttribute(
      'src',
      'https://q.qlogo.cn/topbar-avatar.png',
    );
  });
});
