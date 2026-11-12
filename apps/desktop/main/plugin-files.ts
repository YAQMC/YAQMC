import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ShowOpenDialog } from './dialogs';

const MAX_BYTES = 512 * 1024;
const MAX_HANDLES = 64;
type Request = { token: string; method: string; payload: Record<string, unknown> };
type Grant = { owner: string; root: string; directory: boolean; writable: boolean };
type Pending = { owner: string; cancelled: boolean };
type Authorize = (request: Request) => Promise<unknown>;
const fail = (code: string): never => {
  throw new Error(`files.${code}`);
};

export function fileName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    // eslint-disable-next-line no-control-regex -- Control bytes are forbidden in portable paths.
    /[\\/:<>"|?*\x00-\x1f]/.test(value) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value) ||
    Buffer.byteLength(value) > 255
  )
    return fail('invalid-path');
  return value;
}

export function relativeFilePath(value: unknown = ''): string[] {
  if (typeof value !== 'string' || value.length > 2048) return fail('invalid-path');
  return value === '' ? [] : value.split('/').map(fileName);
}

function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    return fail('invalid-argument');
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** Session-scoped native capabilities. No renderer or script may supply an absolute path. */
export class PluginFilesHost {
  private readonly handles = new Map<string, Grant>();
  private readonly pending = new Set<Pending>();
  private tail: Promise<unknown> = Promise.resolve();
  private picking = false;

  constructor(
    private readonly authorize: Authorize,
    private readonly pick: ShowOpenDialog,
  ) {}

  private ensureCapacity(owner: string): void {
    if (
      [...this.handles.values()].filter((grant) => grant.owner === owner).length >= MAX_HANDLES ||
      this.handles.size >= 512
    )
      fail('handle-limit');
  }

  release(token: unknown, windowId: number): void {
    const owner = `${windowId}\0${String(token)}`;
    for (const [id, grant] of this.handles) if (grant.owner === owner) this.handles.delete(id);
    for (const operation of this.pending) if (operation.owner === owner) operation.cancelled = true;
  }

