import type { SecondaryLyricVisibility } from './preferences';

export function shouldShowLyricSecondary(
  mode: SecondaryLyricVisibility,
  value: string | undefined,
  primary: string,
  kind: 'translation' | 'romanization',
): boolean {
  if (!value || mode === 'hide') return false;
  if (mode === 'show') return true;
  if (value.trim().toLocaleLowerCase() === primary.trim().toLocaleLowerCase()) return false;
  const hasNonLatinText = Array.from(primary).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x024f;
  });
  return kind === 'translation' || hasNonLatinText;
}
