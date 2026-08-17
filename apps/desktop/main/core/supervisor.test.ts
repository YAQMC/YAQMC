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
  CORE_SPAWN_ENV_ALLOWLIST,
  buildCoreSpawnEnv,
} from './env';
import { corePidPath } from './pid';
import {
  CoreSupervisor,
  STDERR_RING_BYTES,
  coreBinaryName,
  createAttachMessage,
  hostHandshake,
  hostPlatformKind,
  resolveCoreLaunch,
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

function mockChild() {
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
  return { child, stdout, stdin, stderr };
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
    expect(
      resolveCoreLaunch({
        env: {},
        stagedDir,
        cargoTargetDir: path.join(root, 'cargo'),
      }),
    ).toEqual({ binary: path.join(stagedDir, name), integrity: 'required' });
    expect(
      resolveCoreLaunch({
        env: {},
        cargoTargetDir: path.join(root, 'cargo'),
      }),
    ).toEqual({ binary: path.join(cargoDebug, name), integrity: 'optional' });
  });
});

describe('core spawn env allowlist', () => {
  const paths = {
    dataDir: '/tmp/yaqmc/data',
    cacheDir: '/tmp/yaqmc/cache',
    logDir: '/tmp/yaqmc/logs',
    configDir: '/tmp/yaqmc/config',
  };

  const parentEnv: NodeJS.ProcessEnv = {
    Path: 'C:\\Windows\\system32',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\test',
    APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    TEMP: 'C:\\Users\\test\\AppData\\Local\\Temp',
    HOME: '/home/test',
    USER: 'test',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_TIME: 'C',
    LC_MESSAGES: 'en_US.UTF-8',
    TZ: 'UTC',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XAUTHORITY: '/home/test/.Xauthority',
    YAQMC_LOG_LEVEL: 'debug',
    YAQMC_CORE_BIN: 'C:\\secret\\yaqmc-core.exe',
    YAQMC_DESKTOP_SMOKE: '1',
    WEBKIT_DISABLE_COMPOSITING_MODE: '1',
    WEBKITGTK_DISABLE_DMA_BUF_RENDERER: '1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG',
    GITHUB_TOKEN: 'ghp_notarealtoken',
    RANDOM_USER_VAR: 'nope',
  };

  it('commits the session, locale, and profile keys required for spawn', () => {
    expect(CORE_SPAWN_ENV_ALLOWLIST).toEqual(
      expect.arrayContaining([
        'PATH',
        'SYSTEMROOT',
        'HOME',
        'USERPROFILE',
        'APPDATA',
        'LOCALAPPDATA',
        'LANG',
        'LC_ALL',
        'DBUS_SESSION_BUS_ADDRESS',
        'XDG_RUNTIME_DIR',
        'DISPLAY',
        'WAYLAND_DISPLAY',
      ]),
    );
  });

  it('copies allowlisted parent vars and strips the rest', () => {
    const env = buildCoreSpawnEnv({ ...paths, parentEnv, channel: 'desktop' });
    expect(env).toMatchObject({
      Path: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\test',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      HOME: '/home/test',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_TIME: 'C',
      LC_MESSAGES: 'en_US.UTF-8',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      YAQMC_LOG_LEVEL: 'debug',
      YAQMC_DATA_DIR: paths.dataDir,
      YAQMC_CACHE_DIR: paths.cacheDir,
      YAQMC_LOG_DIR: paths.logDir,
      YAQMC_CONFIG_DIR: paths.configDir,
      YAQMC_CHANNEL: 'desktop',
    });
    expect(env).not.toHaveProperty('WEBKIT_DISABLE_COMPOSITING_MODE');
    expect(env).not.toHaveProperty('WEBKITGTK_DISABLE_DMA_BUF_RENDERER');
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('RANDOM_USER_VAR');
    expect(env).not.toHaveProperty('YAQMC_CORE_BIN');
    expect(env).not.toHaveProperty('YAQMC_DESKTOP_SMOKE');
  });

  it('lets extraEnv overlay allowlisted and YAQMC_* keys only', () => {
    const env = buildCoreSpawnEnv({
      ...paths,
      parentEnv,
      extraEnv: {
        YAQMC_LOG_LEVEL: 'trace',
        YAQMC_CHANNEL: 'ignored-until-forced',
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
        GITHUB_TOKEN: 'should-not-pass',
      },
    });
    expect(env.YAQMC_LOG_LEVEL).toBe('trace');
    expect(env.YAQMC_CHANNEL).toBe('desktop');
    expect(env).not.toHaveProperty('WEBKIT_DISABLE_COMPOSITING_MODE');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });
});

