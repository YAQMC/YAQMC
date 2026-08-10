import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { defaultLocale, resources, type SupportedLocale } from './locales';

export type LocalePreference = 'system' | SupportedLocale;
export const LOCALE_CACHE_KEY = 'yaqmc.locale';
const LEGACY_LOCALE_CACHE_KEY = 'music-client.locale';

export function matchSupportedLocale(locales: readonly string[]): SupportedLocale {
  for (const candidate of locales) {
    const normalized = candidate.replace('_', '-').toLowerCase();
    if (normalized === 'zh' || normalized.startsWith('zh-cn') || normalized.startsWith('zh-sg')) {
      return 'zh-CN';
    }
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  }
  return defaultLocale;
}

export function resolveLocale(
  preference: LocalePreference,
  systemLocales: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): SupportedLocale {
  return preference === 'system' ? matchSupportedLocale(systemLocales) : preference;
}

function cachedLocalePreference(): LocalePreference {
  if (typeof window === 'undefined') return 'system';
  const saved =
    window.localStorage.getItem(LOCALE_CACHE_KEY) ??
    window.localStorage.getItem(LEGACY_LOCALE_CACHE_KEY);
  return saved === 'en-US' || saved === 'zh-CN' ? saved : 'system';
}

const initialLocale = resolveLocale(cachedLocalePreference());

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: defaultLocale,
  supportedLngs: [...Object.keys(resources)],
  defaultNS: 'common',
  fallbackNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

if (typeof document !== 'undefined') document.documentElement.lang = initialLocale;

export default i18n;
