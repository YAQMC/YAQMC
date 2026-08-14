import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(document.querySelector('[data-lyrics-scene]')).not.toBeNull();
    expect(document.querySelector('.lyrics-line')).not.toBeNull();

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

  it('makes 70% and 145% font scales differ on the editor canvas', () => {
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return (this as HTMLElement).classList.contains('lyrics-scene') ? 800 : 0;
      },
    });
    try {
      render(<LyricsPresetPicker />);
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
      const scene = () => document.querySelector<HTMLElement>('.lyrics-scene');
      fireEvent.input(screen.getByRole('slider', { name: 'Lyrics font size' }), {
        target: { value: '0.7' },
      });
      expect(scene()?.style.getPropertyValue('--lyrics-font-scale')).toBe('0.7');
      expect(
        Number.parseFloat(scene()?.style.getPropertyValue('--lyrics-font-size') ?? '0'),
      ).toBeCloseTo(31.36, 2);
      fireEvent.input(screen.getByRole('slider', { name: 'Lyrics font size' }), {
        target: { value: '1.45' },
      });
      const largePx = Number.parseFloat(
        scene()?.style.getPropertyValue('--lyrics-font-size') ?? '0',
      );
      expect(largePx).toBeCloseTo(64.96, 2);
      expect(largePx / 31.36).toBeGreaterThan(2);

      fireEvent.input(screen.getByRole('slider', { name: 'Lyrics line spacing' }), {
        target: { value: '1.05' },
      });
      const tightGap = Number.parseFloat(
        scene()?.style.getPropertyValue('--lyrics-line-gap') ?? '0',
      );
      fireEvent.input(screen.getByRole('slider', { name: 'Lyrics line spacing' }), {
        target: { value: '1.6' },
      });
      expect(scene()?.style.getPropertyValue('--lyrics-line-height')).toBe('1.6');
      const looseGap = Number.parseFloat(
        scene()?.style.getPropertyValue('--lyrics-line-gap') ?? '0',
      );
      expect(looseGap / tightGap).toBeGreaterThan(1.4);
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'clientHeight', previous);
      else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it('commits one undo step for a slider gesture', () => {
    render(<LyricsPresetPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    const fontSize = screen.getByRole('slider', { name: 'Lyrics font size' });
    fireEvent.pointerDown(fontSize);
    fireEvent.input(fontSize, { target: { value: '1.1' } });
    fireEvent.input(fontSize, { target: { value: '1.25' } });
    fireEvent.pointerUp(fontSize);
    const preview = document.querySelector('.lyrics-preset-preview') as HTMLElement | null;
    expect(preview?.style.getPropertyValue('--lyrics-font-scale')).toBe('1.25');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(preview?.style.getPropertyValue('--lyrics-font-scale')).toBe('1');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('commits one undo step for a drag and saves inspector geometry into runtime resolve', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    try {
      render(<LyricsPresetPicker />);
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
      const scene = document.querySelector('.lyrics-scene');
      if (!scene) throw new Error('lyrics scene is missing');
      vi.spyOn(scene, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 1000,
        right: 1000,
        width: 1000,
        height: 1000,
        toJSON: () => ({}),
      });

      const artwork = document.querySelector('[data-widget="artwork"]');
      if (!artwork) throw new Error('artwork widget is missing');
      fireEvent.pointerDown(artwork, { clientX: 200, clientY: 200 });
      fireEvent.pointerMove(window, { clientX: 400, clientY: 200, altKey: true });
      fireEvent.pointerUp(window);

      fireEvent.click(screen.getByRole('button', { name: 'Artwork' }));
      const positionX = screen.getByRole('spinbutton', { name: 'Position X' });
      expect(Number((positionX as HTMLInputElement).value)).toBeCloseTo(32.9, 1);

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(
        Number((screen.getByRole('spinbutton', { name: 'Position X' }) as HTMLInputElement).value),
      ).toBeCloseTo(22.5, 1);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

      fireEvent.change(screen.getByRole('spinbutton', { name: 'Position X' }), {
        target: { value: '41' },
      });
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Width' }), {
        target: { value: '33' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Lyrics' }));
      fireEvent.input(screen.getByRole('slider', { name: 'Follow anchor' }), {
        target: { value: '0.5' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      fireEvent.click(screen.getByRole('button', { name: 'Apply to this preset' }));

      const resolved = resolveLyricsPreset(
        usePreferencesStore.getState().lyricsPresets,
        BUILTIN_CLASSIC_ID,
      );
      expect(resolved.scene.artwork.x).toBeCloseTo(0.41, 3);
      expect(resolved.scene.artwork.width).toBeCloseTo(0.33, 3);
      expect(resolved.scene.lyrics.followAnchor).toBeCloseTo(0.5, 3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a selected widget selected on click and only deselects on blank canvas', () => {
    render(<LyricsPresetPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    const artwork = document.querySelector('[data-widget="artwork"]');
    if (!artwork) throw new Error('artwork widget is missing');
    fireEvent.pointerDown(artwork, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window);
    expect(screen.getByRole('button', { name: 'Artwork' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('spinbutton', { name: 'Position X' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

    fireEvent.pointerDown(artwork, { clientX: 12, clientY: 12 });
    fireEvent.pointerUp(window);
    expect(screen.getByRole('button', { name: 'Artwork' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Artwork' }));
    expect(screen.getByRole('button', { name: 'Artwork' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.pointerDown(document.querySelector('.lyrics-composer-canvas')!, {
      clientX: 1,
      clientY: 1,
    });
    expect(screen.queryByRole('spinbutton', { name: 'Position X' })).not.toBeInTheDocument();
  });

  it('uses widget overlay bounds and keeps vinyl selection visually square', () => {
    render(<LyricsPresetPicker />);
    fireEvent.click(screen.getByRole('radio', { name: 'Vinyl' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Artwork' }));
    const box = document.querySelector('.lyrics-composer-handles__box') as HTMLElement | null;
    expect(box).toHaveAttribute('data-selection-bounds', 'artwork');
    const width = Number.parseFloat(box?.style.width ?? '0');
    const height = Number.parseFloat(box?.style.height ?? '0');
    const visualWidth = (width / 100) * (16 / 9);
    const visualHeight = height / 100;
    expect(visualWidth / visualHeight).toBeCloseTo(1, 2);
    expect(document.querySelector('[data-lyrics-scene]')).not.toBeNull();
    expect(document.querySelector('.lyrics-stage__disc')).not.toBeNull();
  });

  it('drags lyrics from the widget and keeps the selection', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    try {
      render(<LyricsPresetPicker />);
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
      const lyrics = document.querySelector('[data-widget="lyrics"]');
      if (!lyrics) throw new Error('lyrics widget is missing');
      fireEvent.pointerDown(lyrics, { clientX: 40, clientY: 40 });
      fireEvent.pointerMove(window, { clientX: 140, clientY: 40, altKey: true });
      fireEvent.pointerUp(window);
      expect(screen.getByRole('button', { name: 'Lyrics' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const positionX = screen.getByRole('spinbutton', { name: 'Position X' });
      expect(Number((positionX as HTMLInputElement).value)).not.toBeCloseTo(73, 0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('selects a compact transport frame instead of a full-width bar', () => {
    render(<LyricsPresetPicker />);
    fireEvent.click(screen.getByRole('radio', { name: 'Vinyl' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Transport' }));
    const box = document.querySelector('.lyrics-composer-handles__box') as HTMLElement | null;
    expect(box).toHaveAttribute('data-selection-bounds', 'transport');
    expect(Number.parseFloat(box?.style.width ?? '100')).toBeLessThanOrEqual(30);
  });
});
