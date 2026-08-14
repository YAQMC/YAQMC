import { describe, expect, it } from 'vitest';
import packageMetadata from '../../package.json';

describe('@tauri-apps/plugin-opener dependency', () => {
  it('uses a caret range pinned at 2.5.4', () => {
    expect(packageMetadata.dependencies['@tauri-apps/plugin-opener']).toBe('^2.5.4');
  });
});
