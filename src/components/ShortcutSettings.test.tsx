import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '../i18n';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import { ShortcutSettings } from './ShortcutSettings';

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  usePreferencesStore.setState({ ...defaultPreferences, system: { ...defaultPreferences.system } });
});
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ ...defaultPreferences, system: { ...defaultPreferences.system } });
});
describe('shortcut editor', () => {
  it('records, clears and restores a binding, while rejecting occupied shortcuts', () => {
    render(<ShortcutSettings />);
    const edit = screen.getByRole('button', {
      name: 'Change shortcut: Increase volume (In application)',
    });
    fireEvent.click(edit);
    fireEvent.keyDown(edit, { code: 'KeyU', key: 'U', ctrlKey: true, shiftKey: true });
    expect(usePreferencesStore.getState().system.shortcutBindings.volumeUp).toBe('control+shift+U');
    fireEvent.click(edit);
    fireEvent.keyDown(edit, { code: 'Space', key: ' ' });
    expect(screen.getByRole('alert')).toHaveTextContent('already assigned');
    expect(usePreferencesStore.getState().system.shortcutBindings.volumeUp).toBe('control+shift+U');
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear: Increase volume (In application)' }),
    );
    expect(usePreferencesStore.getState().system.shortcutBindings.volumeUp).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(usePreferencesStore.getState().system.shortcutBindings).toEqual(
      defaultPreferences.system.shortcutBindings,
    );
  });
});
