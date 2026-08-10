import { afterEach, describe, expect, it } from 'vitest';
import i18n, { matchSupportedLocale, resolveLocale } from './i18n';
import { resources } from './locales';

function keys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

afterEach(async () => {
  await i18n.changeLanguage('en-US');
});

describe('internationalization', () => {
  it('resolves explicit and system locales with an English fallback', () => {
    expect(matchSupportedLocale(['zh-SG', 'en-US'])).toBe('zh-CN');
    expect(matchSupportedLocale(['fr-FR'])).toBe('en-US');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', ['en-GB'])).toBe('en-US');
  });

  it('keeps major translation resources structurally complete', () => {
    expect(keys(resources['zh-CN'])).toEqual(keys(resources['en-US']));
  });

  it('switches language immediately and falls back for unsupported locales', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('navigation:home')).toBe('首页');
    await i18n.changeLanguage('fr-FR');
    expect(i18n.t('navigation:home')).toBe('Home');
  });
});
