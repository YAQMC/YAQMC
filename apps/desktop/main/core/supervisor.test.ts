import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SHUTDOWN_TIMEOUT_MS,
} from '@yaqmc/client';
import type { ChildProcess } from 'node:child_process';
import { CoreClient } from './client';
import { FrameDecoder, encodeFrame } from './frames';
import {
  CoreSupervisor,
  STDERR_RING_BYTES,
  coreBinaryName,
  createAttachMessage,
  hostHandshake,
  hostPlatformKind,
  tryResolveCoreBinary,
  type SpawnCore,
} from './supervisor';

const hello = {
  kind: 'hello' as const,
  protocol: PROTOCOL_VERSION,
  core: { version: '0.1.0', commit: 'deadbeef', channel: 'desktop' },
};

function mockStream() {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const client = new CoreClient({ readable, writable });
  return { client, readable, writable };
}

function pushMessage(readable: PassThrough, message: unknown) {
  readable.write(encodeFrame(Buffer.from(JSON.stringify(message))));
}

function collectFrames(writable: PassThrough) {
  const chunks: Buffer[] = [];
  writable.on('data', (chunk: Buffer) => chunks.push(chunk));
  return async () => {
    await vi.waitFor(() => expect(Buffer.concat(chunks).length).toBeGreaterThan(4));
    const frames = new FrameDecoder().push(Buffer.concat(chunks));
    const frame = frames[0];
    if (!frame) {
      throw new Error('missing frame');
    }
    chunks.length = 0;
    return JSON.parse(frame.toString('utf8')) as unknown;
  };
}

function tempDirs() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-supervisor-'));
  return {
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'cache'),
    logDir: path.join(root, 'logs'),
    configDir: path.join(root, 'config'),
  };
}

describe('hostHandshake', () => {
  it('completes hello → attach → ready', async () => {
    const { client, readable, writable } = mockStream();
    const pending = hostHandshake(client, createAttachMessage('0.1.0'), {
      expectedCoreVersion: '0.1.0',
    });
    const nextFrame = collectFrames(writable);
    pushMessage(readable, hello);
    await expect(nextFrame()).resolves.toMatchObject({
      kind: 'attach',
      protocol: PROTOCOL_VERSION,
      host: { app: 'yaqmc', version: '0.1.0' },
      platform: { platformKind: hostPlatformKind() },
    });
    pushMessage(readable, { kind: 'ready' });
    await expect(pending).resolves.toEqual(hello.core);
    client.close();
  });

  it('rejects a protocol mismatch on hello', async () => {
    const { client, readable } = mockStream();
    const pending = hostHandshake(client, createAttachMessage('0.1.0'));
    pushMessage(readable, { ...hello, protocol: 2 });
    await expect(pending).rejects.toMatchObject({
      name: 'ProtocolError',
      message: 'handshake protocol mismatch: 2',
    });
  });

  it('times out the whole handshake at 10s', async () => {
    vi.useFakeTimers();
    const { client } = mockStream();
    const pending = hostHandshake(client, createAttachMessage('0.1.0'));
    const assertion = expect(pending).rejects.toMatchObject({
      message: 'handshake timed out',
    });
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    await assertion;
    vi.useRealTimers();
    client.close();
  });
});

describe('tryResolveCoreBinary', () => {
  it('prefers YAQMC_CORE_BIN, then staged, then cargo debug', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-core-resolve-'));
    const name = coreBinaryName();
    const envBin = path.join(root, `env-${name}`);
    const stagedDir = path.join(root, 'staged');
    const cargoDebug = path.join(root, 'cargo', 'debug');
    mkdirSync(stagedDir, { recursive: true });
    mkdirSync(cargoDebug, { recursive: true });
    writeFileSync(envBin, 'env');
    writeFileSync(path.join(stagedDir, name), 'staged');
    writeFileSync(path.join(cargoDebug, name), 'debug');

    expect(
      tryResolveCoreBinary({
        env: { YAQMC_CORE_BIN: envBin },
        stagedDir,
        cargoTargetDir: path.join(root, 'cargo'),
      }),
    ).toBe(envBin);
    expect(
      tryResolveCoreBinary({
        env: {},
        stagedDir,
        cargoTargetDir: path.join(root, 'cargo'),
      }),
    ).toBe(path.join(stagedDir, name));
    expect(
      tryResolveCoreBinary({
        env: {},
        cargoTargetDir: path.join(root, 'cargo'),
      }),
    ).toBe(path.join(cargoDebug, name));
  });
});

describe('CoreSupervisor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns, handshakes, detects exit, and keeps a 64 KiB stderr ring', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
      exitCode: number | null;
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 1;
      child.emit('exit', 1, null);
      return true;
    };

    const spawnCore: SpawnCore = () => child as unknown as ChildProcess;
    const supervisor = new CoreSupervisor({
      binary: coreBinaryName(),
      hostVersion: '0.1.0',
      expectedCoreVersion: '0.1.0',
      ...tempDirs(),
      spawn: spawnCore,
    });

    const started = supervisor.start();
    const nextFrame = collectFrames(stdin);
    pushMessage(stdout, hello);
    await expect(nextFrame()).resolves.toMatchObject({ kind: 'attach' });
    pushMessage(stdout, { kind: 'ready' });
    await expect(started).resolves.toEqual(hello.core);

    stderr.write(Buffer.alloc(STDERR_RING_BYTES + 16, 0x61));
    expect(supervisor.stderrSnapshot().length).toBe(STDERR_RING_BYTES);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        supervisor.on('exit', resolve);
      },
    );
    child.kill();
    await expect(exited).resolves.toEqual({ code: 1, signal: null });
    await supervisor.stop();
  });
});

const liveBinary = tryResolveCoreBinary({
  env: process.env,
  cargoTargetDir: process.env.CARGO_TARGET_DIR,
});

describe.skipIf(!liveBinary)('live yaqmc-core', () => {
  it(
    'reaches ready and answers core_ping',
    async () => {
      const supervisor = new CoreSupervisor({
        binary: liveBinary as string,
        hostVersion: '0.1.0',
        expectedCoreVersion: '0.1.0',
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
        ...tempDirs(),
      });
      const identity = await supervisor.start();
      expect(identity.version).toBe('0.1.0');
      await expect(supervisor.client.invoke('core_ping')).resolves.toEqual({});
      await supervisor.stop();
    },
    20_000,
  );
});
