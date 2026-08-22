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

// A normal vocal pause is often one bar or less. Only surface an interlude
// treatment for a clearly intentional musical break.
export const MIN_INTERLUDE_GAP_MS = 4_000;

export interface LyricInterlude {
  startMs: number;
  endMs: number;
  /** The displayed line immediately before the inserted dot marker, or -1 for an intro. */
  anchorLineIndex: number;
}

function timedLines(document: LyricDocument): { index: number; startMs: number }[] {
  const timed: { index: number; startMs: number }[] = [];
  document.lines.forEach((line, index) => {
    if (line.startMs !== null) timed.push({ index, startMs: line.startMs });
  });
  return timed;
}

export function lastSungLineIndex(document: LyricDocument | null, rawPositionMs: number): number {
  if (!document || document.syncMode === 'unsynchronized') return -1;
  const positionMs = rawPositionMs - document.metadata.offsetMs;
  let last = -1;
  for (const entry of timedLines(document)) {
    if (entry.startMs <= positionMs) last = entry.index;
  }
  return last;
}

export function lyricInterludeRemainingMs(
  document: LyricDocument | null,
  rawPositionMs: number,
): number | null {
  const interlude = activeLyricInterlude(document, rawPositionMs);
  if (!interlude) return null;
  return interlude.endMs - (rawPositionMs - (document?.metadata.offsetMs ?? 0));
}

/**
 * Resolves an intentional musical break using the same prefix-end model as AMLL:
 * a gap begins only after every earlier timed line has ended, so overlapping or
 * delayed vocal lines cannot accidentally produce an interlude marker.
 */
export function activeLyricInterlude(
  document: LyricDocument | null,
  rawPositionMs: number,
): LyricInterlude | null {
  if (!document || document.syncMode === 'unsynchronized') return null;
  const positionMs = rawPositionMs - document.metadata.offsetMs;
  const timed = timedLines(document).sort((left, right) => left.startMs - right.startMs);
  let latestEndMs = 0;
  let anchorLineIndex = -1;

  for (const current of timed) {
    const gapMs = current.startMs - latestEndMs;
    if (
      gapMs >= MIN_INTERLUDE_GAP_MS &&
      positionMs >= latestEndMs &&
      positionMs < current.startMs
    ) {
      return { startMs: latestEndMs, endMs: current.startMs, anchorLineIndex };
    }
    const endMs = effectiveLineEnd(document, current.index);
    if (Number.isFinite(endMs) && endMs > latestEndMs) latestEndMs = endMs;
    anchorLineIndex = current.index;
  }
  return null;
}

export function wordProgress(word: LyricWord, positionMs: number): number {
  const duration = Math.max(1, word.endMs - word.startMs);
  return Math.max(0, Math.min(1, (positionMs - word.startMs) / duration));
}

export function lyricScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth';
}
