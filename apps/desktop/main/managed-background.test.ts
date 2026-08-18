import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectImageMime,
  hydrateManagedBackground,
  isManagedBackgroundReference,
  managedBackgroundPath,
  MAX_MANAGED_BACKGROUND_BYTES,
} from './managed-background';

const PNG = Buffer.from('\x89PNG\r\n\x1a\nrest', 'binary');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('managed background hydrate', () => {
  it('accepts only Core-managed background references', () => {
    expect(isManagedBackgroundReference('backgrounds/custom-background.png')).toBe(true);
    expect(isManagedBackgroundReference('backgrounds/custom-background.jpg')).toBe(true);
    expect(isManagedBackgroundReference('backgrounds/../custom-background.png')).toBe(false);
    expect(isManagedBackgroundReference('backgrounds\\custom-background.png')).toBe(false);
    expect(isManagedBackgroundReference('C:\\Users\\x\\Pictures\\wall.png')).toBe(false);
    expect(managedBackgroundPath('/data', 'backgrounds/../custom-background.png')).toBeUndefined();
  });

  it('detects PNG and JPEG magic', () => {
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(Buffer.from('not-an-image'))).toBeUndefined();
  });

  it('hydrates an empty Core dataUri from the managed file', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-bg-hydrate-'));
    mkdirSync(path.join(root, 'backgrounds'));
    writeFileSync(path.join(root, 'backgrounds', 'custom-background.png'), PNG);
    await expect(
      hydrateManagedBackground(
        { reference: 'backgrounds/custom-background.png', dataUri: '' },
        root,
      ),
    ).resolves.toEqual({
      reference: 'backgrounds/custom-background.png',
      dataUri: `data:image/png;base64,${PNG.toString('base64')}`,
    });
  });

  it('rejects a traversal reference and keeps the 24 MiB bound', async () => {
    expect(MAX_MANAGED_BACKGROUND_BYTES).toBe(24 * 1024 * 1024);
    await expect(
      hydrateManagedBackground({ reference: 'backgrounds/../secrets.png', dataUri: '' }, os.tmpdir()),
    ).rejects.toThrow('background reference is outside the managed directory');
  });
});
