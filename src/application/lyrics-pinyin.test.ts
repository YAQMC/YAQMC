import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LyricDocument } from '../domain/music';
import { needsGeneratedPinyin, withGeneratedPinyin } from './lyrics-pinyin';
import { pinyinForLines } from './lyrics-pinyin-convert';

function lyrics(language: string | undefined, romanization?: string): LyricDocument {
  return {
    songId: 'song',
    syncMode: 'word',
    metadata: { sourceLabel: 'test', offsetMs: 0, language },
    vocalists: [],
    lines: [
      {
        id: 'l1',
        startMs: 0,
        endMs: 1000,
        text: '十年之前 baby',
        romanization,
        words: [{ startMs: 0, endMs: 500, text: '十年' }],
      },
      { id: 'l2', startMs: 1000, endMs: 2000, text: 'Oh yeah', words: [] },
    ],
  };
}

describe('generated pinyin', () => {
  it('only applies to Mandarin without provider romanization', () => {
    expect(needsGeneratedPinyin(lyrics('cmn'))).toBe(true);
    expect(needsGeneratedPinyin(lyrics('yue'))).toBe(false);
    expect(needsGeneratedPinyin(lyrics(undefined))).toBe(false);
    expect(needsGeneratedPinyin(lyrics('zh-Hans'))).toBe(false);
    expect(needsGeneratedPinyin(lyrics('cmn', 'shi nian'))).toBe(false);
  });

  it('converts Han lines to pinyin and skips lines without Han characters', () => {
    expect(pinyinForLines(['十年之前 baby', 'Oh yeah'])).toEqual(['shí nián zhī qián baby', null]);
  });

  describe('off the main thread', () => {
    afterEach(() => vi.unstubAllGlobals());

    class FakeWorker {
      static instances: FakeWorker[] = [];
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      posted: unknown[] = [];
      terminated = false;
      constructor(
        readonly url: URL,
        readonly options: WorkerOptions,
      ) {
        FakeWorker.instances.push(this);
      }
      postMessage(value: unknown) {
        this.posted.push(value);
      }
      terminate() {
        this.terminated = true;
      }
    }

    it('converts in a module worker and releases it after the reply', async () => {
      FakeWorker.instances = [];
      vi.stubGlobal('Worker', FakeWorker);
      const pending = withGeneratedPinyin(lyrics('cmn'));
      const worker = FakeWorker.instances[0]!;
      expect(worker.options.type).toBe('module');
      expect(worker.posted).toEqual([['十年之前 baby', 'Oh yeah']]);
      worker.onmessage?.({ data: ['shí nián zhī qián baby', null] } as MessageEvent);
      const generated = await pending;
      expect(generated.lines[0]?.romanization).toBe('shí nián zhī qián baby');
      expect(generated.lines[1]?.romanization).toBeUndefined();
      // Line-level only: word timing is left untouched.
      expect(generated.lines[0]?.words).toEqual(lyrics('cmn').lines[0]?.words);
      expect(worker.terminated).toBe(true);
    });

    it('terminates the worker when the track changes', async () => {
      FakeWorker.instances = [];
      vi.stubGlobal('Worker', FakeWorker);
      const controller = new AbortController();
      const pending = withGeneratedPinyin(lyrics('cmn'), controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(FakeWorker.instances[0]?.terminated).toBe(true);
    });
  });
});
