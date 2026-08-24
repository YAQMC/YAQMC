import { useEffect, useState } from 'react';
import type { LyricDocument, LyricLine, LyricSyncMode, Song } from '../domain/music';
import { nextLyricBoundaryMs, selectLyricCursor } from './lyrics-timing';
import {
  normalizePreferences,
  usePreferencesStore,
  type AppPreferences,
  type SurfaceInteraction,
  type SurfaceKind,
} from './preferences';
import { getYaqmcClient } from './yaqmc-runtime';
import { subscribeSurfaceVisualActive, surfaceVisualActive } from './lyrics-surface-visual';

export interface LyricSurfaceProjection {
  timestampMs: number;
  sessionId?: number;
  currentTrack: Song | null;
  positionMs: number;
  isPlaying: boolean;
  playbackState: string;
  playbackDurationMs: number | null;
  syncMode: LyricSyncMode | null;
  lineIndex: number | null;
  wordIndex: number | null;
  currentLine: LyricLine | null;
  nextLine: LyricLine | null;
}

export interface TimedProjection {
  value: LyricSurfaceProjection;
  receivedAt: number;
}

const UNIX_MS = 1_000_000_000_000;
const SAMPLE_FRESH_MS = 2_000;

export function estimatedSurfacePosition(
  projection: TimedProjection,
  now = performance.now(),
  nowUnix = Date.now(),
): number {
  const sampledAtMs = projection.value.timestampMs;
  let elapsed = 0;
  if (projection.value.isPlaying) {
    if (
      sampledAtMs >= UNIX_MS &&
      nowUnix - sampledAtMs >= 0 &&
      nowUnix - sampledAtMs < SAMPLE_FRESH_MS
    ) {
      elapsed = nowUnix - sampledAtMs;
    } else {
      elapsed = Math.max(0, now - projection.receivedAt);
    }
  }
  const duration = projection.value.playbackDurationMs ?? Number.POSITIVE_INFINITY;
  return Math.min(duration, projection.value.positionMs + elapsed);
}

export function matchingSurfaceDocument(
  projection: TimedProjection | null,
  document: LyricDocument | null,
): LyricDocument | null {
  return projection?.value.currentTrack?.id === document?.songId ? document : null;
}

export function shouldReplaceSurfaceProjection(
  previous: TimedProjection | null,
  next: LyricSurfaceProjection,
): boolean {
  if (!previous) return true;
  const prev = previous.value;
  if ((next.sessionId ?? 0) !== (prev.sessionId ?? 0)) return true;
  if (prev.currentTrack?.id !== next.currentTrack?.id) return true;
  if (prev.isPlaying !== next.isPlaying) return true;
  if (prev.playbackDurationMs !== next.playbackDurationMs) return true;
  if (prev.lineIndex !== next.lineIndex) return true;
  return Math.abs(prev.positionMs - next.positionMs) > 250;
}

export function projectSurfaceLyrics(
  document: LyricDocument | null,
  positionMs: number,
  timingOffsetMs: number,
): { current: LyricLine | null; next: LyricLine | null; wordIndex: number } {
  if (!document) return { current: null, next: null, wordIndex: -1 };
  const cursor = selectLyricCursor(document, positionMs + timingOffsetMs);
  if (!cursor.line && document.syncMode !== 'unsynchronized') {
    const lyricPositionMs = positionMs + timingOffsetMs - document.metadata.offsetMs;
    let previousLineIndex = -1;
    for (let index = 0; index < document.lines.length; index += 1) {
      const startMs = document.lines[index]?.startMs;
      if (startMs !== null && startMs !== undefined && startMs <= lyricPositionMs) {
        previousLineIndex = index;
      }
    }
    if (previousLineIndex >= 0) {
      const previous = document.lines[previousLineIndex] ?? null;
      return {
        current: previous,
        next: document.lines[previousLineIndex + 1] ?? null,
        wordIndex: previous?.words.length ?? -1,
      };
    }
  }
  return {
    current: cursor.line,
    next: cursor.lineIndex >= 0 ? (document.lines[cursor.lineIndex + 1] ?? null) : null,
    wordIndex: cursor.wordIndex,
  };
}

export function useLyricsSurfaceRuntime(): {
  projection: TimedProjection | null;
  document: LyricDocument | null;
} {
  const [projection, setProjection] = useState<TimedProjection | null>(null);
  const [document, setDocument] = useState<LyricDocument | null>(null);

  useEffect(() => {
    let active = true;
    let receivedProjectionEvent = false;
    let acceptedSession = 0;
    let acceptedTrackId: string | null = null;
    const pendingDocuments = new Map<string, LyricDocument>();
    const client = getYaqmcClient();
    const acceptDocument = (payload: LyricDocument | null | undefined) => {
      if (!payload) return;
      if (acceptedTrackId && payload.songId !== acceptedTrackId) {
        pendingDocuments.set(payload.songId, payload);
        return;
      }
      pendingDocuments.delete(payload.songId);
      if (active) setDocument(payload);
    };
    const pullDocument = (trackId: string | null) => {
      const pending = trackId ? pendingDocuments.get(trackId) : undefined;
      if (pending) acceptDocument(pending);
      void client.player
        .lyrics()
        .then((value) => {
          if (!active || !value) return;
          if (trackId && value.songId !== trackId) return;
          acceptDocument(value);
        })
        .catch(() => undefined);
    };
    const updateProjection = (value: LyricSurfaceProjection) => {
      const session = value.sessionId ?? 0;
      if (session !== 0 && session < acceptedSession) return;
      const nextTrack = value.currentTrack?.id ?? null;
      const trackChanged = Boolean(nextTrack) && nextTrack !== acceptedTrackId;
      if (session > acceptedSession) {
        acceptedSession = session;
        acceptedTrackId = nextTrack;
      } else if (nextTrack) {
        acceptedTrackId = nextTrack;
      }
      if (active) {
        setProjection((previous) =>
          shouldReplaceSurfaceProjection(previous, value)
            ? { value, receivedAt: performance.now() }
            : previous,
        );
      }
      if (trackChanged) pullDocument(nextTrack);
    };

    const stopProjection = client.on('lyrics://projection', (payload) => {
      if (active) {
        receivedProjectionEvent = true;
        updateProjection(payload);
      }
    });
    const stopDocument = client.on('lyrics://document', (payload) => {
      if (active) acceptDocument(payload);
    });
    void client.player
      .projection()
      .then((value) => {
        if (active && !receivedProjectionEvent) updateProjection(value);
      })
      .catch(() => undefined);
    pullDocument(null);

    return () => {
      active = false;
      stopProjection();
      stopDocument();
    };
  }, []);

  const activeDocument = matchingSurfaceDocument(projection, document);
  return { projection, document: activeDocument };
}

