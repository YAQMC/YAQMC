import { usePreferencesStore, useResolvedColorMode } from './preferences';
import type { ResolvedColorMode } from './theme-tokens';

export type ThemePreference = ResolvedColorMode;

export function useTheme() {
  const preference = usePreferencesStore((state) => state.appearance.colorMode);
  const updateAppearance = usePreferencesStore((state) => state.updateAppearance);
  const theme = useResolvedColorMode(preference);

  return {
    theme,
    toggleTheme: () => updateAppearance({ colorMode: theme === 'dark' ? 'light' : 'dark' }),
  };
}
