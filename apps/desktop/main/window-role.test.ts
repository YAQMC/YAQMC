import { describe, expect, it } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import {
  lyricsWindowRoleFromSearch,
  searchFromLocation,
  unlockWindowRoleFromSearch,
} from '../preload/window-role';

describe('lyrics and unlock windowRole parsing', () => {
  it('maps ?surface=desktop|island for the lyrics-surface preload', () => {
    expect(lyricsWindowRoleFromSearch('?surface=desktop')).toBe('lyrics-desktop');
    expect(lyricsWindowRoleFromSearch('?surface=island')).toBe('lyrics-island');
    expect(lyricsWindowRoleFromSearch('')).toBe('lyrics-desktop');
    expect(lyricsWindowRoleFromSearch('?surface=other')).toBe('lyrics-desktop');
    expect(lyricsWindowRoleFromSearch('?unlockSurface=island&surface=desktop')).toBe(
      'lyrics-desktop',
    );
  });

  it('maps ?unlockSurface=desktop|island for the unlock-overlay preload', () => {
    expect(unlockWindowRoleFromSearch('?unlockSurface=desktop')).toBe('unlock-desktop');
    expect(unlockWindowRoleFromSearch('?unlockSurface=island')).toBe('unlock-island');
    expect(unlockWindowRoleFromSearch('')).toBe('unlock-desktop');
    expect(unlockWindowRoleFromSearch('?unlockSurface=other')).toBe('unlock-desktop');
    expect(unlockWindowRoleFromSearch('?surface=island&unlockSurface=desktop')).toBe(
      'unlock-desktop',
    );
  });

  it('reads location.search without a DOM lib', () => {
    expect(searchFromLocation(undefined)).toBe('');
    expect(searchFromLocation({})).toBe('');
    expect(searchFromLocation({ search: '?surface=island' })).toBe('?surface=island');
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