  async invoke(raw: unknown, windowId: number): Promise<unknown> {
    const request = (raw as { request?: Request } | null)?.request;
    if (
      !request ||
      typeof request.token !== 'string' ||
      !request.token ||
      request.token.length > 256 ||
      typeof request.method !== 'string' ||
      !request.method.startsWith('files.') ||
      !request.payload ||
      typeof request.payload !== 'object' ||
      Array.isArray(request.payload)
    )
      return fail('invalid-argument');
    if (JSON.stringify(request.payload).length > 768 * 1024) return fail('payload-too-large');
    if (this.pending.size >= 32) return fail('busy');
    const operation = { owner: `${windowId}\0${request.token}`, cancelled: false };
    this.pending.add(operation);
    const check = async () => {
      if (operation.cancelled) return fail('cancelled');
      const result = (await this.authorize(request).catch(() => fail('permission-denied'))) as {
        ok?: boolean;
      } | null;
      if (result?.ok !== true || operation.cancelled) return fail('permission-denied');
    };
    try {
      if (request.method === 'files.pickFile' || request.method === 'files.pickDirectory') {
        await check();
        if (this.picking) return fail('busy');
        this.ensureCapacity(operation.owner);
        const directory = request.method === 'files.pickDirectory';
        if (request.payload.writable !== undefined && typeof request.payload.writable !== 'boolean')
          return fail('invalid-argument');
        this.picking = true;
        let selected;
        try {
          selected = await this.pick({
            title:
              request.payload.writable === true
                ? 'YAQMC plugin: choose a location to read, modify and delete files'
                : 'YAQMC plugin: choose a location to read',
            properties: [directory ? 'openDirectory' : 'openFile'],
          });
        } finally {
          this.picking = false;
        }
        await check();
        if (selected.canceled || !selected.filePaths[0]) return null;
        const chosen = selected.filePaths[0];
        const entry = await fs.lstat(chosen);
        if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile()))
          return fail('unsupported-entry');
        const root = await fs.realpath(chosen);
        await check();
        this.ensureCapacity(operation.owner);
        const handle = randomUUID();
        const writable = request.payload.writable === true;
        this.handles.set(handle, { owner: operation.owner, root, directory, writable });
        return {
          handle,
          name: path.basename(root),
          type: directory ? 'directory' : 'file',
          writable,
        };
      }
      // Serialize operations so a plugin cannot race its own rename/write/remove calls.
      const run = this.tail
        .catch(() => undefined)
        .then(async () => {
          await check();
          const result = await this.perform(request, operation.owner, check);
          await check();
          return result;
        });
      this.tail = run;
      return await run;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('files.')) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      return fail(
        code === 'ENOENT'
          ? 'not-found'
          : code === 'EEXIST'
            ? 'exists'
            : code === 'ENOTEMPTY'
              ? 'not-empty'
              : code === 'EACCES' || code === 'EPERM'
                ? 'permission-denied'
                : 'io',
      );
    } finally {
      this.pending.delete(operation);
    }
  }

  private async resolve(grant: Grant, parts: string[], missing = false): Promise<string> {
    if (!grant.directory && parts.length) return fail('invalid-path');
    const root = await fs.realpath(grant.root);
    if (root !== grant.root) return fail('invalid-handle');
    let current = root;
    for (const [index, name] of parts.entries()) {
      current = path.join(current, name);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) return fail('symlink-denied');
        if (!stat.isFile() && !stat.isDirectory()) return fail('unsupported-entry');
        if (!isInside(root, await fs.realpath(current))) return fail('invalid-path');
      } catch (error) {
        if (
          missing &&
          index === parts.length - 1 &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        )
          return current;
        throw error;
      }
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) return fail('symlink-denied');
    return current;
  }

  private async perform(
    request: Request,
    owner: string,
    check: () => Promise<void>,
  ): Promise<unknown> {
    const p = request.payload;
    if (request.method === 'files.capabilities')
      return {
        available: true,
        maxBytes: MAX_BYTES,
        maxEntries: 200,
        persistentHandles: false,
        recursiveDelete: false,
        directoryDelete: true,
      };
    const handle = typeof p.handle === 'string' ? p.handle : '';
    const grant = this.handles.get(handle);
    if (!grant || grant.owner !== owner) return fail('invalid-handle');
    if (request.method === 'files.close') {
      this.handles.delete(handle);
      return { ok: true };
    }
    const parts = relativeFilePath(p.path);
    const writing = ['files.writeFile', 'files.mkdir', 'files.rename', 'files.remove'].includes(
      request.method,
    );
    if (writing && !grant.writable) return fail('read-only');
    const target = await this.resolve(
      grant,
      parts,
      request.method === 'files.mkdir' || request.method === 'files.writeFile',
    );
    const info = async (entry: string, name: string) => {
      const stat = await fs.lstat(entry);
      if (stat.isSymbolicLink()) return fail('symlink-denied');
      if (!stat.isFile() && !stat.isDirectory()) return fail('unsupported-entry');
      return {
        name,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.isFile() ? stat.size : null,
        modifiedMs: stat.mtimeMs,
        writable: grant.writable,
      };
    };
    switch (request.method) {
      case 'files.stat':
        return info(target, path.basename(target));
      case 'files.list': {
        const offset = integer(p.cursor, 0, 1_000_000);
        const limit = integer(p.limit, 100, 200);
        if (!limit) return fail('invalid-argument');
        const entries = [];
        let index = 0;
        const directory = await fs.opendir(target);
        for await (const entry of directory) {
          if (index++ < offset) continue;
          if (entries.length === limit) return { entries, nextCursor: index - 1 };
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
          try {
            fileName(entry.name);
          } catch {
            continue;
          }
          entries.push(await info(path.join(target, entry.name), entry.name));
        }
        return { entries, nextCursor: null };
      }
      case 'files.readFile': {
        const offset = integer(p.offset, 0, Number.MAX_SAFE_INTEGER);
        const length = integer(p.length, MAX_BYTES, MAX_BYTES);
        if (
          !length ||
          (p.encoding !== undefined && p.encoding !== 'utf8' && p.encoding !== 'base64')
        )
          return fail('invalid-argument');
        const before = await fs.lstat(target);
        if (!before.isFile()) return fail('not-a-file');
        const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const after = await file.stat();
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            target !== (await this.resolve(grant, parts))
          )
            return fail('entry-changed');
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await file.read(buffer, 0, length, offset);
          return {
            data: buffer
              .subarray(0, bytesRead)
              .toString(p.encoding === 'base64' ? 'base64' : 'utf8'),
            bytesRead,
            eof: offset + bytesRead >= after.size,
          };
        } finally {
          await file.close();
        }
      }
      case 'files.writeFile': {
        if (
          typeof p.data !== 'string' ||
          (p.encoding !== undefined && p.encoding !== 'utf8' && p.encoding !== 'base64') ||
          (p.overwrite !== undefined && typeof p.overwrite !== 'boolean')
        )
          return fail('invalid-argument');
        const data = Buffer.from(p.data, p.encoding === 'base64' ? 'base64' : 'utf8');
        if (p.encoding === 'base64' && data.toString('base64') !== p.data)
          return fail('invalid-argument');
        if (data.length > MAX_BYTES) return fail('too-large');
        let before;
        try {
          before = await fs.lstat(target);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (before && !before.isFile()) return fail('not-a-file');
        if (before && p.overwrite !== true) return fail('exists');
        await check();
        await this.resolve(grant, parts, true);
        const file = await fs.open(
          target,
          constants.O_WRONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (before ? 0 : constants.O_CREAT | constants.O_EXCL),
          0o600,
        );
        try {
          const after = await file.stat();
          if (
            (before && (before.dev !== after.dev || before.ino !== after.ino)) ||
            target !== (await this.resolve(grant, parts))
          )
            return fail('entry-changed');
          await check();
          await file.truncate(0);
          await file.writeFile(data);
          return { ok: true, bytesWritten: data.length };
        } finally {
          await file.close();
        }
      }
      case 'files.mkdir': {
        if (!parts.length) return fail('invalid-path');
        await check();
        await this.resolve(grant, parts, true);
        await fs.mkdir(target);
        return { ok: true };
      }
      case 'files.rename': {
        if (grant.directory && !parts.length) return fail('root-operation-denied');
        const name = fileName(p.name);
        const destination = path.join(path.dirname(target), name);
        if (destination === target) return { ok: true };
        try {
          await fs.lstat(destination);
          return fail('exists');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        const stat = await fs.lstat(target);
        await check();
        await this.resolve(grant, parts);
        if (stat.isFile()) {
          await fs.link(target, destination);
          await fs.unlink(target);
        } else await fs.rename(target, destination);
        if (!grant.directory) grant.root = destination;
        return { ok: true };
      }
      case 'files.remove': {
        if (grant.directory && !parts.length) return fail('root-operation-denied');
        const stat = await fs.lstat(target);
        await check();
        await this.resolve(grant, parts);
        if (stat.isDirectory()) await fs.rmdir(target);
        else await fs.unlink(target);
        if (!grant.directory) this.handles.delete(handle);
        return { ok: true };
      }
      default:
        return fail('unsupported');
    }
  }
}
