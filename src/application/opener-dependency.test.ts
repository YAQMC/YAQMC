import { describe, expect, it } from 'vitest';
import packageMetadata from '../../package.json';

const openerPackage = ['@', 'tauri-apps/plugin-opener'].join('');

describe('plugin-opener dependency', () => {
  it('uses a caret range pinned at 2.5.4', () => {
    const dependencies: Record<string, string | undefined> = packageMetadata.dependencies;
    expect(dependencies[openerPackage]).toBe('^2.5.4');
  });
});
