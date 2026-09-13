import type { LyricDocument, LyricLine } from '../domain/music';
import { shouldShowLyricSecondary } from './lyrics-presentation';
import type { SecondaryLyricVisibility } from './preferences';

export interface RenderLyricWord {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
}

/**
 * Platform-neutral lyric presentation line.
 *
 * Both the web AMLL renderer and Android-native renderer should consume this model so timing,
 * secondary-line visibility, duet mapping and invalid-data filtering stay identical.
 */
export interface RenderLyricLine {
  sourceLineIndex: number;
  words: RenderLyricWord[];
  translatedLyric: string;
  romanLyric: string;
  startTimeMs: number;
  endTimeMs: number;
  isBackground: boolean;
  isDuet: boolean;
}

export interface LyricsRenderModel {
  lines: RenderLyricLine[];
}

function finiteLineEnd(line: LyricLine): number | null {
  if (line.endMs !== null && Number.isFinite(line.endMs) && line.endMs >= (line.startMs ?? 0)) {
    return line.endMs;
  }
  const wordEnd = line.words.reduce(
    (latest, word) => (Number.isFinite(word.endMs) ? Math.max(latest, word.endMs) : latest),
    Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(wordEnd) ? wordEnd : null;
}

export function buildLyricsRenderModel(
  document: LyricDocument,
  translation: SecondaryLyricVisibility,
  romanization: SecondaryLyricVisibility,
): LyricsRenderModel {
  const lines: RenderLyricLine[] = [];

  for (const [sourceLineIndex, sourceLine] of document.lines.entries()) {
    if (sourceLine.startMs === null || !Number.isFinite(sourceLine.startMs)) continue;
    const endMs = finiteLineEnd(sourceLine);
    if (endMs === null) continue;

    const words =
      document.syncMode === 'word' && sourceLine.words.length > 0
        ? sourceLine.words
            .filter(
              (word) =>
                Number.isFinite(word.startMs) &&
                Number.isFinite(word.endMs) &&
                word.endMs >= word.startMs,
            )
            .map((word) => ({
              startTimeMs: Math.round(word.startMs),
              endTimeMs: Math.round(word.endMs),
              text: word.text,
            }))
        : [];

    const timedWords =
      words.length > 0
        ? words
        : [
            {
              startTimeMs: Math.round(sourceLine.startMs),
              endTimeMs: Math.round(endMs),
              text: sourceLine.text,
            },
          ];

    lines.push({
      sourceLineIndex,
      words: timedWords,
      translatedLyric: shouldShowLyricSecondary(
        translation,
        sourceLine.translation,
        sourceLine.text,
        'translation',
      )
        ? (sourceLine.translation ?? '')
        : '',
      romanLyric: shouldShowLyricSecondary(
        romanization,
        sourceLine.romanization,
        sourceLine.text,
        'romanization',
      )
        ? (sourceLine.romanization ?? '')
        : '',
      startTimeMs: Math.round(sourceLine.startMs),
      endTimeMs: Math.round(endMs),
      isBackground: false,
      isDuet: sourceLine.vocalistId === 'response',
    });
  }

  return { lines };
}
