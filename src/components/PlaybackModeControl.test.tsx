import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { setPlayerCommandAdapter } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { PlaybackModeControl } from './PlaybackModeControl';
import { PlayerBar } from './PlayerBar';

describe('PlaybackModeControl', () => {
  beforeEach(async () => {
    setPlayerCommandAdapter(null);
    usePlayerStore.setState(initialPlayerState);
    await i18n.changeLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    setPlayerCommandAdapter(null);
    usePlayerStore.setState(initialPlayerState);
  });

  it('opens a menu of Sequential, Shuffle, and Repeat One with a selected marker', () => {
    render(<PlaybackModeControl />);
    const trigger = screen.getByRole('button', { name: 'Playback mode: Sequential' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-pressed', 'false');
    expect(trigger.querySelector('[data-playback-icon="sequential"]')).not.toBeNull();

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Choose playback mode' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'Sequential' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(menu).getByRole('menuitemradio', { name: 'Shuffle' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(within(menu).getByRole('menuitemradio', { name: 'Repeat One' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(menu.querySelector('[data-playback-selected-mark="true"]')).not.toBeNull();
    expect(within(menu).getByRole('menuitemradio', { name: /Repeat All/ })).toBeVisible();
  });

  it('selects Repeat One directly and draws the loop-plus-one icon', () => {
    render(<PlaybackModeControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback mode: Sequential' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Repeat One' }));

    expect(usePlayerStore.getState()).toMatchObject({
      playbackOrder: 'sequential',
      repeat: 'one',
    });
    const trigger = screen.getByRole('button', { name: 'Playback mode: Repeat One' });
    expect(trigger).toHaveAttribute('aria-pressed', 'true');
    expect(trigger.querySelector('[data-playback-icon="repeat-one"]')).not.toBeNull();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps Shuffle order when entering and leaving Repeat One', () => {
    usePlayerStore.setState({ playbackOrder: 'shuffle', shuffle: true, repeat: 'off' });
    render(<PlaybackModeControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback mode: Shuffle' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Repeat One' }));
    expect(usePlayerStore.getState()).toMatchObject({
      playbackOrder: 'shuffle',
      shuffle: true,
      repeat: 'one',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Playback mode: Repeat One' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shuffle' }));
    expect(usePlayerStore.getState()).toMatchObject({
      playbackOrder: 'shuffle',
      shuffle: true,
      repeat: 'off',
    });
  });

  it('does not draw Repeat All as Sequential', () => {
    usePlayerStore.setState({ playbackOrder: 'sequential', repeat: 'all' });
    render(<PlaybackModeControl />);
    const trigger = screen.getByRole('button', { name: 'Playback mode: Repeat All' });
    expect(trigger.querySelector('[data-playback-icon="repeat-all"]')).not.toBeNull();
    expect(trigger.querySelector('[data-playback-icon="sequential"]')).toBeNull();
    expect(trigger).toHaveAttribute('aria-pressed', 'true');
  });

  it('closes on Escape and moves with arrow keys', () => {
    render(<PlaybackModeControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback mode: Sequential' }));
    const menu = screen.getByRole('menu', { name: 'Choose playback mode' });
    const sequential = within(menu).getByRole('menuitemradio', { name: 'Sequential' });
    sequential.focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Shuffle' })).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('localizes Sequential, Shuffle, and Repeat One', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<PlaybackModeControl />);
    fireEvent.click(screen.getByRole('button', { name: '播放模式：顺序播放' }));
    expect(screen.getByRole('menuitemradio', { name: '顺序播放' })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: '随机播放' })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: '单曲循环' })).toBeVisible();
  });
});

describe('PlayerBar playback mode control', () => {
  beforeEach(async () => {
    setPlayerCommandAdapter(null);
    usePlayerStore.setState(initialPlayerState);
    await i18n.changeLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    setPlayerCommandAdapter(null);
  });

  it('replaces the old shuffle and repeat toggles with a single playback-mode control', () => {
    render(<PlayerBar />);
    expect(screen.getByRole('button', { name: 'Playback mode: Sequential' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Enable shuffle' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Disable shuffle and return to sequential playback' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Repeat:/ })).not.toBeInTheDocument();
    expect(document.querySelector('.repeat-button')).toBeNull();
  });
});
