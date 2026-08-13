import { describe, expect, it } from 'vitest';
import type { PlatformDiagnostics } from './platform-integration';
import { formatSafeDiagnostics, productMetadata } from './product-metadata';

const diagnostics: PlatformDiagnostics = {
  generatedAtUnixMs: 1,
  appName: 'YAQMC',
  appVersion: '0.1.0',
  os: 'windows',
  architecture: 'x86_64',
  linux: null,
  capabilities: {
    reliableAlwaysOnTop: true,
    clickThrough: true,
    transparentWindow: true,
    globalPositioning: true,
    absoluteWindowPlacement: true,
    fullscreenDetection: true,
    globalShortcuts: true,
    notes: [],
  },
  audio: {
    implementation: 'Rodio / CPAL (WASAPI)',
    route: 'WASAPI',
    available: true,
    selectedOutput: 'Speakers',
    selectedOutputKind: 'system-default',
    resolvedOutput: 'Speakers',
    resolvedDriver: 'WASAPI',
    resolvedHost: 'WASAPI',
    resolvedSampleRate: 48_000,
    resolvedChannels: 2,
    resolvedSampleFormat: 'f32',
  },
  systemMedia: {
    available: true,
    backend: 'SMTC',
    specification: 'Windows SMTC',
    error: null,
  },
  desktopIntegration: {
    trayAvailable: true,
    trayError: null,
    globalShortcutsSupported: true,
    globalShortcutsEnabled: true,
    globalShortcuts: [],
    shortcutError: null,
  },
};

describe('product metadata', () => {
  it('keeps every public project link under the configured repository', () => {
    expect(Object.values(productMetadata.links)).toEqual(
      expect.arrayContaining([
        'https://github.com/YAQMC/YAQMC',
        'https://github.com/YAQMC/YAQMC/releases',
      ]),
    );
    expect(
      Object.values(productMetadata.links).every((url) =>
        url.startsWith(productMetadata.repository),
      ),
    ).toBe(true);
  });

  it('copies only allowlisted runtime facts and never secret-shaped account fields', () => {
    const text = formatSafeDiagnostics({
      platform: diagnostics,
      provider: {
        providerId: 'qqmusic',
        displayName: 'QQ Music',
        connection: 'online',
        message: 'ready',
        preferredQuality: 'automatic',
        capabilities: {
          search: true,
          album: true,
          artist: true,
          playlist: true,
          lyrics: true,
          wordTimedLyrics: true,
          streaming: true,
          qualitySelection: true,
        },
      },
      accountState: 'authenticated',
    });

    expect(text).toContain('OS: windows');
    expect(text).toContain('Audio backend: Rodio / CPAL (WASAPI)');
    expect(text).toContain('QQ provider mode: qqmusic / online / authenticated');
    expect(text).not.toMatch(/cookie|oauth|token|qrsig|ekey|authorization|session-id|attempt-id/iu);
    expect(text).not.toContain('Speakers');
  });
});
