import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect } from 'react';
import {
  BUILTIN_CLASSIC_ID,
  factoryScene,
  LYRICS_PRESET_SCHEMA_VERSION,
  normalizeLyricsPresetState,
  setPluginPresetCatalog,
  type LyricsPresetDefinition,
} from './lyrics-preset';
import { isNativeRuntime } from './native-player-runtime';
import { usePlayerStore } from './player-store';
import { usePreferencesStore } from './preferences';
import { logger } from './logger';

export type PluginStatus =
  'installed' | 'disabled' | 'enabling' | 'active' | 'disabling' | 'failed' | 'incompatible';

export interface PluginScanReport {
  severity: 'low' | 'medium' | 'high' | null;
  findings: Array<{ severity: string; kind: string; count: number; detail: string }>;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  authors: string[];
  enabled: boolean;
  status: PluginStatus;
  statusReason?: string | null;
  apiVersion: number;
  packageSha256: string;
  source: string;
  unsigned: boolean;
  entrypoints: { styles: number; scenes: number; script: boolean };
  permissions: string[];
  grantedPermissions: string[];
  riskRating: string;
  styleScan: PluginScanReport;
  scriptScan: PluginScanReport;
  compatible: boolean;
  platforms: string[];
  settingsSchema?: unknown;
}

export interface ActiveStyleSheet {
  pluginId: string;
  css: string;
}

export interface ActiveSceneResource {
  pluginId: string;
  pluginName: string;
  sceneId: string;
  css?: string | null;
  definition: unknown;
}

export interface ActiveScriptResource {
  pluginId: string;
  source: string;
}

export interface ActivePluginResources {
  safeMode: boolean;
  developerMode: boolean;
  styleOrder: string[];
  styles: ActiveStyleSheet[];
  scenes: ActiveSceneResource[];
  scripts: ActiveScriptResource[];
}

export interface PluginInspectResult {
  sha256: string;
  compressedBytes: number;
  expandedBytes: number;
  fileCount: number;
  manifest: { id: string; name: string; version: string; authors?: string[] };
  permissions: string[];
  styleScan: PluginScanReport;
  scriptScan: PluginScanReport;
  files: string[];
}

const STYLE_ATTR = 'data-yaqmc-plugin-style';
const SCENE_STYLE_ATTR = 'data-yaqmc-plugin-scene-style';

let workers = new Map<string, Worker>();
let runtimeTokens = new Map<string, string>();
let lastPositionEmit = 0;
let lastTrackKey = '';
let applying = false;

