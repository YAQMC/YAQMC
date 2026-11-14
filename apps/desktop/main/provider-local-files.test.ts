import { describe, expect, it, vi } from 'vitest';
import { ProviderLocalFilesHost } from './provider-local-files';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('private Provider local file broker', () => {
  it('keeps roots opaque, authorizes native reads, refuses mutations and revokes handles', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaqmc-provider-files-'));
    if (
      path.dirname(directory) !== os.tmpdir() ||
      !path.basename(directory).startsWith('yaqmc-provider-files-')
    )
      throw new Error('unsafe cleanup');
    try {
      await fs.writeFile(path.join(directory, 'song.flac'), Buffer.from([0, 1, 255]));
      const invoke = vi.fn(async (_method, params, _origin?: string) =>
        params.operation === 'authorize' ? { ok: true } : null,
      );
      const host = new ProviderLocalFilesHost(invoke, async () => ({
        canceled: false,
        filePaths: [directory],
      }));
      let sequence = 0;
      async function call(method: string, payload = {}) {
        const requestId = String(++sequence);
        await host.handle({
          requestId,
          request: { token: 'provider-session', method: `files.${method}`, payload },
        });
        return invoke.mock.calls.find(
          ([, params]) => params.operation === 'complete' && params.requestId === requestId,
        )![1];
      }
      const selection = (await call('pickDirectory')).value;
      expect(JSON.stringify(selection)).not.toContain(directory);
      const handle = selection.handle;
      expect(
        (await call('readFile', { handle, path: 'song.flac', encoding: 'base64' })).value.data,
      ).toBe('AAH/');
      expect((await call('remove', { handle, path: 'song.flac' })).error).toBeDefined();
      expect(await fs.readFile(path.join(directory, 'song.flac'))).toEqual(
        Buffer.from([0, 1, 255]),
      );
      expect((await call('pickDirectory', { writable: true })).error).toBeDefined();
      await host.handle({ release: 'provider-session' });
      expect((await call('stat', { handle, path: 'song.flac' })).error).toBeDefined();
      expect(
        invoke.mock.calls.every(
          ([method, , origin]) => method === 'plugin_local_files' && origin === 'host',
        ),
      ).toBe(true);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('checks Core authorization before opening a system picker', async () => {
    const pick = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    const host = new ProviderLocalFilesHost(async () => ({ ok: false }), pick);
    await host.handle({
      requestId: 'denied',
      request: { token: 'forged', method: 'files.pickDirectory', payload: {} },
    });
    expect(pick).not.toHaveBeenCalled();
  });
});
