import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginFilesHost, fileName, relativeFilePath } from './plugin-files';

describe('native plugin file capabilities', () => {
  let temporary: string;
  let folder: string;
  let host: PluginFilesHost;
  let allowed: boolean;
  const call = (method: string, payload = {}, token = 'owner', windowId = 1) =>
    host.invoke({ request: { token, method: `files.${method}`, payload } }, windowId);
  const choose = (writable = false) =>
    call('pickDirectory', { writable }) as Promise<{ handle: string }>;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yaqmc-files-'));
    folder = path.join(temporary, 'selected');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'hello.txt'), 'hello');
    allowed = true;
    host = new PluginFilesHost(
      async () => {
        if (!allowed) throw new Error('permission denied');
        return { ok: true };
      },
      async () => ({ canceled: false, filePaths: [folder] }),
    );
  });
  afterEach(async () => {
    if (
      path.dirname(temporary) !== os.tmpdir() ||
      !path.basename(temporary).startsWith('yaqmc-files-')
    )
      throw new Error('unsafe test cleanup');
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it('returns opaque selections and isolates handles by token and renderer window', async () => {
    const selection = await choose();
    expect(JSON.stringify(selection)).not.toContain(temporary);
    expect(
      await call('readFile', { handle: selection.handle, path: 'hello.txt', length: 2 }),
    ).toMatchObject({ data: 'he', bytesRead: 2, eof: false });
    await expect(call('readFile', { handle: selection.handle })).rejects.toThrow(
      'files.not-a-file',
    );
  });

  it('lists and reads within a read-only directory without permitting changes', async () => {
    const { handle } = await choose();
    expect(await call('list', { handle })).toMatchObject({
      entries: [{ name: 'hello.txt', type: 'file' }],
      nextCursor: null,
    });
    expect(await call('readFile', { handle, path: 'hello.txt', offset: 1, length: 2 })).toEqual({
      data: 'el',
      bytesRead: 2,
      eof: false,
    });
    await expect(
      call('writeFile', { handle, path: 'hello.txt', data: 'bad', overwrite: true }),
    ).rejects.toThrow('files.read-only');
    await expect(call('readFile', { handle, path: 'hello.txt' }, 'other')).rejects.toThrow(
      'files.invalid-handle',
    );
    await expect(call('readFile', { handle, path: 'hello.txt' }, 'owner', 2)).rejects.toThrow(
      'files.invalid-handle',
    );
  });

  it('creates, writes, explicitly overwrites, renames and non-recursively removes entries', async () => {
    const { handle } = await choose(true);
    await call('mkdir', { handle, path: 'notes' });
    await call('writeFile', { handle, path: 'notes/a.bin', data: 'AAH/', encoding: 'base64' });
    expect(
      await call('readFile', { handle, path: 'notes/a.bin', encoding: 'base64' }),
    ).toMatchObject({ data: 'AAH/', eof: true });
    await expect(call('writeFile', { handle, path: 'hello.txt', data: 'changed' })).rejects.toThrow(
      'files.exists',
    );
    await call('writeFile', { handle, path: 'hello.txt', data: 'x', overwrite: true });
    expect(await fs.readFile(path.join(folder, 'hello.txt'), 'utf8')).toBe('x');
    await call('rename', { handle, path: 'notes/a.bin', name: 'b.bin' });
    await expect(call('remove', { handle, path: 'notes' })).rejects.toThrow('files.not-empty');
    await call('remove', { handle, path: 'notes/b.bin' });
    await call('remove', { handle, path: 'notes' });
    await expect(call('remove', { handle })).rejects.toThrow('files.root-operation-denied');
  });

  it('rejects traversal, platform path aliases and symbolic-link escapes', async () => {
    const { handle } = await choose(true);
    for (const candidate of [
      '../outside',
      '/etc/passwd',
      'C:/secret',
      'a\\b',
      'x//y',
      './a',
      'a/..',
      'x:stream',
      'NUL.txt',
      'x.',
    ]) {
      await expect(call('readFile', { handle, path: candidate })).rejects.toThrow(
        'files.invalid-path',
      );
    }
    await fs.writeFile(path.join(temporary, 'secret.txt'), 'private');
    await fs.symlink(
      temporary,
      path.join(folder, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(call('readFile', { handle, path: 'escape/secret.txt' })).rejects.toThrow(
      'files.symlink-denied',
    );
    await expect(
      call('writeFile', { handle, path: 'escape/secret.txt', data: 'bad', overwrite: true }),
    ).rejects.toThrow('files.symlink-denied');
    expect(await fs.readFile(path.join(temporary, 'secret.txt'), 'utf8')).toBe('private');
  });

  it('bounds payloads and chunk sizes before modifying an existing file', async () => {
    const { handle } = await choose(true);
    await expect(
      call('writeFile', {
        handle,
        path: 'hello.txt',
        data: 'x'.repeat(512 * 1024 + 1),
        overwrite: true,
      }),
    ).rejects.toThrow('files.too-large');
    await expect(
      call('writeFile', {
        handle,
        path: 'hello.txt',
        data: '@@@',
        encoding: 'base64',
        overwrite: true,
      }),
    ).rejects.toThrow('files.invalid-argument');
    await expect(
      call('readFile', { handle, path: 'hello.txt', length: 512 * 1024 + 1 }),
    ).rejects.toThrow('files.invalid-argument');
    expect(await fs.readFile(path.join(folder, 'hello.txt'), 'utf8')).toBe('hello');
  });

  it('invalidates closed and retired handles and checks live Core authorization', async () => {
    const { handle } = await choose(true);
    allowed = false;
    await expect(
      call('writeFile', { handle, path: 'hello.txt', data: 'bad', overwrite: true }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(folder, 'hello.txt'), 'utf8')).toBe('hello');
    allowed = true;
    await call('close', { handle });
    await expect(call('stat', { handle })).rejects.toThrow('files.invalid-handle');
    const second = await choose();
    host.release('owner', 1);
    await expect(call('stat', { handle: second.handle })).rejects.toThrow('files.invalid-handle');
  });

  it('cancels a picker retired while the system dialog is open', async () => {
    let complete!: (value: { canceled: boolean; filePaths: string[] }) => void;
    const picker = vi.fn(
      () =>
        new Promise<{ canceled: boolean; filePaths: string[] }>((resolve) => {
          complete = resolve;
        }),
    );
    host = new PluginFilesHost(async () => ({ ok: true }), picker);
    const selected = choose();
    await vi.waitFor(() => expect(picker).toHaveBeenCalledOnce());
    host.release('owner', 1);
    complete({ canceled: false, filePaths: [folder] });
    await expect(selected).rejects.toThrow('files.cancelled');
  });

  it('keeps files selected individually confined to that one file', async () => {
    host = new PluginFilesHost(
      async () => ({ ok: true }),
      async () => ({ canceled: false, filePaths: [path.join(folder, 'hello.txt')] }),
    );
    const selection = (await call('pickFile', { writable: true })) as { handle: string };
    await expect(call('readFile', { handle: selection.handle, path: 'other.txt' })).rejects.toThrow(
      'files.invalid-path',
    );
    await call('rename', { handle: selection.handle, name: 'renamed.txt' });
    expect(await call('readFile', { handle: selection.handle })).toMatchObject({ data: 'hello' });
    await call('remove', { handle: selection.handle });
    await expect(call('stat', { handle: selection.handle })).rejects.toThrow(
      'files.invalid-handle',
    );
  });

  it('validates paths without silently normalizing unsafe components', () => {
    expect(relativeFilePath('a/中文.txt')).toEqual(['a', '中文.txt']);
    expect(() => fileName('x\u0000')).toThrow('files.invalid-path');
  });

  it('authorizes before opening a picker and sanitizes native failures', async () => {
    const picker = vi.fn(async () => ({ canceled: false, filePaths: [folder] }));
    host = new PluginFilesHost(async () => {
      throw new Error(`private ${temporary}`);
    }, picker);
    await expect(choose()).rejects.toThrow('files.permission-denied');
    expect(picker).not.toHaveBeenCalled();
    host = new PluginFilesHost(
      async () => ({ ok: true }),
      async () => {
        throw new Error(`private ${temporary}`);
      },
    );
    await expect(choose()).rejects.toThrow(/^files.io$/);
  });

  it('rechecks containment when a parent is replaced during authorization', async () => {
    await fs.mkdir(path.join(folder, 'notes'));
    let calls = 0;
    let racing = false;
    // Replace the parent specifically while the mutation's Core check is pending.
    const authorize = vi.fn(async () => {
      if (racing && ++calls === 2) {
        await fs.rename(path.join(folder, 'notes'), path.join(folder, 'previous'));
        await fs.symlink(
          temporary,
          path.join(folder, 'notes'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      return { ok: true };
    });
    const raceHost = new PluginFilesHost(authorize, async () => ({
      canceled: false,
      filePaths: [folder],
    }));
    const selected = (await raceHost.invoke(
      { request: { token: 'race', method: 'files.pickDirectory', payload: { writable: true } } },
      1,
    )) as { handle: string };
    racing = true;
    await expect(
      raceHost.invoke(
        {
          request: {
            token: 'race',
            method: 'files.mkdir',
            payload: { handle: selected.handle, path: 'notes/escaped' },
          },
        },
        1,
      ),
    ).rejects.toThrow('files.symlink-denied');
    await expect(fs.stat(path.join(temporary, 'escaped'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