export function pluginWorkerBootstrap(source: string): string {
  return `'use strict';
self.fetch = function () { return Promise.reject(new Error('network denied')); };
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.EventSource = undefined;
self.importScripts = function () { throw new Error('importScripts denied'); };
self.__TAURI__ = undefined;
self.document = undefined;
var __yaqmcListeners = {};
var __yaqmcSeq = 1;
var __yaqmcPending = {};
function __yaqmcCall(method, payload) {
  var id = String(__yaqmcSeq++);
  return new Promise(function (resolve, reject) {
    __yaqmcPending[id] = { resolve: resolve, reject: reject };
    self.postMessage({ type: 'yaqmc/call', id: id, method: method, payload: payload || {} });
  });
}
self.onmessage = function (event) {
  var data = event.data || {};
  if (data.type === 'yaqmc/result' && __yaqmcPending[data.id]) {
    var pending = __yaqmcPending[data.id];
    delete __yaqmcPending[data.id];
    if (data.ok) pending.resolve(data.value);
    else pending.reject(new Error(data.error || 'plugin bridge failed'));
    return;
  }
  if (data.type === 'yaqmc/event') {
    var list = __yaqmcListeners[data.event] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](data.payload); } catch (error) { self.postMessage({ type: 'yaqmc/error', message: String(error) }); }
    }
  }
};
var ctx = {
  events: {
    on: function (event, handler) {
      (__yaqmcListeners[event] || (__yaqmcListeners[event] = [])).push(handler);
      return function () {
        __yaqmcListeners[event] = (__yaqmcListeners[event] || []).filter(function (item) { return item !== handler; });
      };
    }
  },
  track: { get: function () { return __yaqmcCall('track.get'); } },
  lyrics: { get: function () { return __yaqmcCall('lyrics.get'); } },
  player: {
    get: function () { return __yaqmcCall('player.get'); },
    play: function () { return __yaqmcCall('player.play'); },
    pause: function () { return __yaqmcCall('player.pause'); },
    toggle: function () { return __yaqmcCall('player.toggle'); },
    next: function () { return __yaqmcCall('player.next'); },
    previous: function () { return __yaqmcCall('player.previous'); },
    seek: function (positionMs) { return __yaqmcCall('player.seek', { positionMs: positionMs }); }
  },
  theme: { get: function () { return __yaqmcCall('theme.get'); } },
  storage: {
    get: function (key) { return __yaqmcCall('storage.get', { key: String(key || '') }); },
    set: function (key, value) { return __yaqmcCall('storage.set', { key: String(key || ''), value: String(value || '') }); }
  },
  log: {
    info: function (message) { return __yaqmcCall('log.info', { message: String(message || '') }); },
    warn: function (message) { return __yaqmcCall('log.warn', { message: String(message || '') }); },
    error: function (message) { return __yaqmcCall('log.error', { message: String(message || '') }); }
  }
};
var definePlugin = function (definition) { self.__yaqmcPlugin = definition; };
self.definePlugin = definePlugin;
try {
${source}
  var plugin = self.__yaqmcPlugin;
  if (plugin && typeof plugin.activate === 'function') {
    var cleanup = plugin.activate(ctx);
    self.__yaqmcCleanup = typeof cleanup === 'function' ? cleanup : function () {};
  }
  self.postMessage({ type: 'yaqmc/ready' });
} catch (error) {
  self.postMessage({ type: 'yaqmc/error', message: String(error && error.message ? error.message : error) });
}
`;
}

function cssIdent(pluginId: string): string {
  return pluginId.replace(/[^a-z0-9-]+/gi, '-');
}

function clearInjectedStyles(attribute: string): void {
  document.querySelectorAll(`style[${attribute}]`).forEach((node) => node.remove());
}

function applyStyleSheets(sheets: ActiveStyleSheet[]): void {
  clearInjectedStyles(STYLE_ATTR);
  sheets.forEach((sheet, index) => {
    const style = document.createElement('style');
    style.setAttribute(STYLE_ATTR, sheet.pluginId);
    style.setAttribute('data-yaqmc-style-order', String(index));
    style.textContent = `@layer yaqmc-plugin-style.${cssIdent(sheet.pluginId)} {\n${sheet.css}\n}`;
    document.head.appendChild(style);
  });
}

function applySceneSheets(scenes: ActiveSceneResource[]): void {
  clearInjectedStyles(SCENE_STYLE_ATTR);
  for (const scene of scenes) {
    if (!scene.css) continue;
    const style = document.createElement('style');
    style.setAttribute(SCENE_STYLE_ATTR, scene.pluginId);
    style.textContent = `@scope ([data-yaqmc-plugin-scene="${scene.pluginId}"]) {\n${scene.css}\n}`;
    document.head.appendChild(style);
  }
}

