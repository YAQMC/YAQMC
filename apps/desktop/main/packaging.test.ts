import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(desktopRoot, 'resources');

describe('PACK-01 electron-builder', () => {
  it('keeps desktop icons in apps/desktop/resources', () => {
    for (const name of ['icon.png', 'icon.ico', 'icon.icns', '32x32.png', '128x128.png']) {
      expect(existsSync(path.join(resources, name)), name).toBe(true);
    }
  });

  it('pins electron-builder exactly and electron-updater 6.8.6', () => {
    const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(pkg.devDependencies?.electron).toBe('43.4.0');
    expect(pkg.devDependencies?.['electron-builder']).toBe('26.15.7');
    expect(pkg.dependencies?.['electron-updater']).toBe('6.8.6');
    expect(pkg.scripts?.['pack:dir']).toContain('--dir');
    expect(pkg.scripts?.['pack:dir']).toContain('--publish never');
    expect(pkg.scripts?.['pack:win']).toBe(
      'electron-builder --projectDir . --config electron-builder.yml --win --x64 --publish never',
    );
  });

  it('finalizes appId parity, targets, NSIS, extraResources, and sandbox fuses', () => {
    const yaml = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    expect(yaml).toContain('appId: org.yaqmc.desktop');
    expect(yaml).toContain('productName: YAQMC');
    expect(yaml).toContain('asar: true');
    expect(yaml).toContain('electronVersion: 43.4.0');
    expect(yaml).toContain('from: resources/core');
    expect(yaml).toContain('to: core');
    expect(yaml).toContain('oneClick: false');
    expect(yaml).toContain('perMachine: false');
    expect(yaml).toMatch(/target:\s*nsis|target: nsis/);
    expect(yaml).toMatch(/target:\s*portable|target: portable/);
    expect(yaml).toContain('AppImage');
    expect(yaml).toContain('deb');
    expect(yaml).toContain('rpm');
    expect(yaml).toContain('tar.gz');
    expect(yaml).toContain('runAsNode: false');
    expect(yaml).toContain('enableNodeOptionsEnvironmentVariable: false');
    expect(yaml).toContain('enableNodeCliInspectArguments: false');
    expect(yaml).toContain('onlyLoadAppFromAsar: true');
    expect(yaml).toContain('grantFileProtocolExtraPrivileges: false');
    expect(yaml).toContain('provider: github');
    expect(yaml).toContain('owner: YAQMC');
    expect(yaml).not.toContain(['--', 'no-sandbox'].join(''));
    expect(yaml).not.toContain(['--', 'disable-web-security'].join(''));
  });
});
