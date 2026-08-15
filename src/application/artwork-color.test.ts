import { describe, expect, it } from 'vitest';
import {
  colorFieldEmitterColor,
  rememberArtworkPalette,
  cachedArtworkPalette,
} from './artwork-color';

describe('artwork color cache', () => {
  it('returns cached palette by identity and prefers bound artwork colors', () => {
    rememberArtworkPalette({
      identity: 'song-a',
      primary: '#112233',
      secondary: '#445566',
      revision: 1,
    });
    expect(cachedArtworkPalette('song-a')?.primary).toBe('#112233');
    expect(
      colorFieldEmitterColor(
        { color: '#FFFFFF', bind: 'artworkPrimary' },
        cachedArtworkPalette('song-a'),
      ),
    ).toBe('#112233');
    expect(
      colorFieldEmitterColor(
        { color: '#FFFFFF', bind: 'artworkSecondary' },
        cachedArtworkPalette('song-a'),
      ),
    ).toBe('#445566');
    expect(colorFieldEmitterColor({ color: '#ABCDEF' }, null)).toBe('#ABCDEF');
  });
});
