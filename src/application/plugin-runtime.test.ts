import { invoke } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';
import {
  choosePluginFile,
  isPluginSceneMutationCurrent,
  pluginDiagnosticsText,
  pluginWorkerBootstrap,
  setPluginSceneInstance,
} from './plugin-runtime';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));

describe('plugin runtime isolation', () => {
  it('bootstraps workers without Tauri, DOM, or network APIs', () => {
    const source = pluginWorkerBootstrap(
      'definePlugin({ activate() { return function () {}; } });',
      'dev.example',
    );
    expect(source).toContain('network denied');
    expect(source).toContain('self.__TAURI__ = undefined');
    expect(source).toContain('self.document = undefined');
    expect(source).toContain('importScripts denied');
    expect(source).toContain('eval denied');
    expect(source).toContain('self.Worker = undefined');
    expect(source).toContain('network.request');
    expect(source).toContain('ui.contextMenu');
    expect(source).toContain('__yaqmcSceneInstance');
    expect(source).toContain('"dev.example"');
    expect(source).not.toMatch(/window\.__TAURI__/);
    expect(source.includes('invoke(')).toBe(false);
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
    vi.mocked(invoke).mockResolvedValueOnce('C:\\plugin.yaqmc-plugin');
    await expect(choosePluginFile()).resolves.toBe('C:\\plugin.yaqmc-plugin');
    expect(invoke).toHaveBeenCalledWith('plugin_pick_package');
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
