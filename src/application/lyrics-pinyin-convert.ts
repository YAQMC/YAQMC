import { pinyin } from 'pinyin-pro';

const HAN = /\p{Script=Han}/u;

/** Pinyin per line, or `null` for lines without Han characters. */
export function pinyinForLines(texts: readonly string[]): (string | null)[] {
  return texts.map((text) =>
    HAN.test(text) ? pinyin(text, { nonZh: 'consecutive' }).replace(/\s+/gu, ' ').trim() : null,
  );
}
