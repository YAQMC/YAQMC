// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  choosePluginFile,
  installPlugin,
  isPluginSceneMutationCurrent,
  pluginDiagnosticsText,
  pluginWorkerBootstrap,
  setPluginSceneInstance,
} from './plugin-runtime';

const invokeMock = vi.hoisted(() => vi.fn());
const hostKind = vi.hoisted(() => ({ value: 'tauri' as 'electron' | 'tauri' | 'fake' }));

vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke: invokeMock,
    on: vi.fn(() => () => undefined),
    bridge: {
      get kind() {
        return hostKind.value;
      },
    },
  }),
}));

vi.mock('./native-player-runtime', () => ({
  isNativeRuntime: true,
}));

type IsolationProbe = {
  type: 'yaqmc/isolation-probe';
  globalThisYaqmc: string;
  selfYaqmc: string;
  windowYaqmc: string;
  importScriptsError: string;
};

function isIsolationProbe(value: unknown): value is IsolationProbe {
  if (!value || typeof value !== 'object') return false;
  return (value as { type?: unknown }).type === 'yaqmc/isolation-probe';
}

function runPluginWorkerBootstrap(source: string, pluginId: string): Promise<IsolationProbe> {
  const bootstrap = pluginWorkerBootstrap(source, pluginId);
  const wrapped =
    "'use strict';\n" +
    "const { parentPort } = require('node:worker_threads');\n" +
    'if (!parentPort) throw new Error("plugin isolation worker missing parentPort");\n' +
    'globalThis.self = globalThis;\n' +
    'globalThis.postMessage = (message) => parentPort.postMessage(message);\n' +
    "parentPort.on('message', (data) => {\n" +
    '  const handler = globalThis.onmessage;\n' +
    "  if (typeof handler === 'function') handler({ data });\n" +
    '});\n' +
    bootstrap;

  return new Promise((resolve, reject) => {
    const worker = new NodeWorker(wrapped, { eval: true });
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('plugin worker isolation probe timed out'));
    }, 5_000);

    function finish(error?: Error, probe?: IsolationProbe): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else if (probe) resolve(probe);
    }

    worker.on('message', (value: unknown) => {
      if (isIsolationProbe(value)) {
        finish(undefined, value);
        return;
      }
      const record =
        value && typeof value === 'object' ? (value as { type?: string; message?: string }) : null;
      if (record?.type === 'yaqmc/error') {
        finish(new Error(record.message ?? 'plugin worker error'));
      }
    });
    worker.on('error', (error: Error) => finish(error));
    worker.on('exit', (code: number) => {
      if (code !== 0) finish(new Error(`plugin isolation worker exited with code ${code}`));
    });
  });
}

