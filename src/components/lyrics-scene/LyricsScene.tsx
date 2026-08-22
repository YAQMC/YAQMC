import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  colorFieldEmitterColor,
  resolveArtworkPalette,
  type ArtworkPalette,
} from '../../application/artwork-color';
import {
  lineGapFromLineHeight,
  listExtraSceneWidgets,
  resolvePrimaryFontSizePx,
  resolveSceneTextBinding,
  resolveSecondaryFontSizePx,
  type ExtraSceneWidget,
  type SceneWidgetId,
} from '../../application/lyrics-preset';
import { resolveSceneAssetUrl } from '../../application/plugin-asset';
import { linuxSkipsLiveVideo, skipsLiveCssBlur } from '../../application/platform-integration';
import {
  currentPluginSceneInstance,
  pluginSceneCssVars,
  pluginSceneDataState,
  pluginSceneWidgetOverrides,
  subscribePluginSceneState,
} from '../../application/plugin-runtime';
import { widgetBoxStyle } from '../../application/lyrics-scene-geometry';
import { usePlayerStore } from '../../application/player-store';
import { formatDuration } from '../../utils/format';
import { IconButton } from '../ui/IconButton';
import { coverInk } from './coverInk';
import { LyricsViewport } from './LyricsViewport';
import type { LyricsSceneProps } from './types';

type SceneStyle = CSSProperties & {
  '--lyrics-color': string;
  '--lyrics-ink': string;
  '--lyrics-ink-contrast': string;
  '--lyrics-stage-base': string;
  '--lyrics-font-scale': string;
  '--lyrics-font-size': string;
  '--lyrics-secondary-font-size': string;
  '--lyrics-line-height': string;
  '--lyrics-line-gap': string;
  '--scene-progress': string;
  '--scene-duration': string;
  '--scene-artwork-primary': string;
  '--scene-artwork-secondary': string;
  '--scene-accent': string;
  '--scene-font-scale': string;
};

function cssPx(value: number): string {
  return `${Number(value.toFixed(2))}px`;
}

function readSceneHeightPx(node: HTMLElement): number {
  return node.clientHeight || node.getBoundingClientRect().height || 0;
}