function toPluginPreset(scene: ActiveSceneResource): LyricsPresetDefinition | null {
  const source = scene.definition && typeof scene.definition === 'object' ? scene.definition : {};
  const normalized = normalizeLyricsPresetState({
    selectedId: 'custom.plugin',
    custom: [
      {
        ...(source as object),
        id: `custom.plugin`,
        name: scene.sceneId,
        source: 'custom',
      },
    ],
  });
  const definition = normalized.custom[0];
  if (!definition) {
    return {
      schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
      id: `plugin:${scene.pluginId}:${scene.sceneId}`,
      nameKey: 'custom',
      name: scene.sceneId,
      source: 'plugin',
      pluginId: scene.pluginId,
      pluginName: scene.pluginName,
      layout: 'split',
      typography: { fontScale: 1, lineHeight: 1.16 },
      artwork: { style: 'square' },
      background: { fit: 'cover', fallbackColor: '#20231C' },
      scene: factoryScene('split'),
    };
  }
  return {
    ...definition,
    id: `plugin:${scene.pluginId}:${scene.sceneId}`,
    source: 'plugin',
    pluginId: scene.pluginId,
    pluginName: scene.pluginName,
    name:
      typeof (source as { name?: string }).name === 'string'
        ? (source as { name: string }).name
        : scene.sceneId,
  };
}

function stopScripts(): void {
  for (const worker of workers.values()) {
    worker.terminate();
  }
  workers = new Map();
  void Promise.all(
    [...runtimeTokens.values()].map((token) =>
      invoke('plugin_runtime_stop', { token }).catch(() => undefined),
    ),
  );
  runtimeTokens = new Map();
}

