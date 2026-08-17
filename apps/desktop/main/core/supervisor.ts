import {
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SHUTDOWN_TIMEOUT_MS,
  type CoreIdentity,
  type CoreMessage,
  type PlatformKind,
  type ShutdownReason,
} from '@yaqmc/client';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { CoreClient } from './client';
import { ProtocolError } from './frames';

export const STDERR_RING_BYTES = 64 * 1024;
export const CORE_BINARY_NAME = process.platform === 'win32' ? 'yaqmc-core.exe' : 'yaqmc-core';

export type SpawnCore = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type SupervisorPaths = {
  dataDir: string;
  cacheDir: string;
  logDir: string;
  configDir: string;
};

export type SupervisorOptions = SupervisorPaths & {
  binary: string;
  hostVersion: string;
  expectedCoreVersion?: string;
  channel?: string;
  handshakeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
  spawn?: SpawnCore;
};

export type CoreBinaryLookup = {
  env?: NodeJS.ProcessEnv;
  stagedDir?: string;
  resourcesPath?: string;
  cargoTargetDir?: string;
  repoRoot?: string;
};

export function coreBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'yaqmc-core.exe' : 'yaqmc-core';
}

export function tryResolveCoreBinary(lookup: CoreBinaryLookup = {}): string | undefined {
  const env = lookup.env ?? process.env;
  const name = coreBinaryName();
  const candidates: string[] = [];
  if (env.YAQMC_CORE_BIN) {
    candidates.push(env.YAQMC_CORE_BIN);
  }
  if (lookup.resourcesPath) {
    candidates.push(path.join(lookup.resourcesPath, 'core', name));
  }
  if (lookup.stagedDir) {
    candidates.push(path.join(lookup.stagedDir, name));
  }
  const cargoTarget = lookup.cargoTargetDir ?? env.CARGO_TARGET_DIR;
  if (cargoTarget) {
    candidates.push(path.join(cargoTarget, 'debug', name), path.join(cargoTarget, 'release', name));
  }
  if (lookup.repoRoot) {
    candidates.push(
      path.join(lookup.repoRoot, 'target', 'debug', name),
      path.join(lookup.repoRoot, 'target', 'release', name),
    );
  }
  return candidates.find((candidate) => existsSync(candidate));
}

export function resolveCoreBinary(lookup: CoreBinaryLookup = {}): string {
  const found = tryResolveCoreBinary(lookup);
  if (!found) {
    throw new Error('yaqmc-core binary was not found (set YAQMC_CORE_BIN or stage resources/core)');
  }
  return found;
}

export function hostPlatformKind(platform = process.platform): PlatformKind {
  return platform === 'win32' ? 'windows' : 'linux';
}

export function createAttachMessage(
  hostVersion: string,
  platformKind: PlatformKind = hostPlatformKind(),
): Extract<CoreMessage, { kind: 'attach' }> {
  return {
    kind: 'attach',
    protocol: PROTOCOL_VERSION,
    host: { app: 'yaqmc', version: hostVersion },
    platform: { platformKind },
  };
}

export async function hostHandshake(
  client: CoreClient,
  attach: Extract<CoreMessage, { kind: 'attach' }>,
  options: { timeoutMs?: number; expectedCoreVersion?: string } = {},
): Promise<CoreIdentity> {
  const timeoutMs = options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  client.start();

  const hello = await nextMessage(client, remaining(), 'handshake');
  if (hello.kind !== 'hello') {
    throw new ProtocolError(`handshake expected hello, got ${hello.kind}`, false);
  }
  if (hello.protocol !== PROTOCOL_VERSION) {
    throw new ProtocolError(`handshake protocol mismatch: ${hello.protocol}`, false);
  }
  if (options.expectedCoreVersion && hello.core.version !== options.expectedCoreVersion) {
    throw new ProtocolError(
      `handshake version mismatch: expected ${options.expectedCoreVersion}, found ${hello.core.version}`,
      false,
    );
  }

  await client.send(attach);
  const ready = await nextMessage(client, remaining(), 'handshake');
  if (ready.kind !== 'ready') {
    throw new ProtocolError(`handshake expected ready, got ${ready.kind}`, false);
  }
  return hello.core;
}

export class CoreSupervisor extends EventEmitter {
  private child: ChildProcess | undefined;
  private clientInstance: CoreClient | undefined;
  private identity: CoreIdentity | undefined;
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;

  constructor(private readonly options: SupervisorOptions) {
    super();
  }

  get client(): CoreClient {
    if (!this.clientInstance) {
      throw new Error('core supervisor is not running');
    }
    return this.clientInstance;
  }

  get coreIdentity(): CoreIdentity | undefined {
    return this.identity;
  }

  stderrSnapshot(): Buffer {
    return Buffer.concat(this.stderrChunks);
  }

  async start(): Promise<CoreIdentity> {
    for (const dir of [
      this.options.dataDir,
      this.options.cacheDir,
      this.options.logDir,
      this.options.configDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    const spawnCore = this.options.spawn ?? spawn;
    const child = spawnCore(this.options.binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...this.options.extraEnv,
        YAQMC_DATA_DIR: this.options.dataDir,
        YAQMC_CACHE_DIR: this.options.cacheDir,
        YAQMC_LOG_DIR: this.options.logDir,
        YAQMC_CONFIG_DIR: this.options.configDir,
        YAQMC_CHANNEL: this.options.channel ?? 'desktop',
      },
    });
    this.child = child;
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      throw new Error('yaqmc-core spawn did not provide stdio pipes');
    }
    child.stderr.on('data', (chunk: Buffer) => {
      this.pushStderr(chunk);
    });
    child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
    });
    const client = new CoreClient({
      readable: child.stdout as Readable,
      writable: child.stdin as Writable,
    });
    this.clientInstance = client;
    try {
      this.identity = await hostHandshake(client, createAttachMessage(this.options.hostVersion), {
        timeoutMs: this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        expectedCoreVersion: this.options.expectedCoreVersion,
      });
      return this.identity;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async stop(reason: ShutdownReason = 'quit'): Promise<void> {
    const child = this.child;
    const client = this.clientInstance;
    if (!child || !client) {
      return;
    }
    if (child.exitCode === null) {
      try {
        await client.send({ kind: 'shutdown', reason });
        const ack = await nextMessage(
          client,
          this.options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS,
          'shutdown',
        );
        if (ack.kind !== 'shutdown-ack') {
          throw new ProtocolError(`shutdown expected shutdown-ack, got ${ack.kind}`, false);
        }
      } catch {
        // kill below
      }
      if (child.exitCode === null) {
        child.kill();
      }
    }
    client.close();
  }

  private pushStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.length;
    while (this.stderrBytes > STDERR_RING_BYTES) {
      const overflow = this.stderrBytes - STDERR_RING_BYTES;
      const first = this.stderrChunks[0];
      if (!first) {
        break;
      }
      if (first.length <= overflow) {
        this.stderrChunks.shift();
        this.stderrBytes -= first.length;
      } else {
        this.stderrChunks[0] = first.subarray(overflow);
        this.stderrBytes -= overflow;
      }
    }
  }
}

function nextMessage(
  client: CoreClient,
  timeoutMs: number,
  label: 'handshake' | 'shutdown',
): Promise<CoreMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new ProtocolError(`${label} timed out`, false));
    }, timeoutMs);

    const onMessage = (message: CoreMessage): void => {
      cleanup();
      resolve(message);
    };
    const onFail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off('message', onMessage);
      client.off('error', onFail);
      client.off('close', onFail);
    };

    client.on('message', onMessage);
    client.on('error', onFail);
    client.on('close', onFail);
  });
}