function SceneWidget({
  id,
  selected,
  editor,
  style,
  onSelect,
  onEditorDragStart,
  children,
}: {
  id: SceneWidgetId;
  selected: boolean;
  editor: boolean;
  style: CSSProperties;
  onSelect?: (id: SceneWidgetId) => void;
  onEditorDragStart?: (id: SceneWidgetId, event: ReactPointerEvent<HTMLElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="lyrics-scene__widget"
      data-widget={id}
      data-scene-widget={id}
      data-scene-widget-id={id}
      data-scene-widget-type={id}
      data-scene-state={selected ? 'active' : 'inactive'}
      data-selected={selected || undefined}
      data-editor={editor || undefined}
      onPointerDown={(event) => {
        if (!editor) return;
        onSelect?.(id);
        if (event.target instanceof Element && event.target.closest('[data-editor-interactive]')) {
          return;
        }
        onEditorDragStart?.(id, event);
      }}
      style={style}
    >
      {editor && (
        <div
          className="lyrics-scene__hit"
          data-editor-hit=""
          aria-hidden="true"
          onWheel={(event) => {
            const scroll =
              event.currentTarget.parentElement?.querySelector('.lyrics-stage__scroll');
            if (!(scroll instanceof HTMLElement) || (event.deltaY === 0 && event.deltaX === 0)) {
              return;
            }
            scroll.dispatchEvent(
              new WheelEvent('wheel', {
                deltaX: event.deltaX,
                deltaY: event.deltaY,
                bubbles: true,
                cancelable: true,
              }),
            );
          }}
        />
      )}
      {children}
    </div>
  );
}

function VinylDisc({
  artworkSrc,
  artworkAlt,
  opacity,
  isPlaying: isPlayingProp,
}: {
  artworkSrc: string | null;
  artworkAlt: string;
  opacity: number;
  isPlaying?: boolean;
}) {
  const storePlaying = usePlayerStore((state) => state.isPlaying);
  const isPlaying = isPlayingProp ?? storePlaying;
  return (
    <div className="lyrics-stage__disc" data-scene-widget="vinyl" style={{ opacity }}>
      <div className="lyrics-stage__disc-spin" data-playing={isPlaying || undefined}>
        {artworkSrc && (
          <img
            className="lyrics-stage__disc-cover"
            src={artworkSrc}
            alt={artworkAlt}
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}

function ScenePlayButton({
  isPlaying: isPlayingProp,
  onToggle,
  playingLabel,
  pausedLabel,
}: {
  isPlaying?: boolean;
  onToggle: () => void;
  playingLabel: string;
  pausedLabel: string;
}) {
  const storePlaying = usePlayerStore((state) => state.isPlaying);
  const isPlaying = isPlayingProp ?? storePlaying;
  return (
    <button
      type="button"
      className="lyrics-stage__play"
      onClick={onToggle}
      aria-label={isPlaying ? playingLabel : pausedLabel}
    >
      {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
    </button>
  );
}

function ScenePlaybackState({ editor, isPlaying }: { editor: boolean; isPlaying: boolean }) {
  const storePlaying = usePlayerStore((state) => state.isPlaying);
  const marker = useRef<HTMLSpanElement>(null);
  const playing = editor ? isPlaying : storePlaying;
  useLayoutEffect(() => {
    const scene = marker.current?.closest('.lyrics-scene');
    if (scene instanceof HTMLElement) {
      scene.dataset.playbackState = playing ? 'playing' : 'paused';
    }
  }, [playing]);
  return <span ref={marker} hidden data-scene-playback="" />;
}

export function LyricsScene({
  preset,
  bindings,
  appearance,
  mode,
  selectedWidgetId = null,
  onSelectWidget,
  editorGesture = false,
  guides = [],
  className,
  previewFrame,
  fallbackNotice,
  onFollowStateChange,
  onEditorDragStart,
  transportHidden = false,
  layoutKey,
}: LyricsSceneProps & { transportHidden?: boolean; layoutKey?: string }) {
  const { t: player } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const { t: settings } = useTranslation('settings', { keyPrefix: 'lyricsPresets' });
  const root = useRef<HTMLDivElement>(null);
  const transportScrubbing = useRef(false);
  const transportInput = useRef<HTMLInputElement>(null);
  const transportElapsed = useRef<HTMLSpanElement>(null);
  const [sceneHeight, setSceneHeight] = useState(0);
  const [palette, setPalette] = useState<ArtworkPalette | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [extraUrls, setExtraUrls] = useState<Record<string, string>>({});
  const [videoFailed, setVideoFailed] = useState(false);
  const [pluginVars, setPluginVars] = useState(pluginSceneCssVars());
  const [pluginState, setPluginState] = useState(pluginSceneDataState());
  const editor = mode === 'editor';
  const runtimePlaying = usePlayerStore((state) => state.isPlaying);
  const runtimeScrubbing = usePlayerStore((state) => state.isScrubbing);
  const runtimeTimelineRevision = usePlayerStore((state) => state.timelineRevision);
  const scene = preset.scene;
  const [transportDraft, setTransportDraft] = useState<number | null>(null);
  const transportPositionMs =
    transportDraft ?? (editor ? bindings.positionMs : bindings.getPositionMs());
  const progress =
    bindings.durationMs === 0 ? 0 : (transportPositionMs / Math.max(bindings.durationMs, 1)) * 100;
  const primaryFontPx = resolvePrimaryFontSizePx(preset.typography.fontScale, sceneHeight);
  const secondaryFontPx = resolveSecondaryFontSizePx(primaryFontPx);
  // A user-selected solid background is the actual lyric backdrop; otherwise
  // the artwork palette is the best stable proxy before image pixels are drawn.
  const ink = coverInk(appearance.baseColor ?? palette?.primary ?? bindings.artworkColor);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const update = () => {
      const next = readSceneHeightPx(node);
      setSceneHeight((current) => (current === next ? current : next));
    };
    update();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [previewFrame, layoutKey]);

  useEffect(
    () =>
      subscribePluginSceneState(() => {
        setPluginVars({ ...pluginSceneCssVars() });
        setPluginState(pluginSceneDataState());
      }),
    [],
  );

  useEffect(() => {
    const identity = bindings.songId ?? bindings.artworkSrc ?? 'none';
    const generation = Date.now();
    let cancelled = false;
    void resolveArtworkPalette(
      identity,
      bindings.artworkSrc,
      bindings.artworkColor,
      generation,
    ).then((next) => {
      if (!cancelled) setPalette(next);
    });
    return () => {
      cancelled = true;
    };
  }, [bindings.songId, bindings.artworkSrc, bindings.artworkColor]);

  useEffect(() => {
    let cancelled = false;
    const pluginId = preset.pluginId;
    void resolveSceneAssetUrl(scene.background.media, pluginId).then((url) => {
      if (!cancelled) {
        setMediaUrl(url);
        setVideoFailed(false);
      }
    });
    const extras = listExtraSceneWidgets(scene);
    void Promise.all(
      extras.map(async (widget) => {
        const url = await resolveSceneAssetUrl(widget.asset, pluginId);
        return [widget.id, url] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [id, url] of entries) {
        if (url) next[id] = url;
      }
      setExtraUrls(next);
    });
    return () => {
      cancelled = true;
    };
  }, [preset.pluginId, scene]);

  useEffect(() => {
    if (editor || !runtimePlaying || runtimeScrubbing) return;
    let frame = 0;
    let lastLabel = '';
    const durationMs = Math.max(bindings.durationMs, 1);
    const tick = () => {
      if (!transportScrubbing.current) {
        const positionMs = Math.max(0, Math.min(bindings.getPositionMs(), durationMs));
        const progress = (positionMs / durationMs) * 100;
        const input = transportInput.current;
        if (input && document.documentElement.dataset.compositorProbe !== 'no-progress-raf') {
          input.value = String(positionMs);
          input.style.setProperty('--range-progress', `${progress}%`);
        }
        const label = formatDuration(positionMs);
        if (transportElapsed.current && label !== lastLabel) {
          transportElapsed.current.textContent = label;
          lastLabel = label;
        }
        root.current?.style.setProperty('--scene-progress', String(progress / 100));
      }
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [
    bindings.durationMs,
    bindings.getPositionMs,
    editor,
    runtimePlaying,
    runtimeScrubbing,
    runtimeTimelineRevision,
  ]);

  const style = {
    '--lyrics-color': bindings.artworkColor,
    '--lyrics-ink': ink.ink,
    '--lyrics-ink-contrast': ink.contrast,
    '--lyrics-stage-base': appearance.baseColor ?? scene.background.fallbackColor,
    '--lyrics-font-scale': String(preset.typography.fontScale),
    '--lyrics-font-size': cssPx(primaryFontPx),
    '--lyrics-secondary-font-size': cssPx(secondaryFontPx),
    '--lyrics-line-height': String(preset.typography.lineHeight),
    '--lyrics-line-gap': `${lineGapFromLineHeight(preset.typography.lineHeight)}cqh`,
    '--scene-progress': String(Math.max(0, Math.min(1, progress / 100))),
    '--scene-duration': String(bindings.durationMs),
    '--scene-artwork-primary': palette?.primary ?? bindings.artworkColor,
    '--scene-artwork-secondary': palette?.secondary ?? bindings.artworkColor,
    '--scene-accent': palette?.secondary ?? bindings.artworkColor,
    '--scene-font-scale': String(preset.typography.fontScale),
    ...Object.fromEntries(
      Object.entries(pluginVars).map(([name, value]) => [`--scene-${name}`, value]),
    ),
    backgroundColor: appearance.baseColor ?? scene.background.fallbackColor,
  } as SceneStyle;

  const pluginSceneKey = preset.pluginId
    ? `${preset.pluginId}/${preset.id.replace(`plugin:${preset.pluginId}:`, '')}`
    : undefined;
  const instance = currentPluginSceneInstance();
  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const skipVideo = reducedMotion || linuxSkipsLiveVideo();
  const extras = listExtraSceneWidgets(scene);
  const overrides = pluginSceneWidgetOverrides();

  const artworkRadius =
    scene.artwork.renderer === 'rounded'
      ? `${Math.round(scene.artwork.radius * 50)}%`
      : scene.artwork.renderer === 'square'
        ? `${Math.round(scene.artwork.radius * 36)}px`
        : undefined;

  return (
    <div
      ref={root}
      className={['lyrics-scene', editor ? 'lyrics-preset-preview' : '', className]
        .filter(Boolean)
        .join(' ')}
      data-lyrics-scene="v1"
      data-yaqmc-plugin-scene={pluginSceneKey ?? preset.pluginId}
      data-scene-instance={instance.id || undefined}
      data-scene-plugin-state={pluginState || undefined}
      data-playback-state={editor ? (bindings.isPlaying ? 'playing' : 'paused') : undefined}
      data-mode={mode}
      data-cover-layout={preset.layout}
      data-background-mode={appearance.mode}
      data-image-fit={appearance.imageFit}
      data-preview-frame={previewFrame}
      data-song-id={bindings.songId ?? undefined}
      style={style}
      onPointerDown={(event) => {
        if (!editor || !onSelectWidget) return;
        const widget = (event.target as HTMLElement | null)?.closest?.('[data-widget]');
        if (!widget) onSelectWidget(null);
      }}
    >
      {!editor && <ScenePlaybackState editor={false} isPlaying={bindings.isPlaying} />}
      {scene.background.visible &&
        appearance.imageSource &&
        scene.background.source !== 'video' && (
          <div
            className="lyrics-stage__backdrop"
            data-widget="background"
            data-scene-widget="background"
            data-scene-widget-id="background"
            data-scene-widget-type="background"
            data-selected={selectedWidgetId === 'background' || undefined}
            style={{
              backgroundImage: `url("${appearance.imageSource}")`,
              backgroundSize: appearance.imageFit,
              opacity: scene.background.opacity,
            }}
            aria-hidden="true"
          />
        )}
      {scene.background.visible &&
        scene.background.source === 'gradient' &&
        scene.background.gradient && (
          <div
            className="lyrics-scene__gradient"
            aria-hidden="true"
            style={{
              background: `linear-gradient(${scene.background.gradient.angle}deg, ${scene.background.gradient.from}, ${scene.background.gradient.to})`,
              opacity: scene.background.opacity,
            }}
          />
        )}
      {scene.background.visible &&
        scene.background.source === 'video' &&
        mediaUrl &&
        !videoFailed &&
        !skipVideo && (
          <video
            className="lyrics-scene__video"
            src={mediaUrl}
            muted
            loop
            playsInline
            autoPlay
            aria-hidden="true"
            onError={() => setVideoFailed(true)}
            style={{
              objectFit: scene.background.fit,
              opacity: scene.background.opacity,
            }}
          />
        )}
      {scene.background.visible &&
        (scene.background.source === 'colorField' || scene.background.colorField) && (
          <div className="lyrics-scene__color-field" aria-hidden="true">
            {(scene.background.colorField?.emitters ?? []).map((emitter) => (
              <span
                key={emitter.id}
                className="lyrics-scene__color-emitter"
                data-position={emitter.position}
                style={{
                  background: `radial-gradient(circle at center, ${colorFieldEmitterColor(emitter, palette)} 0%, transparent ${Math.round(emitter.falloff * 100)}%)`,
                  opacity: emitter.intensity,
                  width: `${Math.round(emitter.radius * 140)}%`,
                  height: `${Math.round(emitter.radius * 140)}%`,
                }}
              />
            ))}
          </div>
        )}
      {scene.background.visible && <div className="lyrics-stage__wash" aria-hidden="true" />}

      {scene.artwork.visible && (
        <SceneWidget
          id="artwork"
          editor={editor}
          selected={selectedWidgetId === 'artwork'}
          onSelect={(id) => onSelectWidget?.(id)}
          onEditorDragStart={onEditorDragStart}
          style={widgetBoxStyle(scene.artwork)}
        >
          {scene.artwork.renderer === 'vinyl' ? (
            <VinylDisc
              artworkSrc={bindings.artworkSrc}
              artworkAlt={bindings.artworkAlt}
              opacity={scene.artwork.opacity}
              isPlaying={editor ? bindings.isPlaying : undefined}
            />
          ) : bindings.artworkSrc ? (
            <img
              className="lyrics-stage__control-panel__artwork"
              src={bindings.artworkSrc}
              alt={bindings.artworkAlt}
              draggable={false}
              style={{
                opacity: scene.artwork.opacity,
                borderRadius: artworkRadius,
              }}
            />
          ) : (
            <span
              className="lyrics-stage__artwork-placeholder lyrics-stage__control-panel__artwork"
              aria-hidden="true"
            />
          )}
        </SceneWidget>
      )}

      {scene.metadata.visible && (
        <SceneWidget
          id="metadata"
          editor={editor}
          selected={selectedWidgetId === 'metadata'}
          onSelect={(id) => onSelectWidget?.(id)}
          onEditorDragStart={onEditorDragStart}
          style={{ ...widgetBoxStyle(scene.metadata), textAlign: scene.metadata.align }}
        >
          <div className="lyrics-scene__metadata" data-align={scene.metadata.align}>
            <strong style={{ fontSize: `${scene.metadata.titleScale}em` }}>{bindings.title}</strong>
            <span style={{ fontSize: `${scene.metadata.artistScale}em` }}>
              {bindings.artistLabel}
            </span>
          </div>
        </SceneWidget>
      )}

      {scene.lyrics.visible && (
        <SceneWidget
          id="lyrics"
          editor={editor}
          selected={selectedWidgetId === 'lyrics'}
          onSelect={(id) => onSelectWidget?.(id)}
          onEditorDragStart={onEditorDragStart}
          style={{ ...widgetBoxStyle(scene.lyrics), fontSize: cssPx(primaryFontPx) }}
        >
          <LyricsViewport
            document={bindings.lyrics}
            status={bindings.songId ? bindings.lyricsStatus : 'idle'}
            isPlaying={bindings.isPlaying}
            timelineRevision={bindings.timelineRevision}
            presentationOffsetMs={bindings.presentationOffsetMs}
            getPositionMs={bindings.getPositionMs}
            seek={bindings.seek}
            translation={bindings.translation}
            romanization={bindings.romanization}
            wordEffect={bindings.wordEffect}
            followAnchor={scene.lyrics.followAnchor}
            align={scene.lyrics.align}
            songId={bindings.songId}
            editorGesture={editorGesture}
            allowSeek={!editor}
            onFollowStateChange={onFollowStateChange}
            layoutKey={layoutKey}
          />
        </SceneWidget>
      )}

      {scene.transport.visible && (
        <SceneWidget
          id="transport"
          editor={editor}
          selected={selectedWidgetId === 'transport'}
          onSelect={(id) => onSelectWidget?.(id)}
          onEditorDragStart={onEditorDragStart}
          style={widgetBoxStyle(scene.transport)}
        >
          <div
            className="lyrics-stage__controls lyrics-scene__transport"
            data-hidden={transportHidden || undefined}
            data-align={scene.transport.align}
          >
            <div className="lyrics-stage__controls-center">
              <div className="lyrics-stage__control-buttons">
                <IconButton
                  label={player('previous')}
                  size="large"
                  onClick={() => bindings.previous?.()}
                >
                  <SkipBack size={18} fill="currentColor" />
                </IconButton>
                <ScenePlayButton
                  isPlaying={editor ? bindings.isPlaying : undefined}
                  onToggle={bindings.togglePlayback}
                  playingLabel={common('pause')}
                  pausedLabel={common('play')}
                />
                <IconButton label={player('next')} size="large" onClick={() => bindings.next?.()}>
                  <SkipForward size={18} fill="currentColor" />
                </IconButton>
              </div>
              <div className="lyrics-stage__progress">
                <span ref={transportElapsed}>{formatDuration(transportPositionMs)}</span>
                <input
                  ref={transportInput}
                  type="range"
                  min={0}
                  max={Math.max(bindings.durationMs, 1)}
                  step={1}
                  value={transportPositionMs}
                  onPointerDown={(event) => {
                    transportScrubbing.current = true;
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // Synthetic pointer events and some embedded surfaces are not capturable.
                    }
                    bindings.beginScrub?.();
                  }}
                  onPointerUp={(event) => {
                    transportScrubbing.current = false;
                    setTransportDraft(null);
                    (bindings.commitScrub ?? bindings.seek)(Number(event.currentTarget.value));
                  }}
                  onPointerCancel={(event) => {
                    transportScrubbing.current = false;
                    setTransportDraft(null);
                    (bindings.commitScrub ?? bindings.seek)(Number(event.currentTarget.value));
                  }}
                  onKeyDown={() => {
                    transportScrubbing.current = true;
                    bindings.beginScrub?.();
                  }}
                  onKeyUp={(event) => {
                    transportScrubbing.current = false;
                    setTransportDraft(null);
                    (bindings.commitScrub ?? bindings.seek)(Number(event.currentTarget.value));
                  }}
                  onChange={(event) => {
                    if (!transportScrubbing.current) return;
                    const next = Number(event.target.value);
                    setTransportDraft(next);
                    bindings.previewScrub?.(next);
                  }}
                  onInput={(event) => {
                    if (!transportScrubbing.current) return;
                    const next = Number(event.currentTarget.value);
                    setTransportDraft(next);
                    bindings.previewScrub?.(next);
                  }}
                  aria-label={player('position')}
                  style={{ '--range-progress': `${progress}%` } as CSSProperties}
                />
                <span>{formatDuration(bindings.durationMs)}</span>
              </div>
            </div>
          </div>
        </SceneWidget>
      )}

      {extras.map((widget) => (
        <ExtraWidget
          key={widget.id}
          widget={widget}
          url={extraUrls[widget.id] ?? (widget.source === 'artwork' ? bindings.artworkSrc : null)}
          override={overrides.get(widget.id)}
          bindings={bindings}
          skipVideo={skipVideo}
          skipLiveBlur={skipsLiveCssBlur()}
        />
      ))}

      {editor && <div className="lyrics-scene__safe" aria-hidden="true" />}
      {editor &&
        guides.map((guide) => (
          <div
            key={`${guide.axis}-${guide.position}`}
            className="lyrics-scene__guide"
            data-axis={guide.axis}
            style={
              guide.axis === 'x'
                ? { left: `${guide.position * 100}%` }
                : { top: `${guide.position * 100}%` }
            }
          />
        ))}

      {fallbackNotice && (
        <span className="lyrics-scene__fallback" role="status">
          {settings('offlinePreview')}
        </span>
      )}
    </div>
  );
}

export type { LyricsSceneProps } from './types';

function ExtraWidget({
  widget,
  url,
  override,
  bindings,
  skipVideo,
  skipLiveBlur,
}: {
  widget: ExtraSceneWidget;
  url: string | null | undefined;
  override?: Record<string, string>;
  bindings: LyricsSceneProps['bindings'];
  skipVideo: boolean;
  skipLiveBlur: boolean;
}) {
  const text =
    resolveSceneTextBinding(widget.bind, {
      title: bindings.title,
      artist: bindings.artistLabel,
      album: bindings.albumTitle ?? '',
      positionMs: bindings.positionMs,
      durationMs: bindings.durationMs,
    }) ??
    widget.text ??
    '';
  const opacity = override?.opacity ? Number(override.opacity) : (widget.opacity ?? 1);
  const style: CSSProperties = {
    ...widgetBoxStyle(widget),
    opacity: Number.isFinite(opacity) ? opacity : 1,
    transform:
      [
        override?.scale ? `scale(${override.scale})` : '',
        override?.rotation ? `rotate(${override.rotation}deg)` : '',
      ]
        .filter(Boolean)
        .join(' ') || undefined,
    filter: skipLiveBlur || !override?.blur ? undefined : `blur(${override.blur}px)`,
    textAlign: widget.align,
  };
  return (
    <div
      className="lyrics-scene__widget lyrics-scene__extra"
      data-scene-widget={widget.kind}
      data-scene-widget-id={widget.id}
      data-scene-widget-type={widget.kind}
      data-scene-state="inactive"
      style={style}
    >
      {widget.kind === 'text' && <span className="lyrics-scene__text">{text}</span>}
      {widget.kind === 'image' && url && (
        <img src={url} alt="" draggable={false} style={{ objectFit: widget.fit ?? 'cover' }} />
      )}
      {widget.kind === 'video' && url && !skipVideo && (
        <video src={url} muted loop playsInline autoPlay aria-hidden="true" />
      )}
    </div>
  );
}
