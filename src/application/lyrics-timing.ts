import type { LyricDocument, LyricLine, LyricWord } from '../domain/music';

export interface LyricCursor {
  lineIndex: number;
  wordIndex: number;
  line: LyricLine | null;
  word: LyricWord | null;
}

export const emptyLyricCursor: LyricCursor = {
  lineIndex: -1,
  wordIndex: -1,
  line: null,
  word: null,
};

function effectiveLineEnd(document: LyricDocument, lineIndex: number): number {
  const line = document.lines[lineIndex];
  if (!line) return 0;
  if (line.endMs !== null) return line.endMs;

  const nextTimedLine = document.lines
    .slice(lineIndex + 1)
    .find((candidate) => candidate.startMs !== null);
  return nextTimedLine?.startMs ?? Number.POSITIVE_INFINITY;
}

export function nextLyricBoundaryMs(
  document: LyricDocument | null,
  rawPositionMs: number,
): number | null {
  if (!document || document.syncMode === 'unsynchronized' || !Number.isFinite(rawPositionMs)) {
    return null;
  }

  const offsetMs = document.metadata.offsetMs;
  const lyricTimeMs = rawPositionMs - offsetMs;
  let nextBoundary = Number.POSITIVE_INFINITY;
  const consider = (boundary: number) => {
    if (Number.isFinite(boundary) && boundary > lyricTimeMs && boundary < nextBoundary) {
      nextBoundary = boundary;
    }
  };

  document.lines.forEach((line, lineIndex) => {
    if (line.startMs !== null) consider(line.startMs);
    consider(effectiveLineEnd(document, lineIndex));
    line.words.forEach((word) => {
      consider(word.startMs);
      consider(word.endMs);
    });
  });

  if (!Number.isFinite(nextBoundary)) return null;
  const rawBoundary = nextBoundary + offsetMs;
  return Number.isFinite(rawBoundary) ? rawBoundary : null;
}

export function selectLyricCursor(
  document: LyricDocument | null,
  rawPositionMs: number,
): LyricCursor {
  if (!document || document.syncMode === 'unsynchronized') return emptyLyricCursor;
  const positionMs = rawPositionMs - document.metadata.offsetMs;

  const lineIndex = document.lines.findIndex((line, index) => {
    if (line.startMs === null) return false;
    return positionMs >= line.startMs && positionMs < effectiveLineEnd(document, index);
  });

  if (lineIndex < 0) return emptyLyricCursor;
  const line = document.lines[lineIndex] ?? null;
  if (!line) return emptyLyricCursor;

  const wordIndex = line.words.findIndex(
    (word) => positionMs >= word.startMs && positionMs < word.endMs,
  );

  return {
    lineIndex,
    wordIndex,
    line,
    word: wordIndex >= 0 ? (line.words[wordIndex] ?? null) : null,
  };
}

export function lyricCursorKey(document: LyricDocument | null, positionMs: number): string {
  const cursor = selectLyricCursor(document, positionMs);
  return `${cursor.lineIndex}:${cursor.wordIndex}`;
}

export function wordProgress(word: LyricWord, positionMs: number): number {
  const duration = Math.max(1, word.endMs - word.startMs);
  return Math.max(0, Math.min(1, (positionMs - word.startMs) / duration));
}

export function lyricScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth';
}
