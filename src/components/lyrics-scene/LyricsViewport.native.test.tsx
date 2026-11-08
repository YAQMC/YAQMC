import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmllSettings } from '../../application/preferences';
import { useLyricsStageStore } from '../../application/lyrics-stage-machine';
import type { LyricDocument } from '../../domain/music';
import { LyricsViewport } from './LyricsViewport';

vi.mock('../../application/host-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAndroidRuntime: () => true,
}));

const invoke = vi.fn().mockResolvedValue({ value: true });

function lyricDocument(text: string, romanization?: string): LyricDocument {
  return {
    songId: 'song',
    syncMode: 'line',
    metadata: { sourceLabel: 'test', offsetMs: 0 },
    vocalists: [],
    lines: [
      { id: '1', startMs: 0, endMs: 2_000, text, romanization, words: [] },
      { id: '2', startMs: 2_000, endMs: 4_000, text: '二行目', words: [] },
    ],
  };
}

const amll: AmllSettings = {
  enableSpring: true,
  enableScale: true,
  enableBlur: true,
  hidePassedLines: false,
  wordFadeWidth: 0.5,
};

type Props = Parameters<typeof LyricsViewport>[0];

const baseDocument = lyricDocument('夢ならば', 'yu me na ra ba');
const seek = () => undefined;
const getPositionMs = () => 0;

function props(overrides: Partial<Props> = {}): Props {
  return {
    document: baseDocument,
    status: 'ready',
    isPlaying: true,
    timelineRevision: 0,
    presentationOffsetMs: 0,
    getPositionMs,
    seek,
    translation: 'auto',
    romanization: 'auto',
    wordEffect: 'jump',
    amll,
    followAnchor: 0.35,
    align: 'left',
    songId: 'song',
    styleKey: 'a',
    ...overrides,
  };
}

function calls(method: string) {
  return invoke.mock.calls
    .map(([call]) => call as { method: string; params?: Record<string, unknown> })
    .filter((call) => call.method === method);
}

describe('LyricsViewport native Android overlay', () => {
  beforeEach(() => {
    invoke.mockClear();
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: { YaqmcNative: { invoke, addListener: vi.fn(() => ({ remove: vi.fn() })) } },
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 10,
      left: 0,
      width: 360,
      height: 600,
      right: 360,
      bottom: 610,
      x: 0,
      y: 10,
      toJSON: () => ({}),
    });
    useLyricsStageStore.setState({ stage: 'open' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;
    useLyricsStageStore.setState({ stage: 'closed' });
  });

  it('shows once with lines and the separated alignment options', () => {
    render(<LyricsViewport {...props()} />);
    const shows = calls('lyrics_show');
    expect(shows).toHaveLength(1);
    const params = shows[0]!.params as {
      lines: Array<{ romanLyric: string }>;
      options: Record<string, unknown>;
    };
    expect(params.lines[0]!.romanLyric).toBe('yu me na ra ba');
    expect(params.options).toMatchObject({
      alignAnchor: 'center',
      textAlign: 'left',
      followAnchor: 0.35,
      wordEmphasis: true,
      timingOffsetMs: 0,
    });
  });

  it('turns every style setting change into an in-place update without lines', () => {
    const view = render(<LyricsViewport {...props()} />);
    const changes: Array<[Partial<Props>, Record<string, unknown>]> = [
      [{ align: 'right' }, { textAlign: 'right' }],
      [{ followAnchor: 0.6 }, { followAnchor: 0.6 }],
      [{ amll: { ...amll, enableBlur: false } }, { enableBlur: false }],
      [{ amll: { ...amll, enableSpring: false } }, { enableSpring: false }],
      [{ amll: { ...amll, enableScale: false } }, { enableScale: false }],
      [{ amll: { ...amll, hidePassedLines: true } }, { hidePassedLines: true }],
      [{ amll: { ...amll, wordFadeWidth: 0.9 } }, { wordFadeWidth: 0.9 }],
      [{ wordEffect: 'fill' }, { wordEmphasis: false }],
      [{ presentationOffsetMs: 250 }, { timingOffsetMs: 250 }],
    ];
    let current = props();
    for (const [patch, expected] of changes) {
      invoke.mockClear();
      current = { ...current, ...patch };
      view.rerender(<LyricsViewport {...current} />);
      const updates = calls('lyrics_update');
      expect(updates, JSON.stringify(patch)).toHaveLength(1);
      expect(updates[0]!.params).not.toHaveProperty('lines');
      expect(updates[0]!.params!.options).toMatchObject(expected);
      expect(calls('lyrics_hide')).toHaveLength(0);
      expect(calls('lyrics_show')).toHaveLength(0);
    }
  });

  it('re-reads scene CSS when the style key changes and skips identical pushes', () => {
    const scene = (p: Props) => (
      <div className="lyrics-scene" data-testid="scene">
        <LyricsViewport {...p} />
      </div>
    );
    const view = render(scene(props()));
    invoke.mockClear();
    view.rerender(scene(props()));
    expect(invoke).not.toHaveBeenCalled();
    // LyricsScene writes the new CSS variables and a new style key in the same commit.
    const root = view.getByTestId('scene');
    root.style.setProperty('--lyrics-line-height', '1.4');
    root.style.setProperty('--lyrics-font-weight', '800');
    view.rerender(scene(props({ styleKey: 'b' })));
    const updates = calls('lyrics_update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params).not.toHaveProperty('lines');
    expect(updates[0]!.params!.options).toMatchObject({ lineHeight: 1.4, fontWeight: 800 });
  });

  it('sends new lines for a new document or secondary-line setting without hiding', () => {
    const view = render(<LyricsViewport {...props()} />);
    invoke.mockClear();
    view.rerender(<LyricsViewport {...props({ romanization: 'hide' })} />);
    let updates = calls('lyrics_update');
    expect(updates).toHaveLength(1);
    expect((updates[0]!.params!.lines as Array<{ romanLyric: string }>)[0]!.romanLyric).toBe('');
    invoke.mockClear();
    view.rerender(
      <LyricsViewport {...props({ romanization: 'hide', document: lyricDocument('次の曲') })} />,
    );
    updates = calls('lyrics_update');
    expect(updates).toHaveLength(1);
    expect(calls('lyrics_hide')).toHaveLength(0);
  });

  it('hides when the lyrics stage closes and shows again with current options on reopen', () => {
    const view = render(<LyricsViewport {...props({ align: 'center' })} />);
    invoke.mockClear();
    act(() => useLyricsStageStore.setState({ stage: 'closed' }));
    expect(calls('lyrics_hide')).toHaveLength(1);
    act(() => useLyricsStageStore.setState({ stage: 'open' }));
    const shows = calls('lyrics_show');
    expect(shows).toHaveLength(1);
    expect(shows[0]!.params!.options).toMatchObject({ textAlign: 'center' });
    view.unmount();
    expect(calls('lyrics_hide')).toHaveLength(2);
  });
});
