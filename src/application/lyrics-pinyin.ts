import type { LyricDocument } from '../domain/music';

/**
 * Only an explicit Mandarin tag (`cmn`) qualifies: Han text alone cannot tell Mandarin from
 * Cantonese, and provider romanization always wins over generated text.
 */
export function needsGeneratedPinyin(document: LyricDocument): boolean {
  return (
    document.metadata.language === 'cmn' &&
    !document.lines.some((line) => line.romanization?.trim())
  );
}

function convertOffThread(texts: string[], signal?: AbortSignal): Promise<(string | null)[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lyrics-pinyin.worker.ts', import.meta.url), {
      type: 'module',
    });
    const stop = () => {
      worker.terminate();
      reject(new DOMException('Pinyin generation was cancelled', 'AbortError'));
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    worker.onmessage = (event: MessageEvent<(string | null)[]>) => {
      signal?.removeEventListener('abort', stop);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      signal?.removeEventListener('abort', stop);
      worker.terminate();
      reject(new Error(event.message || 'Pinyin worker failed'));
    };
    worker.postMessage(texts);
  });
}

/** Line-level only: generated readings carry no timing, so word timing is left untouched. */
export async function withGeneratedPinyin(
  document: LyricDocument,
  signal?: AbortSignal,
): Promise<LyricDocument> {
  const readings = await convertOffThread(
    document.lines.map((line) => line.text),
    signal,
  );
  return {
    ...document,
    lines: document.lines.map((line, index) => {
      const romanization = readings[index];
      return romanization ? { ...line, romanization } : line;
    }),
  };
}
