import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { YaqmcClient, createFakeBridge, type UpdatePayload } from '@yaqmc/client';
import {
  HOST_UPDATER_CHECK_METHOD,
  HOST_UPDATER_DOWNLOAD_METHOD,
  HOST_UPDATER_INSTALL_METHOD,
  IDLE_UPDATE_PAYLOAD,
  NOT_WIRED_ERROR,
  SettingsUpdateSection,
  isUpdateCheckBusy,
  notWiredUpdatePayload,
  requestHostUpdateCheck,
  requestHostUpdateDownload,
  requestHostUpdateInstall,
} from './SettingsUpdateSection';

const invokeMock = vi.hoisted(() => vi.fn());
const openExternalMock = vi.hoisted(() => vi.fn());
const updateListeners = vi.hoisted(() => ({
  handler: undefined as ((payload: UpdatePayload) => void) | undefined,
}));

vi.mock('../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    on: (_channel: string, handler: (payload: UpdatePayload) => void) => {
      updateListeners.handler = handler;
      return () => {
        updateListeners.handler = undefined;
      };
    },
    invoke: invokeMock,
    host: { shell: { openExternal: openExternalMock } },
  }),
}));

function emitUpdate(payload: UpdatePayload) {
  updateListeners.handler?.(payload);
}

function payload(state: UpdatePayload['state'], extra: Partial<UpdatePayload> = {}): UpdatePayload {
  return {
    ...IDLE_UPDATE_PAYLOAD,
    state,
    ...extra,
  };
}

describe('updater settings helpers', () => {
  it('treats checking and downloading as busy and does not auto-install', () => {
    expect(isUpdateCheckBusy('idle')).toBe(false);
    expect(isUpdateCheckBusy('available')).toBe(false);
    expect(isUpdateCheckBusy('ready-to-install')).toBe(false);
    expect(isUpdateCheckBusy('checking')).toBe(true);
    expect(isUpdateCheckBusy('downloading')).toBe(true);
  });

  it('invokes the host_updater_check seam string', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await requestHostUpdateCheck({ invoke });
    expect(invoke).toHaveBeenCalledWith(HOST_UPDATER_CHECK_METHOD);
    await requestHostUpdateDownload({ invoke });
    expect(invoke).toHaveBeenCalledWith(HOST_UPDATER_DOWNLOAD_METHOD);
    await requestHostUpdateInstall({ invoke });
    expect(invoke).toHaveBeenCalledWith(HOST_UPDATER_INSTALL_METHOD);
  });
});

describe('SettingsUpdateSection', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openExternalMock.mockReset();
    openExternalMock.mockResolvedValue(undefined);
    invokeMock.mockRejectedValue(
      new Error('host_updater_check is not implemented on the fake bridge'),
    );
    updateListeners.handler = undefined;
  });

  it('stays idle because the fake client emits nothing by default', () => {
    render(<SettingsUpdateSection />);
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-update-state', 'idle');
    expect(screen.getByRole('status')).toHaveTextContent('No update check has run yet.');
  });

  it('follows host://update payloads for each stub state', () => {
    render(<SettingsUpdateSection />);

    act(() => emitUpdate(payload('checking')));
    expect(screen.getByRole('status')).toHaveAttribute('data-update-state', 'checking');
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();

    act(() => emitUpdate(payload('available', { version: '1.2.3', canInstall: true })));
    expect(screen.getByRole('status')).toHaveTextContent('Version 1.2.3 is available.');
    expect(screen.getByRole('button', { name: 'Download update' })).toBeInTheDocument();

    act(() => emitUpdate(payload('not-available')));
    expect(screen.getByRole('status')).toHaveTextContent('You are on the latest version.');

    act(() => emitUpdate(payload('downloading')));
    expect(screen.getByRole('status')).toHaveAttribute('data-update-state', 'downloading');
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();

    act(() => emitUpdate(payload('ready-to-install', { canInstall: true, version: '1.2.3' })));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Update downloaded. Restart YAQMC to install.',
    );
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restart to install' })).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();

    act(() => emitUpdate(payload('error', { error: 'feed 404' })));
    expect(screen.getByRole('alert')).toHaveTextContent('feed 404');
  });

  it('dispatches a local not-wired error when host_updater_check is missing', async () => {
    render(<SettingsUpdateSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(HOST_UPDATER_CHECK_METHOD));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Update checks are not wired in this build.',
      ),
    );
    expect(notWiredUpdatePayload().error).toBe(NOT_WIRED_ERROR);
  });

  it('does not auto-install when an update is ready', () => {
    render(<SettingsUpdateSection />);
    act(() => emitUpdate(payload('ready-to-install', { canInstall: true })));
    expect(screen.getByRole('button', { name: 'Restart to install' })).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('downloads only after a click and opens the release page for notify-only packages', async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<SettingsUpdateSection />);
    act(() =>
      emitUpdate(
        payload('available', {
          canInstall: true,
          version: '1.2.3',
          releaseUrl: 'https://github.com/YAQMC/YAQMC/releases',
          releaseNotes: 'Release notes from the signed feed.',
        }),
      ),
    );
    expect(screen.getByText('Release notes from the signed feed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(HOST_UPDATER_DOWNLOAD_METHOD));

    fireEvent.click(screen.getByRole('button', { name: 'Open release page' }));
    await waitFor(() =>
      expect(openExternalMock).toHaveBeenCalledWith('https://github.com/YAQMC/YAQMC/releases'),
    );
  });
});

describe('createFakeBridge host://update', () => {
  it('registers the channel but emits no update payload by default', () => {
    const seen: UpdatePayload[] = [];
    const client = new YaqmcClient(createFakeBridge());
    client.on('host://update', (next) => seen.push(next));
    expect(seen).toEqual([]);
  });
});