describe('plugin runtime isolation', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'yaqmc');
    hostKind.value = 'tauri';
    invokeMock.mockReset();
  });

  it('bootstraps workers without Tauri, DOM, or network APIs', () => {
    const source = pluginWorkerBootstrap(
      'definePlugin({ activate() { return function () {}; } });',
      'dev.example',
    );
    expect(source).toContain('network denied');
    expect(source).toContain('self.__TAURI__ = undefined');
    expect(source).toContain('self.yaqmc = undefined');
    expect(source).toContain('self.document = undefined');
    expect(source).toContain('importScripts denied');
    expect(source).toContain('eval denied');
    expect(source).toContain('self.Worker = undefined');
    expect(source).toContain('network.request');
    expect(source).toContain('ui.contextMenu');
    expect(source).toContain('__yaqmcSceneInstance');
    expect(source).toContain('"dev.example"');
    expect(source).not.toMatch(/window\.__TAURI__/);
    expect(source).not.toContain('window.yaqmc');
    expect(source).not.toContain(['@', 'tauri-apps'].join(''));
  });

  it('evaluates the blob-worker bootstrap without seeing window.yaqmc', async () => {
    Reflect.set(window, 'yaqmc', {
      invoke: () => {
        throw new Error('preload invoke must not run inside a plugin worker');
      },
      on: () => () => undefined,
    });
    expect(Reflect.get(window, 'yaqmc')).toBeDefined();

    const probe = await runPluginWorkerBootstrap(
      `definePlugin({
        activate() {
          var importScriptsError = '';
          try { self.importScripts('app://yaqmc/preload/main.js'); }
          catch (error) { importScriptsError = String(error && error.message ? error.message : error); }
          var windowYaqmc = 'undefined';
          try { windowYaqmc = typeof window === 'undefined' ? 'undefined' : typeof window.yaqmc; }
          catch (error) { windowYaqmc = 'threw'; }
          self.postMessage({
            type: 'yaqmc/isolation-probe',
            globalThisYaqmc: typeof globalThis.yaqmc,
            selfYaqmc: typeof self.yaqmc,
            windowYaqmc: windowYaqmc,
            importScriptsError: importScriptsError
          });
          return function () {};
        }
      });`,
      'test.worker-isolation',
    );

    expect(probe.globalThisYaqmc).toBe('undefined');
    expect(probe.selfYaqmc).toBe('undefined');
    expect(probe.windowYaqmc).toBe('undefined');
    expect(probe.importScriptsError).toContain('importScripts denied');
  });

  it('plugin diagnostics omit source code', () => {
    const text = pluginDiagnosticsText({
      id: 'dev.example.sakura',
      name: 'Sakura',
      version: '1.0.0',
      authors: [],
      enabled: true,
      status: 'active',
      apiVersion: 1,
      packageSha256: 'abc',
      source: 'local-file',
      unsigned: true,
      entrypoints: { styles: 1, scenes: 0, script: false },
      permissions: ['style.register'],
      grantedPermissions: ['style.register'],
      riskRating: 'none',
      styleScan: { severity: null, findings: [] },
      scriptScan: { severity: null, findings: [] },
      compatible: true,
      platforms: [],
    });
    expect(text).toContain('dev.example.sakura');
    expect(text).toContain('sha256=abc');
    expect(text).not.toContain('function');
    expect(text).not.toContain('stylesheet');
  });

  it('picks plugin files through the Rust dialog command', async () => {
    invokeMock.mockResolvedValueOnce('C:\\plugin.yaqmc-plugin');
    await expect(choosePluginFile()).resolves.toBe('C:\\plugin.yaqmc-plugin');
    expect(invokeMock).toHaveBeenCalledWith('plugin_pick_package');
  });

  it('installs from an explicit path with plugin_install on Tauri', async () => {
    const record = { id: 'dev.example.sakura' };
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'plugin_install' || method === 'plugin_install_from') return record;
      if (method === 'plugin_active_resources') {
        return {
          safeMode: false,
          developerMode: false,
          styleOrder: [],
          styles: [],
          scenes: [],
          scripts: [],
        };
      }
      throw new Error(method);
    });
    await expect(installPlugin('C:\\plugin.yaqmc-plugin', { enable: true, grant: [] })).resolves.toEqual(
      record,
    );
    expect(invokeMock).toHaveBeenCalledWith('plugin_install', {
      request: { path: 'C:\\plugin.yaqmc-plugin', enable: true, grant: [] },
    });
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_install_from', expect.anything());
  });

  it('installs from an explicit path with plugin_install_from on Electron', async () => {
    hostKind.value = 'electron';
    const record = { id: 'dev.example.sakura' };
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'plugin_install' || method === 'plugin_install_from') return record;
      if (method === 'plugin_active_resources') {
        return {
          safeMode: false,
          developerMode: false,
          styleOrder: [],
          styles: [],
          scenes: [],
          scripts: [],
        };
      }
      throw new Error(method);
    });
    await expect(installPlugin('C:\\plugin.yaqmc-plugin')).resolves.toEqual(record);
    expect(invokeMock).toHaveBeenCalledWith('plugin_install_from', {
      request: { path: 'C:\\plugin.yaqmc-plugin', enable: false, grant: [] },
    });
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_install', expect.anything());
  });

  it('ignores late scene mutations after a scene switch', () => {
    const first = setPluginSceneInstance('plugin.a', 'scene-a');
    expect(isPluginSceneMutationCurrent('plugin.a', first)).toBe(true);
    expect(isPluginSceneMutationCurrent('plugin.a', 0)).toBe(false);
    const second = setPluginSceneInstance('plugin.b', 'scene-b');
    expect(isPluginSceneMutationCurrent('plugin.a', first)).toBe(false);
    expect(isPluginSceneMutationCurrent('plugin.b', second)).toBe(true);
    expect(isPluginSceneMutationCurrent('plugin.b', 0)).toBe(false);
  });
});
