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
import { buildCoreSpawnEnv } from './env';
import { ProtocolError } from './frames';
import { verifyCoreBinary, type CoreIntegrityPolicy } from './integrity';
import { defaultProcessProbe, reapStaleCorePid, type ProcessProbe } from './pid';

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
  parentEnv?: NodeJS.ProcessEnv;
  spawn?: SpawnCore;
  processProbe?: ProcessProbe;
  integrity?: CoreIntegrityPolicy;
  autoRestart?: boolean;
  pingIntervalMs?: number;
  pingMissLimit?: number;
  watchdogPing?: () => Promise<void>;
};

export const CORE_PING_INTERVAL_MS = 5_000;
export const CORE_PING_MISS_LIMIT = 3;
export const CORE_RESTART_BACKOFF_MS = [500, 2_000, 8_000] as const;
export const CORE_RESTART_WINDOW_MS = 60_000;
export const CORE_MAX_RESTARTS_PER_WINDOW = 3;

export type CoreRuntimeStatus = 'down' | 'restarting' | 'ready' | 'safe-mode';

export type CoreStatusPayload = {
  status: CoreRuntimeStatus;
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

export type CoreLaunch = {
  binary: string;
  integrity: CoreIntegrityPolicy;
};

export function tryResolveCoreBinary(lookup: CoreBinaryLookup = {}): string | undefined {
  return resolveCoreLaunch(lookup)?.binary;
}

export function resolveCoreLaunch(lookup: CoreBinaryLookup = {}): CoreLaunch | undefined {
  const env = lookup.env ?? process.env;
  const name = coreBinaryName();
  if (env.YAQMC_CORE_BIN && existsSync(env.YAQMC_CORE_BIN)) {
    return { binary: env.YAQMC_CORE_BIN, integrity: 'optional' };
  }
  if (lookup.resourcesPath) {
    const packaged = path.join(lookup.resourcesPath, 'core', name);
    if (existsSync(packaged)) {
      return { binary: packaged, integrity: 'required' };
    }
  }
  if (lookup.stagedDir) {
    const staged = path.join(lookup.stagedDir, name);
    if (existsSync(staged)) {
      return { binary: staged, integrity: 'required' };
    }
  }
  const cargoTarget = lookup.cargoTargetDir ?? env.CARGO_TARGET_DIR;
  const cargoCandidates = cargoTarget
    ? [path.join(cargoTarget, 'debug', name), path.join(cargoTarget, 'release', name)]
    : [];
  const repoCandidates = lookup.repoRoot
    ? [
        path.join(lookup.repoRoot, 'target', 'debug', name),
        path.join(lookup.repoRoot, 'target', 'release', name),
      ]
    : [];
  const found = [...cargoCandidates, ...repoCandidates].find((candidate) => existsSync(candidate));
  if (!found) {
    return undefined;
  }
  return { binary: found, integrity: 'optional' };
}

export function resolveCoreBinary(lookup: CoreBinaryLookup = {}): string {
  const found = tryResolveCoreBinary(lookup);
  if (!found) {
    throw new Error('yaqmc-core binary was not found (set YAQMC_CORE_BIN or stage resources/core)');
  }
  return found;
}

export function hostPlatformKind(platform: string = process.platform): PlatformKind {
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
  private stopping = false;
  private allowRestart = false;
  private restartInFlight = false;
  private crashAt: number[] = [];
  private restartTotal = 0;
  private lastPongAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pingInFlight = false;
  private runtimeStatus: CoreRuntimeStatus = 'down';

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

  get status(): CoreRuntimeStatus {
    return this.runtimeStatus;
  }

  /** E2E/test: SIGTERM the live child so the crash-restart path runs. Does not `stop()`. */
  killRunningChild(): boolean {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return false;
    }
    return child.kill();
  }

  stderrSnapshot(): Buffer {
    return Buffer.concat(this.stderrChunks);
  }

  restartCount(): number {
    return this.restartTotal;
  }

  async start(): Promise<CoreIdentity> {
    this.stopping = false;
    this.crashAt = [];
    for (const dir of [
      this.options.dataDir,
      this.options.cacheDir,
      this.options.logDir,
      this.options.configDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    this.identity = await this.spawnAndHandshake();
    this.allowRestart = this.options.autoRestart !== false;
    this.emitStatus('ready');
    this.emit('ready', { restart: false });
    this.startWatchdog();
    return this.identity;
  }

  async stop(reason: ShutdownReason = 'quit'): Promise<void> {
    this.stopping = true;
    this.allowRestart = false;
    this.stopWatchdog();
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

  private async spawnAndHandshake(): Promise<CoreIdentity> {
    reapStaleCorePid(this.options.dataDir, this.options.processProbe ?? defaultProcessProbe());
    verifyCoreBinary(this.options.binary, this.options.integrity ?? 'optional');
    const spawnCore = this.options.spawn ?? spawn;
    const child = spawnCore(this.options.binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildCoreSpawnEnv({
        parentEnv: this.options.parentEnv,
        extraEnv: this.options.extraEnv,
        dataDir: this.options.dataDir,
        cacheDir: this.options.cacheDir,
        logDir: this.options.logDir,
        configDir: this.options.configDir,
        channel: this.options.channel,
      }),
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
      this.onChildExit();
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

  private onChildExit(): void {
    this.stopWatchdog();
    this.clientInstance = undefined;
    if (this.stopping || !this.allowRestart || this.restartInFlight) {
      return;
    }
    void this.restartAfterCrash();
  }

  private async restartAfterCrash(): Promise<void> {
    this.restartInFlight = true;
    try {
      while (!this.stopping && this.allowRestart) {
        this.emitStatus('down');
        const now = Date.now();
        this.crashAt = this.crashAt.filter((stamp) => now - stamp < CORE_RESTART_WINDOW_MS);
        this.crashAt.push(now);
        if (this.crashAt.length > CORE_MAX_RESTARTS_PER_WINDOW) {
          this.allowRestart = false;
          this.emitStatus('safe-mode');
          return;
        }
        const delay =
          CORE_RESTART_BACKOFF_MS[
            Math.min(this.crashAt.length - 1, CORE_RESTART_BACKOFF_MS.length - 1)
          ] ?? CORE_RESTART_BACKOFF_MS[0];
        this.emitStatus('restarting');
        await sleep(delay);
        if (this.stopping) {
          return;
        }
        try {
          await this.spawnAndHandshake();
          this.restartTotal += 1;
          this.emitStatus('ready');
          this.emit('ready', { restart: true });
          this.startWatchdog();
          return;
        } catch {
          // Handshake failed; loop counts another crash.
        }
      }
    } finally {
      this.restartInFlight = false;
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    if (this.options.autoRestart === false) {
      return;
    }
    this.lastPongAt = Date.now();
    const interval = this.options.pingIntervalMs ?? CORE_PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => {
      void this.tickPing();
    }, interval);
  }

  private async tickPing(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const interval = this.options.pingIntervalMs ?? CORE_PING_INTERVAL_MS;
    const missLimit = this.options.pingMissLimit ?? CORE_PING_MISS_LIMIT;
    if (Date.now() - this.lastPongAt >= interval * missLimit) {
      this.child?.kill();
      return;
    }
    if (this.pingInFlight || !this.clientInstance) {
      return;
    }
    this.pingInFlight = true;
    try {
      const ping =
        this.options.watchdogPing ??
        (() => this.clientInstance?.invoke('core_ping').then(() => undefined) ?? Promise.resolve());
      await ping();
      this.lastPongAt = Date.now();
    } catch {
      // Missed ping; lastPongAt stays so three 5s gaps fail closed.
    } finally {
      this.pingInFlight = false;
    }
  }

  private stopWatchdog(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.pingInFlight = false;
  }

  private emitStatus(status: CoreRuntimeStatus): void {
    this.runtimeStatus = status;
    this.emit('status', { status } satisfies CoreStatusPayload);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
