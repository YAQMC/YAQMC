import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(desktopRoot, 'resources');

describe('ELEC-07 packaging skeleton', () => {
  it('keeps desktop icons in apps/desktop/resources', () => {
    for (const name of ['icon.png', 'icon.ico', 'icon.icns', '32x32.png', '128x128.png']) {
      expect(existsSync(path.join(resources, name)), name).toBe(true);
    }
  });

  it('declares an electron-builder skeleton without packaging targets', () => {
    const yaml = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    expect(yaml).toContain('appId: org.yaqmc.desktop');
    expect(yaml).toContain('electronVersion: 43.4.0');
    expect(yaml).toContain('icon: resources/icon.ico');
    expect(yaml).not.toMatch(/nsis:|appImage:|deb:|rpm:/);
  });
});