async function startScripts(scripts: ActiveScriptResource[]): Promise<void> {
  stopScripts();
  for (const script of scripts) {
    try {
      const token = await invoke<string>('plugin_runtime_start', { pluginId: script.pluginId });
      runtimeTokens.set(script.pluginId, token);
      const blob = new Blob([pluginWorkerBootstrap(script.source)], {
        type: 'text/javascript',
      });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url, { name: `yaqmc-plugin-${script.pluginId}` });
      URL.revokeObjectURL(url);
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data as {
          type?: string;
          id?: string;
          method?: string;
          payload?: unknown;
          message?: string;
        };
        if (data.type === 'yaqmc/error') {
          logger.error('plugin.runtime.error', data.message ?? 'plugin runtime error', {
            pluginId: script.pluginId,
          });
          void invoke('plugin_mark_failed', {
            id: script.pluginId,
            reason: data.message ?? 'plugin runtime error',
          }).catch(() => undefined);
          worker.terminate();
          workers.delete(script.pluginId);
          return;
        }
        if (data.type !== 'yaqmc/call' || !data.id || !data.method) return;
        const boundToken = runtimeTokens.get(script.pluginId);
        void invoke('plugin_bridge', {
          request: { token: boundToken, method: data.method, payload: data.payload ?? {} },
        })
          .then((value) => {
            worker.postMessage({ type: 'yaqmc/result', id: data.id, ok: true, value });
          })
          .catch((error: unknown) => {
            worker.postMessage({
              type: 'yaqmc/result',
              id: data.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      };
      worker.onerror = (event) => {
        logger.error('plugin.runtime.error', event.message, { pluginId: script.pluginId });
        void invoke('plugin_mark_failed', {
          id: script.pluginId,
          reason: event.message || 'plugin runtime error',
        }).catch(() => undefined);
      };
      workers.set(script.pluginId, worker);
    } catch (error) {
      logger.error(
        'plugin.runtime.error',
        error instanceof Error ? error.message : 'plugin runtime failed to start',
        { pluginId: script.pluginId },
      );
    }
  }
}

function emitToPlugins(event: string, payload: unknown): void {
  for (const worker of workers.values()) {
    worker.postMessage({ type: 'yaqmc/event', event, payload });
  }
}

export async function applyPluginResources(): Promise<ActivePluginResources | null> {
  if (!isNativeRuntime || applying) return null;
  applying = true;
  try {
    const resources = await invoke<ActivePluginResources>('plugin_active_resources');
    applyStyleSheets(resources.safeMode ? [] : resources.styles);
    applySceneSheets(resources.safeMode ? [] : resources.scenes);
    const presets = (resources.safeMode ? [] : resources.scenes)
      .map(toPluginPreset)
      .filter((preset): preset is LyricsPresetDefinition => preset !== null);
    setPluginPresetCatalog(presets);
    const selectedId = usePreferencesStore.getState().lyricsPresets.selectedId;
    if (selectedId.startsWith('plugin:') && !presets.some((preset) => preset.id === selectedId)) {
      usePreferencesStore.getState().selectLyricsPreset(BUILTIN_CLASSIC_ID);
    }
    await startScripts(resources.safeMode ? [] : resources.scripts);
    return resources;
  } finally {
    applying = false;
  }
}

export async function listPlugins(): Promise<PluginRecord[]> {
  if (!isNativeRuntime) return [];
  return invoke<PluginRecord[]>('plugin_list');
}

export async function inspectPluginPath(path: string): Promise<PluginInspectResult> {
  return invoke<PluginInspectResult>('plugin_inspect_path', { path });
}

export async function installPlugin(
  path: string,
  options: { enable?: boolean; grant?: string[] } = {},
): Promise<PluginRecord> {
  const record = await invoke<PluginRecord>('plugin_install', {
    request: { path, enable: options.enable ?? false, grant: options.grant ?? [] },
  });
  await applyPluginResources();
  return record;
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
  grant: string[] = [],
): Promise<PluginRecord> {
  const record = await invoke<PluginRecord>('plugin_set_enabled', {
    request: { id, enabled, grant },
  });
  await applyPluginResources();
  return record;
}

export async function uninstallPlugin(id: string, removeData: boolean): Promise<void> {
  await invoke('plugin_uninstall', { request: { id, removeData } });
  await applyPluginResources();
}

export async function setPluginSafeMode(enabled: boolean): Promise<boolean> {
  const next = await invoke<boolean>('plugin_set_safe_mode', { enabled });
  await applyPluginResources();
  return next;
}

export async function choosePluginFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: 'YAQMC Plugin', extensions: ['yaqmc-plugin', 'css', 'js', 'ts'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

export function pluginDiagnosticsText(record: PluginRecord): string {
  return [
    `id=${record.id}`,
    `version=${record.version}`,
    `status=${record.status}`,
    `enabled=${record.enabled}`,
    `sha256=${record.packageSha256}`,
    `permissions=${record.grantedPermissions.join(',')}`,
    `risk=${record.riskRating}`,
    `source=${record.source}`,
    `unsigned=${record.unsigned}`,
  ].join('\n');
}

export function usePluginHost(): void {
  useEffect(() => {
    if (!isNativeRuntime) return;
    void applyPluginResources();
    let unlisten: (() => void) | undefined;
    void listen('plugin://changed', () => {
      void applyPluginResources();
    }).then((fn) => {
      unlisten = fn;
    });
    const unsubscribe = usePlayerStore.subscribe((state, previous) => {
      const track = state.queue[state.currentIndex ?? -1];
      const previousTrack = previous.queue[previous.currentIndex ?? -1];
      const trackKey = `${state.sessionId}:${state.currentQueueEntryId}:${track?.id ?? ''}`;
      if (trackKey !== lastTrackKey) {
        lastTrackKey = trackKey;
        emitToPlugins('track.changed', {
          id: track?.id ?? null,
          title: track?.title ?? null,
          sessionId: state.sessionId,
        });
      }
      if (state.isPlaying !== previous.isPlaying || track?.id !== previousTrack?.id) {
        emitToPlugins('playback.stateChanged', {
          isPlaying: state.isPlaying,
          sessionId: state.sessionId,
        });
      }
      const now = Date.now();
      if (now - lastPositionEmit >= 250) {
        lastPositionEmit = now;
        emitToPlugins('playback.positionCommitted', {
          positionMs: state.positionMs,
          sessionId: state.sessionId,
        });
      }
    });
    return () => {
      unlisten?.();
      unsubscribe();
      stopScripts();
    };
  }, []);
}
