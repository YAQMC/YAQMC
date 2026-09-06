import { describe, expect, it } from 'vitest';
import { androidApp } from './android-app';

describe('desktop Android lifecycle boundary', () => {
  it('rejects accidental mobile lifecycle calls instead of silently changing navigation', async () => {
    await expect(androidApp.addListener('backButton', () => undefined)).rejects.toThrow(
      'desktop build',
    );
    await expect(androidApp.exitApp()).rejects.toThrow('desktop build');
  });
});
