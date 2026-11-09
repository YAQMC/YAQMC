import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createElectronUpdateFetch } from './electron-update-fetch';

function fixture() {
  const hooks = {
    onBeforeRequest: vi.fn(),
    onCompleted: vi.fn(),
    onErrorOccurred: vi.fn(),
  };
  const fetch = vi.fn(async () => new Response('package'));
  const adapter = createElectronUpdateFetch({ webRequest: hooks, fetch } as unknown as Session);
  const request = (url: string, id = 1) => {
    const callback = vi.fn();
    hooks.onBeforeRequest.mock.calls[0]![1]({ url, id }, callback);
    return callback.mock.calls[0]![0];
  };
  return { adapter, hooks, fetch, request };
}

describe('Chromium updater transport', () => {
  it('follows redirects in the dedicated session while omitting cookies and retaining cancellation', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await f.adapter('https://github.com/YAQMC/YAQMC/releases/download/v1/file', {
      signal,
      redirect: 'manual',
      headers: { Accept: 'application/octet-stream' },
    });
    expect(f.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal,
        redirect: 'follow',
        credentials: 'omit',
        headers: { Accept: 'application/octet-stream' },
      }),
    );
    expect(f.request('https://github.com/YAQMC/YAQMC/releases/download/v1/file')).toEqual({
      cancel: false,
    });
    expect(f.request('https://release-assets.githubusercontent.com/file?signature=opaque')).toEqual(
      { cancel: false },
    );
    for (const url of [
      'http://github.com/file',
      'https://127.0.0.1/private',
      'https://github.com.attacker.invalid/file',
      'https://token@github.com/file',
    ]) {
      expect(f.request(url)).toEqual({ cancel: true });
    }
  });
  it('rejects untrusted initial URLs before requesting and bounds every redirect chain', async () => {
    const f = fixture();
    await expect(f.adapter('https://attacker.invalid/file')).rejects.toThrow(
      'update-redirect-denied',
    );
    expect(f.fetch).not.toHaveBeenCalled();
    for (let hop = 0; hop < 6; hop++)
      expect(f.request('https://github.com/file', 12)).toEqual({ cancel: false });
    expect(f.request('https://github.com/file', 12)).toEqual({ cancel: true });
    f.hooks.onErrorOccurred.mock.calls[0]![1]({ id: 12 });
    expect(f.request('https://github.com/file', 12)).toEqual({ cancel: false });
    f.hooks.onCompleted.mock.calls[0]![1]({ id: 12 });
    expect(f.request('https://github.com/file', 12)).toEqual({ cancel: false });
  });
});
