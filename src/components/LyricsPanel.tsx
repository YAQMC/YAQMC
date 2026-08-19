import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, Heart, Image } from 'lucide-react';
import { useAccountStore, useFavoriteState } from '../application/account-runtime';
import { useLyricsStore } from '../application/lyrics-store';
import {
  lineGapFromLineHeight,
  nextResolvedPreset,
  resolveLyricsPreset,
} from '../application/lyrics-preset';
import { getEstimatedPositionMs, usePlayerStore } from '../application/player-store';
import {
  LYRICS_STAGE_ENTER_ANIMATION,
  LYRICS_STAGE_EXIT_ANIMATION,
  LYRICS_STAGE_TRANSITION_MS,
  useLyricsStageStore,
  type LyricsStageState,
} from '../application/lyrics-stage-machine';
import { noteLyricsPanelCommit } from '../application/lyrics-perf-counters';
import { ProviderContext } from '../application/provider-context';
import { isAccountMusicProvider } from '../providers/music-provider';
import { joinArtistNames } from '../utils/format';
import { IconButton } from './ui/IconButton';
import { useTranslation } from 'react-i18next';
import { usePreferencesStore } from '../application/preferences';
import { applySceneBackdrop, resolveLyricsAppearance } from '../application/lyrics-appearance';
import { useSafeArtworkSource } from '../application/artwork-source';
import { resolveArtworkSource } from '../application/artwork-resolver';
import { useBlurredArtwork } from '../application/blurred-artwork';
import {
  lyricsArtworkFallback,
  lyricsBlurredBackdropFallback,
  rememberLyricsArtwork,
  rememberLyricsBlurredBackdrop,
} from '../application/lyrics-artwork-fallback';
import {
  LyricsFullscreenTransport,
  type LyricsFullscreenTransportHandle,
} from './LyricsFullscreenTransport';
import { LyricsScene } from './lyrics-scene';
import type { LyricsSceneBindings } from './lyrics-scene';

type LyricsStyle = CSSProperties & {
  '--lyrics-color': string;
  '--lyrics-ink': string;
  '--lyrics-ink-contrast': string;
  '--lyrics-stage-base': string;
  '--lyrics-font-scale': number;
  '--lyrics-line-height': number;
  '--lyrics-line-gap': string;
};

interface LyricsPanelProps {
  focus: boolean;
  fullscreen: boolean;
  fullscreenError: string | null;
  onClose: () => void;
}

export function LyricsPanel(props: LyricsPanelProps) {
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const stage = useLyricsStageStore((state) => state.stage);

  useLayoutEffect(() => {
    if (lyricsOpen) useLyricsStageStore.getState().requestOpen();
    else useLyricsStageStore.getState().requestClose();
  }, [lyricsOpen]);

  if (stage === 'closed' && !lyricsOpen) return null;
  return (
    <LyricsPanelStage
      {...props}
      stageState={stage === 'closed' && lyricsOpen ? 'entering' : stage}
    />
  );
}

