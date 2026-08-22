import { contrastRatio, readableForeground } from '../../application/theme-tokens';

export function coverInk(hexColor: string): { ink: string; contrast: string } {
  const normalized = hexColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { ink: '#ffffff', contrast: '#10140c' };
  }
  const background = `#${normalized}`;
  let ink: string = readableForeground(background);
  // The shared theme deliberately uses a softened near-black. Keep that
  // character unless it falls just below AA on a saturated mid-tone, where
  // true black is needed to preserve readable inverse lyrics.
  if (contrastRatio(background, ink) < 4.5) {
    ink =
      contrastRatio(background, '#000000') >= contrastRatio(background, '#FFFFFF')
        ? '#000000'
        : '#FFFFFF';
  }
  return ink === '#FFFFFF' ? { ink, contrast: '#11130F' } : { ink, contrast: '#FFFFFF' };
}
