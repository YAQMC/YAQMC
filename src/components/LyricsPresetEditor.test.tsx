import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import {
  BUILTIN_CLASSIC_ID,
  defaultLyricsPresetState,
  resolveLyricsPreset,
} from '../application/lyrics-preset';
import { useLyricsPresetPreviewStore } from '../application/lyrics-preset-preview';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { LyricsPresetPicker } from './LyricsPresetEditor';

beforeEach(async () => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
  };
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  usePreferencesStore.setState({ ...defaultPreferences, lyricsPresets: defaultLyricsPresetState });
  usePlayerStore.setState(initialPlayerState);
  useLyricsPresetPreviewStore.getState().reset();
  await i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  useLyricsPresetPreviewStore.getState().reset();
});

describe('LyricsPresetPicker', () => {
  it('shows the three built-in presets and previews typography before persisting', () => {
    render(<LyricsPresetPicker />);
    expect(screen.getByRole('radio', { name: 'Classic' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Immersive' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('radio', { name: 'Vinyl' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    expect(screen.getByRole('heading', { name: 'Customize Classic' })).toBeInTheDocument();
    expect(screen.getByText('多远都要在一起 — G.E.M. 邓紫棋')).toBeInTheDocument();

    const fontSize = screen.getByRole('slider', { name: 'Lyrics font size' });
    fireEvent.input(fontSize, { target: { value: '1.25' } });
    expect(usePreferencesStore.getState().lyricsPresets.overrides).toEqual({});
    const preview = document.querySelector('.lyrics-preset-preview') as HTMLElement | null;
    expect(preview?.style.getPropertyValue('--lyrics-font-scale')).toBe('1.25');

    const lineSpacing = screen.getByRole('slider', { name: 'Lyrics line spacing' });
    fireEvent.input(lineSpacing, { target: { value: '1.4' } });
    expect(preview?.style.getPropertyValue('--lyrics-line-height')).toBe('1.4');
    expect(screen.getByText('Even if the world is vast')).toBeInTheDocument();
    expect(screen.getByText('jiu suan shi jie zai da')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to this preset' }));
    expect(
      resolveLyricsPreset(usePreferencesStore.getState().lyricsPresets, BUILTIN_CLASSIC_ID)
        .typography,
    ).toEqual({ fontScale: 1.25, lineHeight: 1.4 });
  });

  it('plays an isolated preview timeline and can save as a new preset', () => {
    render(<LyricsPresetPicker />);
    fireEvent.click(screen.getByRole('radio', { name: 'Vinyl' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play preview' }));
    expect(useLyricsPresetPreviewStore.getState().isPlaying).toBe(true);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().queue).toEqual(initialPlayerState.queue);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as new preset' }));
    const state = usePreferencesStore.getState().lyricsPresets;
    expect(state.custom).toHaveLength(1);
    expect(state.selectedId.startsWith('custom.')).toBe(true);
    expect(state.custom[0]?.id).not.toBe('builtin.vinyl');
  });

  it('resets a built-in override without deleting custom presets', () => {
    render(<LyricsPresetPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.input(screen.getByRole('slider', { name: 'Lyrics font size' }), {
      target: { value: '1.3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to this preset' }));
    expect(usePreferencesStore.getState().lyricsPresets.overrides[BUILTIN_CLASSIC_ID]).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to built-in default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to built-in default' }));
    expect(
      usePreferencesStore.getState().lyricsPresets.overrides[BUILTIN_CLASSIC_ID],
    ).toBeUndefined();
    expect(
      resolveLyricsPreset(usePreferencesStore.getState().lyricsPresets).typography.fontScale,
    ).toBe(1);
  });
});
