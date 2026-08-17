import { useEffect, useMemo, useState } from 'react';
import type { LyricDocument, LyricLine, LyricSyncMode, Song } from '../domain/music';
import { selectLyricCursor } from './lyrics-timing';
import {
  normalizePreferences,
  usePreferencesStore,
  type AppPreferences,
  type SurfaceInteraction,
  type SurfaceKind,
} from './preferences';
import { getYaqmcClient } from './yaqmc-runtime';

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

export function estimatedSurfacePosition(
  projection: TimedProjection,
  now = performance.now(),
): number {
  const elapsed = projection.value.isPlaying ? now - projection.receivedAt : 0;
  const duration = projection.value.playbackDurationMs ?? Number.POSITIVE_INFINITY;
  return Math.min(duration, projection.value.positionMs + Math.max(0, elapsed));
}

export function matchingSurfaceDocument(
  projection: TimedProjection | null,
  document: LyricDocument | null,
): LyricDocument | null {
  return projection?.value.currentTrack?.id === document?.songId ? document : null;
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
    let receivedDocumentEvent = false;
    let acceptedSession = 0;
    let acceptedTrackId: string | null = null;
    const client = getYaqmcClient();
    const updateProjection = (value: LyricSurfaceProjection) => {
      const session = value.sessionId ?? 0;
      if (session !== 0 && session < acceptedSession) return;
      if (session > acceptedSession) acceptedSession = session;
      acceptedTrackId = value.currentTrack?.id ?? null;
      if (active) setProjection({ value, receivedAt: performance.now() });
    };

    const stopProjection = client.on('lyrics://projection', (payload) => {
      if (active) {
        receivedProjectionEvent = true;
        updateProjection(payload);
      }
    });
    const stopDocument = client.on('lyrics://document', (payload) => {
      if (active) {
        if (payload && acceptedTrackId && payload.songId !== acceptedTrackId) {
          return;
        }
        receivedDocumentEvent = true;
        setDocument(payload);
      }
    });
    void client.player
      .projection()
      .then((value) => {
        if (active && !receivedProjectionEvent) updateProjection(value);
      })
      .catch(() => undefined);
    void client.player
      .lyrics()
      .then((value) => {
        if (active && !receivedDocumentEvent) setDocument(value);
      })
      .catch(() => undefined);

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
  return useMemo(() => {
    return projectSurfaceLyrics(document, projection?.value.positionMs ?? 0, timingOffsetMs);
  }, [document, projection, timingOffsetMs]);
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
