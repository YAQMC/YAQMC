export type ColorModePreference = 'system' | 'light' | 'dark';
export type ResolvedColorMode = Exclude<ColorModePreference, 'system'>;
export type PaletteId =
  'default' | 'ember' | 'ocean' | 'violet' | 'sakura' | 'mint' | 'mono' | 'custom';

export interface PalettePreset {
  id: PaletteId;
  primary: string;
  secondary: string;
}

export const palettePresets: readonly PalettePreset[] = [
  { id: 'default', primary: '#A8C95E', secondary: '#7FA3A0' },
  { id: 'ember', primary: '#E85D68', secondary: '#F0A36C' },
  { id: 'ocean', primary: '#4C9FE8', secondary: '#64C8C0' },
  { id: 'violet', primary: '#9A78E8', secondary: '#D174C8' },
  { id: 'sakura', primary: '#DF789B', secondary: '#F0AA91' },
  { id: 'mint', primary: '#56B98A', secondary: '#6FBAC8' },
  { id: 'mono', primary: '#AEB2AB', secondary: '#747A73' },
] as const;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function normalizeHexColor(value: string, fallback = '#A8C95E'): string {
  const trimmed = value.trim();
  const short = /^#?([0-9a-f]{3})$/i.exec(trimmed)?.[1];
  if (short) {
    return `#${short
      .split('')
      .map((part) => `${part}${part}`)
      .join('')}`.toUpperCase();
  }
  const full = /^#?([0-9a-f]{6})$/i.exec(trimmed)?.[1];
  return full ? `#${full.toUpperCase()}` : fallback.toUpperCase();
}

export function isValidHexColor(value: string): boolean {
  return /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function toRgb(hex: string): Rgb {
  const normalized = normalizeHexColor(hex).slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

export function mixHex(first: string, second: string, amount: number): string {
  const a = toRgb(first);
  const b = toRgb(second);
  const ratio = Math.max(0, Math.min(1, amount));
  return toHex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  });
}

function luminance(hex: string): number {
  const rgb = toRgb(hex);
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return channel(rgb.r) * 0.2126 + channel(rgb.g) * 0.7152 + channel(rgb.b) * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

export function readableForeground(background: string): '#11130F' | '#FFFFFF' {
  return contrastRatio(background, '#11130F') >= contrastRatio(background, '#FFFFFF')
    ? '#11130F'
    : '#FFFFFF';
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = toRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export interface ThemeTokenInput {
  mode: ResolvedColorMode;
  primary: string;
  secondary: string;
  surfaceOpacity: number;
  material: 'opaque' | 'translucent';
}

export function generateThemeTokens(input: ThemeTokenInput): Record<string, string> {
  const dark = input.mode === 'dark';
  const primary = normalizeHexColor(input.primary);
  const secondary = normalizeHexColor(input.secondary, '#7FA3A0');
  const opacity = Math.max(0.85, Math.min(1, input.surfaceOpacity / 100));
  const materialAdjustment = input.material === 'translucent' ? 0.07 : 0;
  const alpha = Math.max(0.78, opacity - materialAdjustment);
  const base = dark ? '#11120F' : '#F5F5F1';
  const sidebar = dark ? '#0D0E0C' : '#EBEBE6';
  const surface = dark ? '#181A16' : '#FFFFFF';
  const raised = dark ? '#1D1F1A' : '#FAFAF7';
  const player = dark ? '#141511' : '#F9F9F5';
  const hoverTarget = dark ? '#FFFFFF' : '#000000';

  return {
    '--bg-opaque': base,
    '--bg': rgba(base, alpha),
    '--bg-subtle': rgba(dark ? '#141511' : '#F0F0EB', Math.min(1, alpha + 0.025)),
    '--sidebar': rgba(sidebar, Math.min(1, alpha + 0.035)),
    '--surface': rgba(surface, alpha),
    '--surface-raised': rgba(raised, Math.min(1, alpha + 0.035)),
    '--surface-hover': rgba(dark ? '#242620' : '#E8E9E2', Math.min(1, alpha + 0.06)),
    '--surface-pressed': rgba(dark ? '#292C24' : '#DEDFD7', Math.min(1, alpha + 0.08)),
    '--player': rgba(player, Math.min(1, alpha + 0.045)),
    '--accent': primary,
    '--accent-primary': primary,
    '--accent-primary-hover': mixHex(primary, hoverTarget, dark ? 0.12 : 0.1),
    '--accent-primary-active': mixHex(primary, dark ? '#000000' : '#000000', dark ? 0.13 : 0.18),
    '--accent-hover': mixHex(primary, hoverTarget, dark ? 0.12 : 0.1),
    '--accent-ink': readableForeground(primary),
    '--accent-secondary': secondary,
    '--accent-secondary-muted': rgba(secondary, dark ? 0.2 : 0.16),
    '--focus': contrastRatio(primary, base) >= 3 ? primary : dark ? '#D5EE8D' : '#526F24',
    '--selection': rgba(primary, 0.24),
    '--surface-base-alpha': alpha.toFixed(3),
    '--surface-raised-alpha': Math.min(1, alpha + 0.035).toFixed(3),
  };
}
