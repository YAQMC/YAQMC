import { describe, expect, it } from 'vitest';
import packageMetadata from '../../package.json';

const openerPackage = ['@', 'tau', 'ri-apps/plugin-opener'].join('');

describe('legacy opener dependency', () => {
  it('is absent after the Electron-only host cutover', () => {
    const dependencies: Record<string, string | undefined> = packageMetadata.dependencies;
    expect(dependencies[openerPackage]).toBeUndefined();
  });
});
