import { describe, expect, it } from 'vitest';
import {
  normalizeAccelerator,
  normalizeShortcutBindings,
  DEFAULT_SHORTCUTS,
  keyboardAccelerator,
  matchesAccelerator,
} from './shortcuts';

describe('portable shortcut grammar', () => {
  it('normalizes modifiers and rejects ambiguous/reserved combinations', () => {
    expect(normalizeAccelerator('Shift+Control+L')).toBe('control+shift+L');
    for (const value of [
      'Escape',
      'Control+control+L',
      'mod+meta+L',
      'control++',
      'Ctrl+K',
      'control+KeyK',
      'F25',
      'a',
    ])
      expect(normalizeAccelerator(value)).toBeNull();
    expect(normalizeShortcutBindings({ toggle: null, next: 'invalid' })).toEqual({
      ...DEFAULT_SHORTCUTS,
      toggle: null,
    });
  });
  it('requires exact modifiers and supports physical keys and key-only events', () => {
    const event = { code: 'KeyL', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(keyboardAccelerator(event)).toBe('control+shift+L');
    expect(matchesAccelerator(event, 'control+shift+L')).toBe(true);
    expect(matchesAccelerator({ ...event, altKey: true }, 'control+shift+L')).toBe(false);
    expect(
      keyboardAccelerator({ ...event, code: '', key: 'F11', ctrlKey: false, shiftKey: false }),
    ).toBe('F11');
  });
});
