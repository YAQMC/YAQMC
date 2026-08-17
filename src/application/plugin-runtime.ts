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
import { isLinuxWebView } from './platform-integration';
import { getYaqmcClient } from './yaqmc-runtime';
import { usePlayerStore } from './player-store';
import { primaryPlaybackMode } from './playback-mode';
import { usePreferencesStore } from './preferences';
import { useLyricsStore } from './lyrics-store';
import { selectLyricCursor } from './lyrics-timing';
import { logger } from './logger';
import { pushPluginNotice } from './plugin-notifications';
import {
  clearPluginUi,
  registerPluginPlayerBarAction,
  registerPluginSidebarAction,
  registerPluginTrackAction,
} from './plugin-ui';

const client = getYaqmcClient();

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
  networkOrigins?: string[];
  unpackedPath?: string | null;
  lastError?: string | null;
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
  pluginName?: string;
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
  manifest: {
    id: string;
    name: string;
    version: string;
    authors?: string[];
    apiVersion?: number;
    manifestVersion?: number;
    description?: string;
  };
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
let lastLineKey = '';
let lastQueueKey = '';
let lastModeKey = '';
let applying = false;
const sceneInstance = { id: 0, sceneId: '', pluginId: '' };
const sceneVariables = new Map<string, string>();
const sceneStates = new Map<string, string>();

export function currentPluginSceneInstance(): {
  id: number;
  sceneId: string;
  pluginId: string;
} {
  return { ...sceneInstance };
}

export function setPluginSceneInstance(pluginId: string, sceneId: string): number {
  sceneInstance.id += 1;
  sceneInstance.pluginId = pluginId;
  sceneInstance.sceneId = sceneId;
  return sceneInstance.id;
}

export function pluginSceneCssVars(): Record<string, string> {
  return Object.fromEntries(sceneVariables);
}

export function pluginSceneDataState(): string {
  return [...sceneStates.entries()].map(([key, value]) => `${key}:${value}`).join(' ');
}

const sceneListeners = new Set<() => void>();
const widgetOverrides = new Map<string, Record<string, string>>();

function emitSceneState(): void {
  sceneListeners.forEach((listener) => listener());
}

export function subscribePluginSceneState(listener: () => void): () => void {
  sceneListeners.add(listener);
  return () => sceneListeners.delete(listener);
}

export function pluginSceneWidgetOverrides(): ReadonlyMap<string, Record<string, string>> {
  return widgetOverrides;
}

function resetSceneBehavior(): void {
  sceneVariables.clear();
  sceneStates.clear();
  widgetOverrides.clear();
  emitSceneState();
}

function applySceneMutation(pluginId: string, payload: unknown): boolean {
  const source = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const instanceId = Number(source.instanceId ?? 0);
  if (sceneInstance.pluginId !== pluginId) return false;
  if (!Number.isFinite(instanceId) || instanceId <= 0 || instanceId !== sceneInstance.id) {
    return false;
  }
  return true;
}

export function isPluginSceneMutationCurrent(pluginId: string, instanceId: number): boolean {
  return applySceneMutation(pluginId, { instanceId });
}

