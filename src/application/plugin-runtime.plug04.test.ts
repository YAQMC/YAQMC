// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { readFileSync } from 'node:fs';
// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { dirname, join } from 'node:path';
// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LYRICS_PRESET_SCHEMA_VERSION,
  SCENE_WIDGET_IDS,
  defaultLyricsPresetState,
  listResolvedPresets,
  normalizeScene,
  resolveLyricsPreset,
  setPluginPresetCatalog,
  type LyricsPresetDefinition,
  type LyricsSceneLayout,
} from './lyrics-preset';

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../examples/plugins');
const scenePackRoot = join(examplesRoot, 'scene-pack');

type ScenePackManifest = {
  id: string;
  name: string;
  apiVersion: number;
  entrypoints: { scenes: string[] };
  permissions: string[];
};

type ScenePackDocument = {
  schemaVersion: number;
  id: string;
  name: string;
  layout: 'full' | 'vinyl' | 'split';
  typography: { fontScale: number; lineHeight: number };
  artwork: { style: string };
  background: { fit: string; fallbackColor: string };
  scene: LyricsSceneLayout;
};

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(scenePackRoot, relative), 'utf8')) as T;
}

function assertRuntimeSceneFields(document: ScenePackDocument): void {
  expect(document.schemaVersion).toBe(LYRICS_PRESET_SCHEMA_VERSION);
  expect(document.id.length).toBeGreaterThan(0);
  expect(document.name.length).toBeGreaterThan(0);
  expect(['full', 'vinyl', 'split']).toContain(document.layout);
  expect(document.typography.fontScale).toBeGreaterThan(0);
  expect(document.typography.lineHeight).toBeGreaterThan(0);
  expect(document.artwork.style).toMatch(/^(square|vinyl)$/);
  expect(document.background.fit).toMatch(/^(cover|contain)$/);
  expect(document.background.fallbackColor).toMatch(/^#[0-9A-Fa-f]{6}$/);

  for (const widget of SCENE_WIDGET_IDS) {
    const node = document.scene[widget];
    expect(node, widget).toBeDefined();
    expect(node.id).toBe(widget);
    expect(node.kind).toBe(widget);
    expect(Number.isFinite(node.zIndex)).toBe(true);
    expect(typeof node.visible).toBe('boolean');
    expect(typeof node.locked).toBe('boolean');
  }
  expect(document.scene.background.source).toBeTruthy();
  expect(document.scene.artwork.renderer).toBeTruthy();
  expect(Number.isFinite(document.scene.lyrics.followAnchor)).toBe(true);
  expect(document.scene.transport.align).toBeTruthy();
}

function toPluginPreset(document: ScenePackDocument): LyricsPresetDefinition {
  const normalized = normalizeScene(document.scene, document.layout);
  expect(normalized.malformed).toBe(false);
  return {
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    id: `plugin:dev.yaqmc.example.scenes:${document.id}`,
    nameKey: 'custom',
    name: document.name,
    source: 'plugin',
    pluginId: 'dev.yaqmc.example.scenes',
    pluginName: 'Lyrics scenes',
    layout: document.layout,
    typography: document.typography,
    artwork: { style: document.artwork.style === 'vinyl' ? 'vinyl' : 'square' },
    background: {
      fit: document.background.fit === 'contain' ? 'contain' : 'cover',
      fallbackColor: document.background.fallbackColor,
    },
    scene: normalized.scene,
  };
}

describe('PLUG-04 scene API v2 demo coverage', () => {
  afterEach(() => {
    setPluginPresetCatalog([]);
  });

  it('parses the scene-pack manifest and Scene API v2 JSON fields', () => {
    const manifest = readJson<ScenePackManifest>('manifest.json');
    expect(manifest.id).toBe('dev.yaqmc.example.scenes');
    expect(manifest.name).toBe('Lyrics scenes');
    expect(manifest.entrypoints.scenes).toEqual([
      'scenes/aurora.scene.json',
      'scenes/vinyl-glow.scene.json',
    ]);
    expect(manifest.permissions).toContain('scene.register');
    expect(manifest.id).not.toBe('dev.yaqmc.test.hostile');

    const aurora = readJson<ScenePackDocument>('scenes/aurora.scene.json');
    assertRuntimeSceneFields(aurora);
    expect(aurora.id).toBe('aurora');
    expect(aurora.layout).toBe('full');
    expect(aurora.scene.artwork.renderer).toBe('rounded');
    expect(aurora.scene.extras?.[0]).toMatchObject({
      id: 'now-playing-label',
      kind: 'text',
      bind: 'track.title',
    });

    const vinyl = readJson<ScenePackDocument>('scenes/vinyl-glow.scene.json');
    assertRuntimeSceneFields(vinyl);
    expect(vinyl.id).toBe('vinyl-glow');
    expect(vinyl.layout).toBe('vinyl');
    expect(vinyl.scene.artwork.renderer).toBe('vinyl');
    expect(vinyl.scene.artwork.radius).toBe(0.5);
  });

  it('registers scene-pack presets into the lyrics catalog without a GUI picker E2E', () => {
    const aurora = toPluginPreset(readJson<ScenePackDocument>('scenes/aurora.scene.json'));
    const vinyl = toPluginPreset(readJson<ScenePackDocument>('scenes/vinyl-glow.scene.json'));
    setPluginPresetCatalog([aurora, vinyl]);

    const catalog = listResolvedPresets(defaultLyricsPresetState);
    expect(catalog.map((preset) => preset.id)).toEqual(
      expect.arrayContaining([
        'plugin:dev.yaqmc.example.scenes:aurora',
        'plugin:dev.yaqmc.example.scenes:vinyl-glow',
      ]),
    );

    const selected = {
      ...defaultLyricsPresetState,
      selectedId: 'plugin:dev.yaqmc.example.scenes:aurora',
    };
    const resolved = resolveLyricsPreset(selected);
    expect(resolved.source).toBe('plugin');
    expect(resolved.pluginId).toBe('dev.yaqmc.example.scenes');
    expect(resolved.layout).toBe('full');
    expect(resolved.scene.artwork.renderer).toBe('rounded');
    expect(resolved.scene.lyrics.followAnchor).toBe(0.42);
    expect(resolved.scene.extras?.[0]?.bind).toBe('track.title');
    expect(resolveLyricsPreset(selected, 'plugin:dev.yaqmc.example.scenes:vinyl-glow').layout).toBe(
      'vinyl',
    );
  });
});
