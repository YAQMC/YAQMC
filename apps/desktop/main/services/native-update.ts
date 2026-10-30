import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppUpdateCandidate } from '@yaqmc/client';
import { requireUpdateSpace, verifyUpdateFile } from './update-io';

export async function atomicUpdateJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export type NativeTransaction = {
  operationId: string;
  token: string;
  parentPid: number;
  launcherPid: number;
  target: string;
  package: string;
  oldSha256: string;
  sha256: string;
  size: number;
  version: string;
  targetKind?: 'portable' | 'AppImage';
  state: string;
  error?: string;
};
export async function readUpdateJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function launchNativeUpdate(options: {
  root: string;
  helper: string;
  target: string;
  targetKind?: 'portable' | 'AppImage';
  candidate: AppUpdateCandidate;
  package: string;
  quit: () => void;
}) {
  const { asset } = options.candidate;
  if (!asset || !path.isAbsolute(options.target)) throw new Error('update-target-invalid');
  if (options.targetKind === 'AppImage') await verifyAppImageTarget(options.target);
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const helperIdentity = await readUpdateJson<{ name: string; sha256: string; bytes: number }>(
    path.join(path.dirname(options.helper), 'manifest.json'),
  );
  if (!helperIdentity || helperIdentity.name !== path.basename(options.helper))
    throw new Error('update-helper-integrity-missing');
  await verifyUpdateFile(options.helper, {
    id: 0,
    name: helperIdentity.name,
    size: helperIdentity.bytes,
    sha256: helperIdentity.sha256,
    url: '',
  });
  const old = createHash('sha256');
  for await (const chunk of createReadStream(options.target)) old.update(chunk as Buffer);
  await verifyUpdateFile(options.package, asset);
  await requireUpdateSpace(path.dirname(options.target), asset.size);
  const operationId = randomBytes(16).toString('hex');
  const directory = path.join(options.root, 'operations', operationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const helper = path.join(
    directory,
    process.platform === 'win32' ? 'apply-update.exe' : 'apply-update',
  );
  await copyFile(options.helper, helper);
  const tx: NativeTransaction = {
    operationId,
    token: randomBytes(32).toString('hex'),
    parentPid: process.pid,
    launcherPid: process.ppid,
    target: options.target,
    package: options.package,
    oldSha256: old.digest('hex'),
    sha256: asset.sha256,
    size: asset.size,
    version: options.candidate.version,
    targetKind: options.targetKind,
    state: 'preparing',
  };
  await atomicUpdateJson(path.join(directory, 'transaction.json'), tx);
  await atomicUpdateJson(path.join(options.root, 'last-operation.json'), { operationId });
  const child = spawn(helper, ['--apply', directory], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const state = await readUpdateJson<NativeTransaction>(
        path.join(directory, 'transaction.json'),
      );
      if (state?.state === 'error') throw new Error(state.error ?? 'update-helper-failed');
      if (await readUpdateJson(path.join(directory, 'ready.json'))) {
        child.unref();
        options.quit();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('update-helper-timeout');
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function verifyAppImageTarget(target: string): Promise<void> {
  const metadata = await lstat(target).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error('update-target-invalid');
  const file = await open(target, 'r').catch(() => undefined);
  if (!file) throw new Error('update-target-invalid');
  try {
    const header = Buffer.alloc(12);
    const result = await file.read(header, 0, header.length, 0);
    if (
      result.bytesRead < header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[8] !== 0x41 ||
      header[9] !== 0x49 ||
      ![0x01, 0x02].includes(header[10] ?? 0)
    ) {
      throw new Error('update-target-invalid');
    }
  } finally {
    await file.close();
  }
}

export async function nativeUpdateHealth(
  root: string,
  version: string,
  healthy: boolean,
  target: string,
) {
  const last = await readUpdateJson<{ operationId: string }>(
    path.join(root, 'last-operation.json'),
  );
  const id = process.env.YAQMC_APP_UPDATE_OPERATION ?? last?.operationId;
  if (!id || !/^[a-f0-9]{32}$/u.test(id)) return;
  const directory = path.join(root, 'operations', id);
  const tx = await readUpdateJson<NativeTransaction>(path.join(directory, 'transaction.json'));
  if (
    !tx ||
    tx.operationId !== id ||
    tx.version !== version ||
    !/^[a-f0-9]{64}$/u.test(tx.token) ||
    path.resolve(tx.target) !== path.resolve(target)
  )
    return;
  await atomicUpdateJson(path.join(directory, healthy ? 'healthy.json' : 'launched.json'), {
    token: tx.token,
    version,
    pid: process.pid,
  });
}

export async function recoverNativeUpdate(root: string, helper: string, target: string) {
  const last = await readUpdateJson<{ operationId: string }>(
    path.join(root, 'last-operation.json'),
  );
  if (!last || !/^[a-f0-9]{32}$/u.test(last.operationId)) return;
  const directory = path.join(root, 'operations', last.operationId);
  const tx = await readUpdateJson<NativeTransaction>(path.join(directory, 'transaction.json'));
  if (
    !tx ||
    path.resolve(tx.target) !== path.resolve(target) ||
    ['rolled-back', 'error'].includes(tx.state)
  )
    return;
  const child = spawn(helper, ['--recover', directory], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
}

export async function nativeUpdateResult(root: string): Promise<
  | {
      state: 'completed' | 'rolled-back' | 'error';
      error?: string;
    }
  | undefined
> {
  const last = await readUpdateJson<{ operationId: string }>(
    path.join(root, 'last-operation.json'),
  );
  if (!last || !/^[a-f0-9]{32}$/u.test(last.operationId)) return;
  const tx = await readUpdateJson<NativeTransaction>(
    path.join(root, 'operations', last.operationId, 'transaction.json'),
  );
  if (tx && ['completed', 'rolled-back', 'error'].includes(tx.state)) {
    return { state: tx.state as 'completed' | 'rolled-back' | 'error', error: tx.error };
  }
  if (tx?.state === 'recovery-required')
    return { state: 'error', error: `update-recovery-required: ${tx.error ?? ''}` };
}

export async function nsisUpdateResult(root: string, currentVersion: string) {
  const pending = await readUpdateJson<{
    version: string;
    oldVersion: string;
    completed?: boolean;
  }>(path.join(root, 'nsis-pending.json'));
  if (!pending) return;
  if (pending.version === currentVersion) {
    if (!pending.completed)
      await atomicUpdateJson(path.join(root, 'nsis-pending.json'), { ...pending, completed: true });
    return { state: 'completed' as const };
  }
  if (pending.oldVersion === currentVersion && !pending.completed) {
    return { state: 'error' as const, error: 'update-installation-incomplete' };
  }
}
