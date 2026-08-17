import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');

/** Handshake identity used by protocol e2e and supervisor unit tests. */
const HANDSHAKE_VERSION = '0.1.0';

type PackageJson = {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readJson(relativePath: string): PackageJson {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as PackageJson;
}

function cargoPackageVersion(relativePath: string): string {
  const text = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const match = text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match?.[1]) {
    throw new Error(`no package version in ${relativePath}`);
  }
  return match[1];
}

describe('PACK-04 handshake version equality', () => {
  it('keeps root, desktop, core, and the handshake constant equal', () => {
    const root = readJson('package.json').version;
    const desktop = readJson('apps/desktop/package.json').version;
    const core = cargoPackageVersion('crates/yaqmc-core/Cargo.toml');
    expect(root).toBe(HANDSHAKE_VERSION);
    expect(desktop).toBe(HANDSHAKE_VERSION);
    expect(core).toBe(HANDSHAKE_VERSION);
  });

  it('handshake uses app.getVersion() as both host and expected core version', () => {
    const index = readFileSync(path.join(desktopRoot, 'main/index.ts'), 'utf8');
    expect(index).toContain('hostVersion: app.getVersion()');
    expect(index).toContain('expectedCoreVersion: app.getVersion()');
  });

  it('desktop esbuild defines Vite-equivalent build metadata', () => {
    const build = readFileSync(path.join(desktopRoot, 'scripts/build.mjs'), 'utf8');
    expect(build).toContain('__YAQMC_BUILD_COMMIT__');
    expect(build).toContain('__YAQMC_RELEASE_CHANNEL__');
    expect(build).toContain('__YAQMC_BUILD_TYPE__');
  });

  it('leaves Electron 43.4.0, the 32 MiB cap, and no electron-updater', () => {
    const pkg = readJson('apps/desktop/package.json');
    expect(pkg.devDependencies?.electron).toBe('43.4.0');
    expect(pkg.dependencies?.['electron-updater']).toBeUndefined();
    expect(pkg.devDependencies?.['electron-updater']).toBeUndefined();
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
