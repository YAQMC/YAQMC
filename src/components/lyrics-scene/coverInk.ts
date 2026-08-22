import { contrastRatio, mixHex, readableForeground } from '../../application/theme-tokens';

export function coverInk(
  hexColor: string,
  options: { dimmed?: boolean } = {},
): { ink: string; contrast: string } {
  const normalized = hexColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { ink: '#ffffff', contrast: '#10140c' };
  }
  const background = `#${normalized}`;
  // Text is painted over the scene treatment, not the unfiltered cover pixel.
  // A light cover becomes dark after the artwork filter and wash, so evaluate
  // contrast against an equivalent displayed tone.
  const displayedBackground = options.dimmed ? mixHex(background, '#000000', 0.7) : background;
  let ink: string = readableForeground(displayedBackground);
  // The shared theme deliberately uses a softened near-black. Keep that
  // character unless it falls just below AA on a saturated mid-tone, where
  // true black is needed to preserve readable inverse lyrics.
  if (contrastRatio(displayedBackground, ink) < 4.5) {
    ink =
      contrastRatio(displayedBackground, '#000000') >= contrastRatio(displayedBackground, '#FFFFFF')
        ? '#000000'
        : '#FFFFFF';
  }
  return ink === '#FFFFFF' ? { ink, contrast: '#11130F' } : { ink, contrast: '#FFFFFF' };
}
