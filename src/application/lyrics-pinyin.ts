import type { LyricDocument } from '../domain/music';

const HAN = /\p{Script=Han}/u;

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

/** Line-level only: generated readings carry no timing, so word timing is left untouched. */
export async function withGeneratedPinyin(document: LyricDocument): Promise<LyricDocument> {
  const { pinyin } = await import('pinyin-pro');
  return {
    ...document,
    lines: document.lines.map((line) =>
      HAN.test(line.text)
        ? {
            ...line,
            romanization: pinyin(line.text, { nonZh: 'consecutive' }).replace(/\s+/gu, ' ').trim(),
          }
        : line,
    ),
  };
}