function LyricsPanelStage({
  focus,
  fullscreen,
  fullscreenError,
  onClose,
  stageState,
}: LyricsPanelProps & { stageState: LyricsStageState }) {
  noteLyricsPanelCommit();
  const { t } = useTranslation('lyrics');
  const { t: player } = useTranslation('player');
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const setFavorite = useAccountStore((state) => state.setFavorite);
  const currentTrackId = usePlayerStore((state) => state.queue[state.currentIndex]?.id ?? null);
  const currentTitle = usePlayerStore((state) => state.queue[state.currentIndex]?.title ?? '');
  const currentArtistLabel = usePlayerStore((state) =>
    joinArtistNames(state.queue[state.currentIndex]?.artists ?? []),
  );
  const currentAlbumTitle = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.album.title ?? '',
  );
  const currentArtworkBaseSrc = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.artwork.src ?? '',
  );
  const currentArtworkVariants = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.artwork.variants,
  );
  const currentArtworkAlt = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.artwork.alt ?? '',
  );
  const currentArtworkColor = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.artwork.dominantColor ?? '#20231C',
  );
  const currentDurationMs = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.durationMs ?? 0,
  );
  const currentIsFavorite = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.isFavorite ?? false,
  );
  const currentProvider = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.provider ?? null,
  );
  const playbackDurationMs = usePlayerStore((state) => state.playbackDurationMs);
  const seek = usePlayerStore((state) => state.seek);
  const beginScrub = usePlayerStore((state) => state.beginScrub);
  const previewScrub = usePlayerStore((state) => state.previewScrub);
  const commitScrub = usePlayerStore((state) => state.commitScrub);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);
  const next = usePlayerStore((state) => state.next);
  const previous = usePlayerStore((state) => state.previous);
  const { favorite, pending: favoritePending } = useFavoriteState(
    currentTrackId ?? undefined,
    currentIsFavorite,
  );
  const document = useLyricsStore((state) => state.document);
  const status = useLyricsStore((state) => state.status);
  const translation = usePreferencesStore((state) => state.lyrics.translation);
  const romanization = usePreferencesStore((state) => state.lyrics.romanization);
  const wordEffect = usePreferencesStore((state) => state.lyrics.wordEffect);
  const presentationOffsetMs = usePreferencesStore((state) => state.lyrics.timingOffsetMs);
  const lyricsPresets = usePreferencesStore((state) => state.lyricsPresets);
  const selectLyricsPreset = usePreferencesStore((state) => state.selectLyricsPreset);
  const backgroundMode = usePreferencesStore((state) => state.appearance.backgroundMode);
  const backgroundColor = usePreferencesStore((state) => state.appearance.backgroundColor);
  const backgroundImageSource = usePreferencesStore((state) => state.backgroundImageData);
  const resolvedPreset = resolveLyricsPreset(lyricsPresets);
  const nextPreset = nextResolvedPreset(lyricsPresets);
  const coverLayout = resolvedPreset.layout;
  const nextCoverLabel =
    nextPreset.source === 'custom'
      ? (nextPreset.name ?? t('customPreset'))
      : nextPreset.layout === 'full'
        ? t('coverFull')
        : nextPreset.layout === 'vinyl'
          ? t('coverVinyl')
          : t('coverSplit');
  const backgroundFit = resolvedPreset.background.fit;
  const currentArtworkSrc = currentArtworkBaseSrc
    ? resolveArtworkSource(
        {
          src: currentArtworkBaseSrc,
          alt: currentArtworkAlt,
          dominantColor: currentArtworkColor,
          variants: currentArtworkVariants,
        },
        'fullscreen',
      )
    : '';
  const safeArtworkSource = useSafeArtworkSource(currentArtworkSrc || null, {
    pendingRemote: 'hide',
  });
  useEffect(() => rememberLyricsArtwork(safeArtworkSource), [safeArtworkSource]);
  const sceneBackground = resolvedPreset.scene.background;
  const appearanceMode =
    backgroundMode === 'image' || backgroundMode === 'color'
      ? backgroundMode
      : sceneBackground.source === 'color' ||
          sceneBackground.source === 'gradient' ||
          sceneBackground.source === 'colorField'
        ? 'color'
        : backgroundMode;
  const appearance = resolveLyricsAppearance(
    {
      mode: appearanceMode,
      imageSource: backgroundImageSource,
      imageFit: backgroundFit,
      color:
        appearanceMode === 'color' &&
        sceneBackground.source === 'color' &&
        backgroundMode !== 'color'
          ? sceneBackground.fallbackColor
          : backgroundColor,
    },
    safeArtworkSource,
  );
  const backdropImageSource =
    appearance.mode === 'color'
      ? null
      : appearance.mode === 'image'
        ? appearance.imageSource
        : (safeArtworkSource ?? lyricsArtworkFallback());
  const blurredBackdrop = useBlurredArtwork(sceneBackground.blur > 0 ? backdropImageSource : null);
  useEffect(() => rememberLyricsBlurredBackdrop(blurredBackdrop), [blurredBackdrop]);
  const sceneAppearance = applySceneBackdrop(
    {
      ...appearance,
      imageSource: backdropImageSource,
      imageFit: backgroundFit,
    },
    sceneBackground.blur,
    blurredBackdrop ?? lyricsBlurredBackdropFallback(),
  );
  const activeDocument = document?.songId === currentTrackId ? document : null;
  const stage = useRef<HTMLElement>(null);
  const transportRef = useRef<LyricsFullscreenTransportHandle>(null);

  const timelineDuration = playbackDurationMs ?? currentDurationMs;
  const favoriteLabel = currentTrackId
    ? favoritePending
      ? player('favoritePending', { title: currentTitle })
      : favorite
        ? player('removeFavorite', { title: currentTitle })
        : player('addFavorite', { title: currentTitle })
    : player('favorite');
  const hasWritableProviderReference =
    currentProvider?.providerId === accountProvider?.id &&
    Number.isSafeInteger(currentProvider?.numericId) &&
    (currentProvider?.numericId ?? 0) > 0;
  const favoriteAvailable =
    currentTrackId !== null &&
    accountProvider !== null &&
    (accountSnapshot.state !== 'authenticated' ||
      (accountSnapshot.capabilities.favoriteWrite && hasWritableProviderReference));

  const presentationKey = fullscreen ? 'fullscreen' : 'windowed';
  const [controlsPresentationKey, setControlsPresentationKey] = useState(presentationKey);
  const [controlsHidden, setControlsHidden] = useState(fullscreen);
  if (controlsPresentationKey !== presentationKey) {
    setControlsPresentationKey(presentationKey);
    setControlsHidden(fullscreen);
  }

  useLayoutEffect(() => useLyricsStageStore.getState().registerSurface(), []);

  useEffect(() => {
    const stageElement = stage.current;
    if (!stageElement) return;
    let timer: number | null = null;
    const reveal = () => {
      setControlsHidden(false);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setControlsHidden(true), 2_400);
    };
    const handlePointerMove = (event: PointerEvent) => {
      transportRef.current?.reveal();
      if (!fullscreen || event.clientY <= 56) reveal();
    };
    const handleKeyDown = () => {
      if (fullscreen) reveal();
    };

    if (!fullscreen) timer = window.setTimeout(() => setControlsHidden(true), 2_400);
    stageElement.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      stageElement.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('keydown', handleKeyDown);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [fullscreen]);

  useEffect(() => {
    const stageElement = stage.current;
    if (!stageElement) return;
    const settle = (event: AnimationEvent) => {
      if (event.target !== stageElement) return;
      const raw = stageElement.dataset.stageGeneration;
      const generation = raw === undefined ? undefined : Number(raw);
      useLyricsStageStore
        .getState()
        .notifyTransitionFinished(event.animationName, Number.isFinite(generation) ? generation : undefined);
    };
    stageElement.addEventListener('animationend', settle);
    return () => stageElement.removeEventListener('animationend', settle);
  }, []);

  useEffect(() => {
    const generation = useLyricsStageStore.getState().generation;
    if (stage.current) stage.current.dataset.stageGeneration = String(generation);
    if (stageState !== 'entering' && stageState !== 'exiting') return;
    const animationName =
      stageState === 'entering' ? LYRICS_STAGE_ENTER_ANIMATION : LYRICS_STAGE_EXIT_ANIMATION;
    const timer = window.setTimeout(() => {
      useLyricsStageStore.getState().notifyTransitionFinished(animationName, generation);
    }, LYRICS_STAGE_TRANSITION_MS + 80);
    return () => window.clearTimeout(timer);
  }, [stageState]);

  const style = {
    '--lyrics-font-scale': resolvedPreset.typography.fontScale,
    '--lyrics-line-height': resolvedPreset.typography.lineHeight,
    '--lyrics-line-gap': `${lineGapFromLineHeight(resolvedPreset.typography.lineHeight)}cqh`,
    '--lyrics-stage-base':
      appearance.baseColor ?? resolvedPreset.background.fallbackColor ?? 'var(--bg-opaque)',
    backgroundColor: appearance.baseColor ?? resolvedPreset.background.fallbackColor ?? undefined,
  } as LyricsStyle;

  const lyricsStatus = !currentTrackId
    ? 'idle'
    : status === 'loading'
      ? 'loading'
      : status === 'error'
        ? 'error'
        : !activeDocument || status === 'missing'
          ? 'missing'
          : 'ready';

  const bindings: LyricsSceneBindings = {
    songId: currentTrackId,
    title: currentTitle,
    artistLabel: currentArtistLabel,
    albumTitle: currentAlbumTitle,
    artworkSrc: safeArtworkSource,
    artworkAlt: currentArtworkAlt,
    artworkColor: currentArtworkColor,
    lyrics: activeDocument,
    lyricsStatus,
    isPlaying: usePlayerStore.getState().isPlaying,
    positionMs: getEstimatedPositionMs(),
    durationMs: timelineDuration,
    timelineRevision: usePlayerStore.getState().timelineRevision,
    presentationOffsetMs,
    getPositionMs: getEstimatedPositionMs,
    seek,
    beginScrub,
    previewScrub,
    commitScrub,
    togglePlayback,
    next,
    previous,
    translation,
    romanization,
    wordEffect,
  };

  return (
    <section
      ref={stage}
      className="lyrics-stage"
      style={style}
      aria-label={t('region')}
      data-stage={stageState}
      data-focus={focus || undefined}
      data-fullscreen={fullscreen || undefined}
      data-cover-layout={coverLayout}
      data-background-mode={appearance.mode}
      data-image-fit={appearance.imageFit}
      data-song-id={currentTrackId ?? undefined}
    >
      {fullscreen && (
        <LyricsFullscreenTransport ref={transportRef} artworkSource={safeArtworkSource} />
      )}

      {fullscreenError !== null && (
        <span className="lyrics-stage__fullscreen-status" role="status">
          {t('fullscreenFailed')}
        </span>
      )}

      <LyricsScene
        preset={resolvedPreset}
        bindings={bindings}
        appearance={sceneAppearance}
        mode="runtime"
        transportHidden={fullscreen || controlsHidden}
        layoutKey={`${focus}:${fullscreen}`}
      />

      <div className="lyrics-stage__topbar" data-hidden={controlsHidden || undefined}>
        <IconButton
          label={nextCoverLabel}
          size="large"
          onClick={() => selectLyricsPreset(nextPreset.id)}
        >
          <Image size={18} />
        </IconButton>
      </div>

      <div className="lyrics-stage__chrome" data-hidden={fullscreen || controlsHidden || undefined}>
        <IconButton label={t('collapse')} size="large" onClick={onClose}>
          <ChevronDown size={20} />
        </IconButton>
        <IconButton
          label={favoriteLabel}
          size="large"
          active={favorite}
          disabled={!favoriteAvailable || favoritePending}
          onClick={() => {
            const state = usePlayerStore.getState();
            const track = state.queue[state.currentIndex];
            if (accountProvider && track) {
              void setFavorite(accountProvider, track, !favorite);
            }
          }}
        >
          <Heart size={18} fill={favorite ? 'currentColor' : 'none'} />
        </IconButton>
      </div>
    </section>
  );
}