export function pluginWorkerBootstrap(source: string, pluginId = ''): string {
  const idLiteral = JSON.stringify(pluginId);
  return `'use strict';
self.fetch = function () { return Promise.reject(new Error('network denied')); };
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.EventSource = undefined;
self.Worker = undefined;
self.SharedWorker = undefined;
self.WebAssembly = undefined;
self.importScripts = function () { throw new Error('importScripts denied'); };
self.eval = function () { throw new Error('eval denied'); };
self.Function = function () { throw new Error('Function denied'); };
self.__TAURI__ = undefined;
self.yaqmc = undefined;
self.document = undefined;
var __yaqmcListeners = {};
var __yaqmcSeq = 1;
var __yaqmcPending = {};
var __yaqmcSceneInstance = 0;
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
    if (data.event === 'scene.changed' && data.payload) {
      if (data.payload.phase === 'mount' && data.payload.pluginId === ${idLiteral}) {
        __yaqmcSceneInstance = Number(data.payload.instanceId) || 0;
      }
      if (data.payload.phase === 'unmount' && Number(data.payload.instanceId) === __yaqmcSceneInstance) {
        __yaqmcSceneInstance = 0;
      }
    }
    var list = __yaqmcListeners[data.event] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](data.payload); } catch (error) { self.postMessage({ type: 'yaqmc/error', message: String(error) }); }
    }
  }
};
var ctx = {
  plugin: { id: ${idLiteral} },
  events: {
    on: function (event, handler) {
      (__yaqmcListeners[event] || (__yaqmcListeners[event] = [])).push(handler);
      return function () {
        __yaqmcListeners[event] = (__yaqmcListeners[event] || []).filter(function (item) { return item !== handler; });
      };
    }
  },
  track: {
    get: function () { return __yaqmcCall('track.get'); },
    read: function () { return __yaqmcCall('track.read'); }
  },
  lyrics: {
    get: function () { return __yaqmcCall('lyrics.get'); },
    read: function () { return __yaqmcCall('lyrics.read'); }
  },
  player: {
    get: function () { return __yaqmcCall('player.get'); },
    read: function () { return __yaqmcCall('player.read'); },
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
  settings: {
    get: function () { return __yaqmcCall('settings.get'); },
    set: function (values) { return __yaqmcCall('settings.set', { values: values || {} }); }
  },
  ui: {
    contextMenu: { track: { register: function (action) { return __yaqmcCall('ui.contextMenu.track.register', action || {}); } } },
    playerBar: { register: function (action) { return __yaqmcCall('ui.playerBar.register', action || {}); } },
    sidebar: { register: function (action) { return __yaqmcCall('ui.sidebar.register', action || {}); } },
    notify: function (options) {
      var payload = typeof options === 'string' ? { message: options, level: 'info' } : (options || {});
      return __yaqmcCall('ui.notify', payload);
    }
  },
  network: {
    request: function (request) { return __yaqmcCall('network.request', request || {}); }
  },
  scenes: {
    onMount: function (sceneId, handler) {
      return ctx.events.on('scene.changed', function (payload) {
        if (payload && payload.sceneId === sceneId && payload.phase === 'mount') handler(payload);
      });
    },
    onUnmount: function (sceneId, handler) {
      return ctx.events.on('scene.changed', function (payload) {
        if (payload && payload.sceneId === sceneId && payload.phase === 'unmount') handler(payload);
      });
    },
    setVariable: function (name, value) { return __yaqmcCall('scenes.setVariable', { name: name, value: value, instanceId: __yaqmcSceneInstance }); },
    setState: function (name, value) { return __yaqmcCall('scenes.setState', { name: name, value: value, instanceId: __yaqmcSceneInstance }); },
    setWidgetProperty: function (widgetId, property, value) { return __yaqmcCall('scenes.setWidgetProperty', { widgetId: widgetId, property: property, value: value, instanceId: __yaqmcSceneInstance }); },
    animate: function (widgetId, property, value) { return __yaqmcCall('scenes.animate', { widgetId: widgetId, property: property, value: value, instanceId: __yaqmcSceneInstance }); }
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
    style.textContent = `@scope ([data-yaqmc-plugin-scene="${scene.pluginId}/${scene.sceneId}"]) {\n${scene.css}\n}`;
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
      client.invoke('plugin_runtime_stop', { token }).catch(() => undefined),
    ),
  );
  runtimeTokens = new Map();
  clearPluginUi();
}

function asUiAction(
  pluginId: string,
  pluginName: string,
  payload: unknown,
): { pluginId: string; pluginName: string; id: string; label: string; icon?: string } | null {
  const source = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const label = typeof source.label === 'string' ? source.label.trim() : '';
  if (!id || id.length > 40 || !label || label.length > 40) return null;
  const icon = typeof source.icon === 'string' ? source.icon.slice(0, 40) : undefined;
  return { pluginId, pluginName, id, label, icon };
}

function applyBridgeSideEffect(
  script: ActiveScriptResource,
  method: string,
  payload: unknown,
  value: unknown,
): void {
  const result = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  if (result.ok !== true) return;
  const pluginName = script.pluginName ?? script.pluginId;
  if (method === 'ui.contextMenu.track.register') {
    const action = asUiAction(script.pluginId, pluginName, payload);
    if (action) registerPluginTrackAction(action);
    return;
  }
  if (method === 'ui.playerBar.register') {
    const action = asUiAction(script.pluginId, pluginName, payload);
    if (action) registerPluginPlayerBarAction(action);
    return;
  }
  if (method === 'ui.sidebar.register') {
    const action = asUiAction(script.pluginId, pluginName, payload);
    if (action) registerPluginSidebarAction(action);
    return;
  }
  if (method === 'ui.notify') {
    const level =
      result.level === 'success' || result.level === 'warning' || result.level === 'error'
        ? result.level
        : 'info';
    const message = typeof result.message === 'string' ? result.message : '';
    if (message) {
      pushPluginNotice({
        pluginId: script.pluginId,
        pluginName,
        level,
        message,
      });
    }
    return;
  }
  if (method === 'settings.set') {
    emitToPlugin(script.pluginId, 'settings.changed', value);
    return;
  }
  if (!applySceneMutation(script.pluginId, payload)) return;
  const source = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (method === 'scenes.setVariable' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) {
    const raw = source.value;
    const text =
      typeof raw === 'string'
        ? raw.slice(0, 64)
        : typeof raw === 'number' && Number.isFinite(raw)
          ? String(raw)
          : typeof raw === 'boolean'
            ? String(raw)
            : '';
    if (text) sceneVariables.set(name, text);
    emitSceneState();
    return;
  }
  if (method === 'scenes.setState' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) {
    const valueText = typeof source.value === 'string' ? source.value.slice(0, 32) : '';
    if (valueText) sceneStates.set(name, valueText);
    emitSceneState();
    return;
  }
  if (method === 'scenes.setWidgetProperty' || method === 'scenes.animate') {
    const widgetId = typeof source.widgetId === 'string' ? source.widgetId : '';
    const property = typeof source.property === 'string' ? source.property : '';
    if (!widgetId || !/^(opacity|scale|rotation|blur)$/.test(property)) return;
    if (property === 'blur' && isLinuxWebView()) return;
    const raw = source.value;
    const text =
      typeof raw === 'number' && Number.isFinite(raw)
        ? String(Math.min(360, Math.max(0, raw)))
        : typeof raw === 'string'
          ? raw.slice(0, 16)
          : '';
    if (!text) return;
    widgetOverrides.set(widgetId, { ...(widgetOverrides.get(widgetId) ?? {}), [property]: text });
    emitSceneState();
  }
}

async function startScripts(scripts: ActiveScriptResource[]): Promise<void> {
  stopScripts();
  for (const script of scripts) {
    try {
      const token = await client.invoke('plugin_runtime_start', { pluginId: script.pluginId });
      runtimeTokens.set(script.pluginId, token);
      const blob = new Blob([pluginWorkerBootstrap(script.source, script.pluginId)], {
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
          void client.invoke('plugin_mark_failed', {
            id: script.pluginId,
            reason: data.message ?? 'plugin runtime error',
          }).catch(() => undefined);
          worker.terminate();
          workers.delete(script.pluginId);
          clearPluginUi(script.pluginId);
          return;
        }
        if (data.type !== 'yaqmc/call' || !data.id || !data.method) return;
        const boundToken = runtimeTokens.get(script.pluginId);
        void client.invoke('plugin_bridge', {
          request: { token: boundToken as string, method: data.method, payload: data.payload ?? {} },
        })
          .then((value) => {
            applyBridgeSideEffect(script, data.method ?? '', data.payload, value);
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
        void client.invoke('plugin_mark_failed', {
          id: script.pluginId,
          reason: event.message || 'plugin runtime error',
        }).catch(() => undefined);
        clearPluginUi(script.pluginId);
      };
      workers.set(script.pluginId, worker);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'plugin runtime failed to start';
      logger.error('plugin.runtime.error', reason, { pluginId: script.pluginId });
      void client.invoke('plugin_mark_failed', { id: script.pluginId, reason }).catch(() => undefined);
      clearPluginUi(script.pluginId);
    }
  }
}

function emitToPlugins(event: string, payload: unknown): void {
  for (const worker of workers.values()) {
    worker.postMessage({ type: 'yaqmc/event', event, payload });
  }
}

function emitToPlugin(pluginId: string, event: string, payload: unknown): void {
  workers.get(pluginId)?.postMessage({ type: 'yaqmc/event', event, payload });
}

export function dispatchPluginUiAction(pluginId: string, actionId: string, slot: string): void {
  emitToPlugin(pluginId, 'ui.action', { id: actionId, slot });
}

function emitSceneLifecycle(selectedId: string): void {
  const pluginMatch = /^plugin:([^:]+):(.+)$/.exec(selectedId);
  const nextPluginId = pluginMatch?.[1] ?? '';
  const nextSceneId = pluginMatch?.[2] ?? selectedId;
  if (sceneInstance.pluginId && sceneInstance.pluginId !== nextPluginId) {
    emitToPlugins('scene.changed', {
      phase: 'unmount',
      pluginId: sceneInstance.pluginId,
      sceneId: sceneInstance.sceneId,
      instanceId: sceneInstance.id,
    });
    resetSceneBehavior();
  }
  if (nextPluginId) {
    const instanceId = setPluginSceneInstance(nextPluginId, nextSceneId);
    emitToPlugin(nextPluginId, 'scene.changed', {
      phase: 'mount',
      pluginId: nextPluginId,
      sceneId: nextSceneId,
      instanceId,
    });
  } else {
    sceneInstance.pluginId = '';
    sceneInstance.sceneId = nextSceneId;
  }
}

export async function setPluginDeveloperMode(enabled: boolean): Promise<boolean> {
  const next = await client.invoke('plugin_set_developer_mode', { enabled });
  await applyPluginResources();
  return next;
}

export async function pluginHostDeveloperMode(): Promise<boolean> {
  if (!isNativeRuntime) return false;
  const resources = await client.invoke('plugin_active_resources');
  return resources.developerMode;
}

export async function choosePluginDirectory(): Promise<string | null> {
  return client.invoke('plugin_pick_directory');
}

export async function installUnpackedPlugin(
  path: string,
  options: { enable?: boolean; grant?: string[] } = {},
): Promise<PluginRecord> {
  const record = await client.invoke('plugin_install_unpacked', {
    request: { path, enable: options.enable ?? false, grant: options.grant ?? [] },
  });
  await applyPluginResources();
  return record;
}

export async function reloadPlugin(id: string): Promise<PluginRecord> {
  const record = await client.invoke('plugin_reload', { id });
  await applyPluginResources();
  return record;
}

export async function pluginSettingsGet(id: string): Promise<Record<string, unknown>> {
  return client.invoke('plugin_settings_get', { id });
}

export async function pluginSettingsSet(
  id: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = await client.invoke('plugin_settings_set', {
    request: { id, values },
  });
  emitToPlugin(id, 'settings.changed', next);
  return next;
}

export async function readPluginAsset(
  pluginId: string,
  path: string,
): Promise<{ mime: string; dataBase64: string } | null> {
  try {
    return await client.invoke('plugin_read_asset', {
      pluginId,
      path,
    });
  } catch {
    return null;
  }
}

export async function applyPluginResources(): Promise<ActivePluginResources | null> {
  if (!isNativeRuntime || applying) return null;
  applying = true;
  try {
    const resources = await client.invoke('plugin_active_resources');
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
    if (resources.safeMode) resetSceneBehavior();
    const selected = usePreferencesStore.getState().lyricsPresets.selectedId;
    emitSceneLifecycle(selected);
    return resources;
  } finally {
    applying = false;
  }
}

export async function listPlugins(): Promise<PluginRecord[]> {
  if (!isNativeRuntime) return [];
  return client.invoke('plugin_list');
}

export async function inspectPluginPath(path: string): Promise<PluginInspectResult> {
  return client.invoke('plugin_inspect_path', { path });
}

export async function installPlugin(
  path: string,
  options: { enable?: boolean; grant?: string[] } = {},
): Promise<PluginRecord> {
  const request = { path, enable: options.enable ?? false, grant: options.grant ?? [] };
  const record =
    client.bridge?.kind === 'electron'
      ? await client.invoke('plugin_install_from', { request })
      : await client.invoke('plugin_install', { request });
  await applyPluginResources();
  return record;
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
  grant: string[] = [],
): Promise<PluginRecord> {
  const record = await client.invoke('plugin_set_enabled', {
    request: { id, enabled, grant },
  });
  await applyPluginResources();
  return record;
}

export async function uninstallPlugin(id: string, removeData: boolean): Promise<void> {
  await client.invoke('plugin_uninstall', { request: { id, removeData } });
  await applyPluginResources();
}

export async function setPluginSafeMode(enabled: boolean): Promise<boolean> {
  const next = await client.invoke('plugin_set_safe_mode', { enabled });
  await applyPluginResources();
  return next;
}

export async function pluginHostSafeMode(): Promise<boolean> {
  if (!isNativeRuntime) return false;
  const resources = await client.invoke('plugin_active_resources');
  return resources.safeMode;
}

export async function choosePluginFile(): Promise<string | null> {
  return client.invoke('plugin_pick_package');
}

export function pluginDiagnosticsText(record: PluginRecord): string {
  return [
    `id=${record.id}`,
    `version=${record.version}`,
    `apiVersion=${record.apiVersion}`,
    `status=${record.status}`,
    `enabled=${record.enabled}`,
    `sha256=${record.packageSha256}`,
    `permissions=${record.grantedPermissions.join(',')}`,
    `network=${(record.networkOrigins ?? []).join(',')}`,
    `risk=${record.riskRating}`,
    `source=${record.source}`,
    `unsigned=${record.unsigned}`,
    record.lastError ? `error=${record.lastError}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function usePluginHost(): void {
  useEffect(() => {
    if (!isNativeRuntime) return;
    void applyPluginResources();
    const unlisten = client.on('plugin://changed', () => {
      void applyPluginResources();
    });
    const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
      const track = state.queue[state.currentIndex ?? -1];
      const previousTrack = previous.queue[previous.currentIndex ?? -1];
      const trackKey = `${state.sessionId}:${state.currentQueueEntryId}:${track?.id ?? ''}`;
      if (trackKey !== lastTrackKey) {
        lastTrackKey = trackKey;
        emitToPlugins('track.changed', {
          id: track?.id ?? null,
          title: track?.title ?? null,
          artists: track?.artists.map((artist) => artist.name) ?? [],
          album: track?.album.title ?? null,
          sessionId: state.sessionId,
        });
        lastLineKey = '';
      }
      if (state.isPlaying !== previous.isPlaying || track?.id !== previousTrack?.id) {
        emitToPlugins('playback.stateChanged', {
          isPlaying: state.isPlaying,
          sessionId: state.sessionId,
        });
      }
      const modeKey = `${state.repeat}:${state.playbackOrder}`;
      if (modeKey !== lastModeKey) {
        lastModeKey = modeKey;
        emitToPlugins('playback.modeChanged', {
          repeat: state.repeat,
          playbackOrder: state.playbackOrder,
          primaryPlaybackMode: primaryPlaybackMode(state.playbackOrder, state.repeat),
          sessionId: state.sessionId,
        });
      }
      const queueKey = `${state.sessionId}:${state.queue.map((item) => item.id).join(',')}`;
      if (queueKey !== lastQueueKey) {
        lastQueueKey = queueKey;
        emitToPlugins('queue.changed', {
          length: state.queue.length,
          currentQueueEntryId: state.currentQueueEntryId,
          sessionId: state.sessionId,
        });
      }
      const now = Date.now();
      if (now - lastPositionEmit >= 250) {
        lastPositionEmit = now;
        const positionPayload = {
          positionMs: state.positionMs,
          durationMs: state.playbackDurationMs,
          sessionId: state.sessionId,
        };
        emitToPlugins('playback.position', positionPayload);
        emitToPlugins('playback.positionCommitted', positionPayload);
        const document = useLyricsStore.getState().document;
        const cursor = selectLyricCursor(document, state.positionMs);
        const lineKey = `${track?.id ?? ''}:${cursor.lineIndex}:${cursor.wordIndex}`;
        if (lineKey !== lastLineKey) {
          lastLineKey = lineKey;
          emitToPlugins('lyrics.lineChanged', {
            lineIndex: cursor.lineIndex,
            wordIndex: cursor.wordIndex,
            text: cursor.line?.text ?? null,
            sessionId: state.sessionId,
          });
        }
      }
    });
    const unsubscribeLyrics = useLyricsStore.subscribe((state, previous) => {
      if (state.songId !== previous.songId || state.document !== previous.document) {
        emitToPlugins('lyrics.documentChanged', {
          songId: state.songId,
          status: state.status,
          lineCount: state.document?.lines.length ?? 0,
        });
      }
    });
    const unsubscribePrefs = usePreferencesStore.subscribe((state, previous) => {
      const themeKey = state.appearance.colorMode;
      if (themeKey !== previous.appearance.colorMode) {
        emitToPlugins('theme.changed', { colorMode: themeKey });
      }
      const sceneKey = state.lyricsPresets.selectedId;
      if (sceneKey !== previous.lyricsPresets.selectedId) {
        emitSceneLifecycle(sceneKey);
      }
    });
    return () => {
      unlisten();
      unsubscribePlayer();
      unsubscribeLyrics();
      unsubscribePrefs();
      stopScripts();
    };
  }, []);
}
