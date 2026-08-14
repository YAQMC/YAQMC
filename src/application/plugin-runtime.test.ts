import { describe, expect, it, vi } from 'vitest';
import { pluginDiagnosticsText, pluginWorkerBootstrap } from './plugin-runtime';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));

describe('plugin runtime isolation', () => {
  it('bootstraps workers without Tauri, DOM, or network APIs', () => {
    const source = pluginWorkerBootstrap(
      'definePlugin({ activate() { return function () {}; } });',
    );
    expect(source).toContain('network denied');
    expect(source).toContain('self.__TAURI__ = undefined');
    expect(source).toContain('self.document = undefined');
    expect(source).toContain('importScripts denied');
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
});