export function useProjectedLyrics(
  projection: TimedProjection | null,
  document: LyricDocument | null,
): { current: LyricLine | null; next: LyricLine | null; wordIndex: number } {
  const timingOffsetMs = usePreferencesStore((state) => state.lyrics.timingOffsetMs);
  const playing = projection?.value.isPlaying ?? false;
  const [projected, setProjected] = useState(() =>
    projectSurfaceLyrics(
      document,
      projection ? estimatedSurfacePosition(projection) : 0,
      timingOffsetMs,
    ),
  );

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      generation += 1;
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };

    const apply = (now = performance.now()) => {
      const next = projectSurfaceLyrics(
        document,
        projection ? estimatedSurfacePosition(projection, now) : 0,
        timingOffsetMs,
      );
      setProjected((previous) =>
        previous.current?.id === next.current?.id &&
        previous.next?.id === next.next?.id &&
        previous.wordIndex === next.wordIndex
          ? previous
          : next,
      );
    };

    const schedule = () => {
      clearTimer();
      if (cancelled) return;
      apply();
      if (!playing || !document || !surfaceVisualActive()) return;
      const rawPositionMs =
        (projection ? estimatedSurfacePosition(projection) : 0) + timingOffsetMs;
      const rawBoundary = nextLyricBoundaryMs(document, rawPositionMs);
      if (rawBoundary === null) return;
      const delayMs = Math.min(500, Math.max(16, rawBoundary - rawPositionMs + 8));
      const scheduledGeneration = ++generation;
      timer = setTimeout(() => {
        if (cancelled || scheduledGeneration !== generation) return;
        timer = null;
        schedule();
      }, delayMs);
    };

    schedule();
    const stopVisual = subscribeSurfaceVisualActive(schedule);
    return () => {
      cancelled = true;
      clearTimer();
      stopVisual();
    };
  }, [document, playing, projection, timingOffsetMs]);

  return projected;
}

export async function closeLyricsSurface(kind: SurfaceKind): Promise<void> {
  const store = usePreferencesStore.getState();
  store.updateSurface(kind, { enabled: false });
  await getYaqmcClient().invoke('lyrics_surface_close', { kind });
}

export async function unlockAllLyricsSurfaces(): Promise<number> {
  const unlocked = await getYaqmcClient().invoke('lyrics_surfaces_unlock_all');
  const store = usePreferencesStore.getState();
  for (const kind of ['desktop', 'island'] as const) {
    if (store.surfaces[kind].interaction === 'passive-locked') {
      store.setSurfaceInteractionLocal(kind, 'interactive');
    }
  }
  return unlocked;
}

const interactionTransitions: Record<SurfaceKind, Promise<void>> = {
  desktop: Promise.resolve(),
  island: Promise.resolve(),
};

function currentPreferenceDocument(): AppPreferences {
  const state = usePreferencesStore.getState();
  return {
    version: 2,
    locale: state.locale,
    appearance: state.appearance,
    lyrics: state.lyrics,
    amll: state.amll,
    lyricsPresets: state.lyricsPresets,
    surfaces: state.surfaces,
    system: state.system,
    debug: state.debug,
  };
}

async function applyLyricsSurfaceInteraction(
  kind: SurfaceKind,
  interaction: SurfaceInteraction,
): Promise<void> {
  const store = usePreferencesStore.getState();
  const previous = store.surfaces[kind].interaction;
  if (previous === interaction) return;

  store.setSurfaceInteractionLocal(kind, interaction);
  try {
    const value = await getYaqmcClient().invoke('lyrics_surface_set_interaction', {
      kind,
      interaction,
      value: JSON.stringify(currentPreferenceDocument()),
    });
    usePreferencesStore.getState().hydrate(normalizePreferences(JSON.parse(value)));
  } catch (error) {
    usePreferencesStore.getState().setSurfaceInteractionLocal(kind, previous);
    usePreferencesStore.setState({ persistenceError: String(error) });
    throw error;
  }
}

export function setLyricsSurfaceInteraction(
  kind: SurfaceKind,
  interaction: SurfaceInteraction,
): Promise<void> {
  const transition = interactionTransitions[kind]
    .catch(() => undefined)
    .then(() => applyLyricsSurfaceInteraction(kind, interaction));
  interactionTransitions[kind] = transition.catch(() => undefined);
  return transition;
}

export async function resetLyricsSurfacePosition(kind: SurfaceKind): Promise<void> {
  await getYaqmcClient().invoke('lyrics_surface_reset_position', { kind });
}

export async function showLyricsSettings(): Promise<void> {
  await getYaqmcClient().invoke('lyrics_surface_show_settings');
}