describe('CoreSupervisor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns, handshakes, detects exit, and keeps a 64 KiB stderr ring', async () => {
    const { child, stdout, stdin, stderr } = mockChild();

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

  it('spawns core with the allowlisted env, not the parent process.env dump', async () => {
    const { child, stdout, stdin } = mockChild();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const spawnCore: SpawnCore = (_command, _args, options) => {
      spawnedEnv = options.env;
      return child as unknown as ChildProcess;
    };
    const dirs = tempDirs();
    const supervisor = new CoreSupervisor({
      binary: coreBinaryName(),
      hostVersion: '0.1.0',
      expectedCoreVersion: '0.1.0',
      ...dirs,
      parentEnv: {
        USERPROFILE: 'C:\\Users\\test',
        APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
        AWS_SECRET_ACCESS_KEY: 'secret',
      },
      spawn: spawnCore,
    });

    const started = supervisor.start();
    const nextFrame = collectFrames(stdin);
    pushMessage(stdout, hello);
    await expect(nextFrame()).resolves.toMatchObject({ kind: 'attach' });
    pushMessage(stdout, { kind: 'ready' });
    await expect(started).resolves.toEqual(hello.core);

    expect(spawnedEnv).toMatchObject({
      USERPROFILE: 'C:\\Users\\test',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      YAQMC_DATA_DIR: dirs.dataDir,
      YAQMC_CHANNEL: 'desktop',
    });
    expect(spawnedEnv).not.toHaveProperty('WEBKIT_DISABLE_COMPOSITING_MODE');
    expect(spawnedEnv).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    child.kill();
    await supervisor.stop();
  });

  it('kills a leftover yaqmc-core pid before spawn and ignores unrelated images', async () => {
    const { child, stdout, stdin } = mockChild();
    const dirs = tempDirs();
    mkdirSync(dirs.dataDir, { recursive: true });
    writeFileSync(corePidPath(dirs.dataDir), '4242\n');
    const killed: number[] = [];
    const supervisor = new CoreSupervisor({
      binary: coreBinaryName(),
      hostVersion: '0.1.0',
      expectedCoreVersion: '0.1.0',
      ...dirs,
      spawn: () => child as unknown as ChildProcess,
      processProbe: {
        imageName: (pid) => (pid === 4242 ? 'yaqmc-core.exe' : undefined),
        kill: (pid) => {
          killed.push(pid);
        },
      },
    });

    const started = supervisor.start();
    const nextFrame = collectFrames(stdin);
    pushMessage(stdout, hello);
    await expect(nextFrame()).resolves.toMatchObject({ kind: 'attach' });
    pushMessage(stdout, { kind: 'ready' });
    await expect(started).resolves.toEqual(hello.core);
    expect(killed).toEqual([4242]);

    writeFileSync(corePidPath(dirs.dataDir), '7\n');
    const ignored: number[] = [];
    const second = new CoreSupervisor({
      binary: coreBinaryName(),
      hostVersion: '0.1.0',
      expectedCoreVersion: '0.1.0',
      ...dirs,
      spawn: () => {
        throw new Error('must not spawn after ignored pid');
      },
      processProbe: {
        imageName: () => 'notepad.exe',
        kill: (pid) => {
          ignored.push(pid);
        },
      },
    });
    await expect(second.start()).rejects.toThrow('must not spawn after ignored pid');
    expect(ignored).toEqual([]);
    child.kill();
    await supervisor.stop();
  });

  it('does not spawn when a staged binary fails sha256 verify', async () => {
    const dirs = tempDirs();
    const name = coreBinaryName();
    const stagedDir = path.join(dirs.dataDir, 'staged');
    mkdirSync(stagedDir, { recursive: true });
    const binary = path.join(stagedDir, name);
    writeFileSync(binary, 'core-bytes');
    writeFileSync(
      path.join(stagedDir, 'manifest.json'),
      `${JSON.stringify({ name, sha256: '0'.repeat(64), bytes: 10 }, null, 2)}\n`,
    );
    let spawned = false;
    const supervisor = new CoreSupervisor({
      binary,
      integrity: 'required',
      hostVersion: '0.1.0',
      ...dirs,
      spawn: () => {
        spawned = true;
        throw new Error('must not spawn a tampered core');
      },
    });
    await expect(supervisor.start()).rejects.toMatchObject({
      name: 'CoreIntegrityError',
      message: expect.stringContaining('sha256 mismatch'),
    });
    expect(spawned).toBe(false);
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
