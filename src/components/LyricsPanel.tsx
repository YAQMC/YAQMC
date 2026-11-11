import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { ChevronDown, Heart, Image, MessageSquare } from 'lucide-react';
import { CommentsButton } from './CommentsPanel';
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
  lyricsStageResumeElapsedMs,
  prefersReducedMotion,
  useLyricsStageStore,
  type LyricsStageState,
} from '../application/lyrics-stage-machine';
import { noteLyricsPanelCommit } from '../application/lyrics-perf-counters';
import { ProviderContext } from '../application/provider-context';
import { isAccountMusicProvider } from '../providers/music-provider';
import { joinArtistNames } from '../utils/format';
import { IconButton } from './ui/IconButton';
import { ActionMenu } from './ui/ActionMenu';
import { SongShareMenuItems } from './SongShareActions';
import { useTranslation } from 'react-i18next';
import { usePreferencesStore } from '../application/preferences';
import { isAndroidRuntime, supportsWindowControls } from '../application/host-capabilities';
import { useCompactPlayerLayout } from '../application/use-compact-player-layout';
import { useLyricsTransportDefinition } from '../application/use-lyrics-transport';
import { BUILTIN_TRANSPORT_WINDOW_ID } from '../application/lyrics-transport';
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
import { CommentDanmaku } from './CommentDanmaku';
import { sceneForOrientation } from '../application/lyrics-scene-layout';
import { getHostBridge } from '../application/yaqmc-runtime';
import { PluginLyricsActions } from './PluginLyricsActions';
import { LyricsWindowControls } from './LyricsWindowControls';

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
  const compact = useCompactPlayerLayout();
  const windowControls = supportsWindowControls();
  const stage = useRef<HTMLElement>(null);
  const [portrait, setPortrait] = useState(() => window.innerHeight > window.innerWidth);
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const update = () => {
      const bounds = node.getBoundingClientRect();
      const width = node.clientWidth || bounds.width;
      const height = node.clientHeight || bounds.height;
      if (width > 0 && height > 0) setPortrait(height > width);
    };
    update();
    if (typeof ResizeObserver !== 'function') return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  const transportDefinition = useLyricsTransportDefinition(fullscreen ? 'fullscreen' : 'window');
  const floatingTransport = !compact && transportDefinition.id !== BUILTIN_TRANSPORT_WINDOW_ID;
  const { t } = useTranslation('lyrics');
  const commentDanmaku = usePreferencesStore((state) => state.lyrics.commentDanmaku);
  const updateLyrics = usePreferencesStore((state) => state.updateLyrics);
  const { t: player } = useTranslation('player');
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const setFavorite = useAccountStore((state) => state.setFavorite);
  const currentTrack = usePlayerStore((state) => state.queue[state.currentIndex]);
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
  const cancelScrub = usePlayerStore((state) => state.cancelScrub);
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
  const fontWeight = usePreferencesStore((state) => state.lyrics.fontWeight);
  const amll = usePreferencesStore((state) => state.amll);
  // DOM blur/scale are costly on phone WebViews; the Android native renderer honours the settings.
  const webCompactAmll = useMemo(
    () =>
      compact && !isAndroidRuntime() ? { ...amll, enableBlur: false, enableScale: false } : amll,
    [amll, compact],
  );
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
  const activeScene = sceneForOrientation(resolvedPreset, portrait);
  const backgroundFit = activeScene.background.fit;
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
    provider: currentProvider,
  });
  useEffect(() => rememberLyricsArtwork(safeArtworkSource), [safeArtworkSource]);
  const sceneBackground = activeScene.background;
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
    if (compact) return;
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
    const handlePointerDown = (event: PointerEvent) => {
      transportRef.current?.reveal();
      if (!fullscreen || event.pointerType !== 'mouse' || event.clientY <= 56) reveal();
    };
    const handleKeyDown = () => {
      if (fullscreen) reveal();
    };

    if (!fullscreen) timer = window.setTimeout(() => setControlsHidden(true), 2_400);
    stageElement.addEventListener('pointermove', handlePointerMove);
    stageElement.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      stageElement.removeEventListener('pointermove', handlePointerMove);
      stageElement.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [compact, fullscreen]);

  useEffect(() => {
    const stageElement = stage.current;
    if (!stageElement) return;
    const settle = (event: AnimationEvent) => {
      if (event.target !== stageElement) return;
      const raw = stageElement.dataset.stageGeneration;
      const generation = raw === undefined ? undefined : Number(raw);
      useLyricsStageStore
        .getState()
        .notifyTransitionFinished(
          event.animationName,
          Number.isFinite(generation) ? generation : undefined,
        );
    };
    stageElement.addEventListener('animationend', settle);
    return () => stageElement.removeEventListener('animationend', settle);
  }, []);

  // Zustand notifies synchronously, before React commits the new data-stage, so this still
  // sees the interrupted transition's live position.
  const resumeHiddenFraction = useRef<number | null>(null);
  useLayoutEffect(
    () =>
      useLyricsStageStore.subscribe((next, previous) => {
        if (next.stage === previous.stage) return;
        const node = stage.current;
        const moving = previous.stage === 'entering' || previous.stage === 'exiting';
        resumeHiddenFraction.current = node && moving ? stageHiddenFraction(node) : null;
      }),
    [],
  );

  // The parent's requestOpen() runs after this layout effect and bumps the generation without
  // changing stageState, so the generation is an explicit dependency.
  const stageGeneration = useLyricsStageStore((state) => state.generation);
  useLayoutEffect(() => {
    const node = stage.current;
    const generation = stageGeneration;
    if (node) {
      node.dataset.stageGeneration = String(generation);
      delete node.dataset.stageArmed;
      node.style.removeProperty('animation-delay');
    }
    const hiddenFraction = resumeHiddenFraction.current;
    resumeHiddenFraction.current = null;
    if (!node || (stageState !== 'entering' && stageState !== 'exiting')) return;
    const animationName =
      stageState === 'entering' ? LYRICS_STAGE_ENTER_ANIMATION : LYRICS_STAGE_EXIT_ANIMATION;
    const finish = () =>
      useLyricsStageStore.getState().notifyTransitionFinished(animationName, generation);
    if (prefersReducedMotion()) {
      finish();
      return;
    }

    const elapsed = lyricsStageResumeElapsedMs(stageState, hiddenFraction);
    if (elapsed > 0) node.style.setProperty('animation-delay', `-${elapsed}ms`);
    let timer: number | null = null;
    const frames: number[] = [];
    const arm = () => {
      node.dataset.stageArmed = '';
      timer = window.setTimeout(finish, LYRICS_STAGE_TRANSITION_MS - elapsed + 80);
    };
    if (stageState === 'entering' && hiddenFraction === null) {
      // A fresh enter mounts the whole scene. Hold it offscreen for two frames so mount effects,
      // layer promotion and first raster finish before any visible motion starts.
      frames.push(requestAnimationFrame(() => frames.push(requestAnimationFrame(arm))));
    } else {
      arm();
    }
    return () => {
      frames.forEach(cancelAnimationFrame);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [stageGeneration, stageState]);

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
    provider: currentTrack?.provider,
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
    cancelScrub,
    togglePlayback,
    next,
    previous,
    translation,
    romanization,
    wordEffect,
    fontWeight,
    amll: webCompactAmll,
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
      {!fullscreen && getHostBridge().kind === 'electron' && (
        <div className="lyrics-stage__drag-region yaqmc-drag" aria-hidden="true" />
      )}
      {floatingTransport && (
        <LyricsFullscreenTransport
          ref={transportRef}
          artworkSource={safeArtworkSource}
          surface={fullscreen ? 'fullscreen' : 'window'}
        />
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
        compact={compact}
        transportSurface={fullscreen ? 'fullscreen' : 'window'}
        transportHidden={false}
        hideTransportWidget={floatingTransport}
        layoutKey={`${focus}:${fullscreen}`}
      />
      <CommentDanmaku key={currentTrackId} document={document} />

      <div className="lyrics-stage__hover-controls yaqmc-no-drag">
        <IconButton
          label={nextCoverLabel}
          size="small"
          onClick={() => selectLyricsPreset(nextPreset.id)}
        >
          <Image size={18} />
        </IconButton>
        <LyricsWindowControls />
      </div>
      <div
        className="lyrics-stage__topbar"
        data-window-controls={windowControls || undefined}
        data-hidden={(!compact && controlsHidden) || undefined}
      >
        <PluginLyricsActions includeWindowActions={!windowControls} />
      </div>

      <div
        className="lyrics-stage__chrome"
        data-hidden={(!compact && (fullscreen || controlsHidden)) || undefined}
      >
        <IconButton label={t('collapse')} size="large" onClick={onClose}>
          <ChevronDown size={20} />
        </IconButton>
        <CommentsButton song={currentTrack ?? null} size="large" />
        <IconButton
          label={t('comments.toggleDanmaku')}
          active={commentDanmaku}
          size="large"
          onClick={() => updateLyrics({ commentDanmaku: !commentDanmaku })}
        >
          <MessageSquare size={18} />
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
        {currentTrack && (
          <ActionMenu label={player('moreActions', { title: currentTrack.title })} size="large">
            <SongShareMenuItems song={currentTrack} />
          </ActionMenu>
        )}
      </div>
    </section>
  );
}

function stageHiddenFraction(node: HTMLElement): number | null {
  const height = node.offsetHeight;
  if (height <= 0) return null;
  const transform = getComputedStyle(node).transform;
  if (!transform || transform === 'none') return 0;
  try {
    return Math.min(1, Math.max(0, new DOMMatrixReadOnly(transform).m42 / height));
  } catch {
    return null;
  }
}
