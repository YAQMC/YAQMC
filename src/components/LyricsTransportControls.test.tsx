import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeTransportDefinition,
  builtinTransportDefinition,
  defaultLyricsTransportState,
  resolveLyricsTransport,
} from '../application/lyrics-transport';
import {
  LyricsTransportControls,
  type LyricsTransportControlsProps,
} from './LyricsTransportControls';

function props(): LyricsTransportControlsProps {
  return {
    definition: resolveLyricsTransport(defaultLyricsTransportState, 'window'),
    artworkSource: null,
    title: 'Track',
    artistLabel: 'Artist',
    isPlaying: false,
    positionMs: 1000,
    durationMs: 10000,
    getPositionMs: () => 1000,
    onPrevious: vi.fn(),
    onTogglePlayback: vi.fn(),
    onNext: vi.fn(),
    onBeginScrub: vi.fn(),
    onPreviewScrub: vi.fn(),
    onCommitScrub: vi.fn(),
    onCancelScrub: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shared transport permission and frame boundaries', () => {
  it('renders read-only progress without pointer or keyboard playback control', () => {
    const input = props();
    input.definition = authorizeTransportDefinition(
      builtinTransportDefinition('window'),
      new Set(['player.read']),
    )!;
    render(<LyricsTransportControls {...input} />);
    const slider = screen.getByRole('slider');
    expect(slider).toBeDisabled();
    fireEvent.pointerDown(slider);
    fireEvent.input(slider, { target: { value: '5000' } });
    fireEvent.pointerUp(slider);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(input.onBeginScrub).not.toHaveBeenCalled();
    expect(input.onPreviewScrub).not.toHaveBeenCalled();
    expect(input.onCommitScrub).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('commits one authorized seek, but never commits Tab, cancellation or a revoked drag', () => {
    const input = props();
    const { rerender } = render(<LyricsTransportControls {...input} />);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'Tab' });
    fireEvent.keyUp(slider, { key: 'Tab' });
    expect(input.onBeginScrub).not.toHaveBeenCalled();
    fireEvent.pointerDown(slider);
    fireEvent.input(slider, { target: { value: '6000' } });
    fireEvent.pointerUp(slider);
    expect(input.onCommitScrub).toHaveBeenCalledExactlyOnceWith(6000);
    fireEvent.pointerDown(slider);
    fireEvent.pointerCancel(slider);
    expect(input.onCancelScrub).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(slider);
    rerender(
      <LyricsTransportControls {...input} definition={{ ...input.definition, canSeek: false }} />,
    );
    expect(slider).toBeDisabled();
    fireEvent.pointerUp(slider);
    expect(input.onCancelScrub).toHaveBeenCalledTimes(2);
    expect(input.onCommitScrub).toHaveBeenCalledTimes(1);
  });

  it('updates the live DOM without React commits, and stops while hidden or without a timeline', () => {
    let pending: FrameRequestCallback | undefined;
    const request = vi.fn((callback: FrameRequestCallback) => {
      pending = callback;
      return 1;
    });
    const cancel = vi.fn(() => {
      pending = undefined;
    });
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    let position = 1000;
    const input = { ...props(), isPlaying: true, getPositionMs: () => position };
    const onRender = vi.fn();
    const view = (active: boolean, timeline = true) => (
      <Profiler id="transport" onRender={onRender}>
        <LyricsTransportControls
          {...input}
          active={active}
          definition={timeline ? input.definition : { ...input.definition, actions: ['playPause'] }}
        />
      </Profiler>
    );
    const { rerender } = render(view(true));
    const commits = onRender.mock.calls.length;
    for (let frame = 0; frame < 20; frame++) {
      position += 100;
      act(() => pending?.(frame * 16));
    }
    expect(onRender).toHaveBeenCalledTimes(commits);
    expect(screen.getByRole('slider')).toHaveValue('3000');
    expect(screen.getByText('0:03')).toBeVisible();
    rerender(view(false));
    expect(pending).toBeUndefined();
    rerender(view(true));
    expect(pending).toBeDefined();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(pending).toBeUndefined();
    vi.restoreAllMocks();
    fireEvent(document, new Event('visibilitychange'));
    expect(pending).toBeDefined();
    rerender(view(true, false));
    expect(pending).toBeUndefined();
  });
});
