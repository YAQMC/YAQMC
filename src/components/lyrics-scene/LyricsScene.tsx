import { useEffect, useRef, type CSSProperties } from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  lineGapFromLineHeight,
  resolvePrimaryFontSizePx,
  resolveSecondaryFontSizePx,
  type SceneWidgetId,
} from '../../application/lyrics-preset';
import { widgetBoxStyle } from '../../application/lyrics-scene-geometry';
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
  '--lyrics-font-scale': number;
  '--lyrics-font-size': string;
  '--lyrics-secondary-font-size': string;
  '--lyrics-line-height': number;
  '--lyrics-line-gap': string;
  '--artwork-influence': string;
};

function applyTypography(node: HTMLElement, fontScale: number): void {
  const height = node.clientHeight || node.getBoundingClientRect().height;
  const primary = resolvePrimaryFontSizePx(fontScale, height);
  node.style.setProperty('--lyrics-font-size', `${primary}px`);
  node.style.setProperty(
    '--lyrics-secondary-font-size',
    `${resolveSecondaryFontSizePx(primary)}px`,
  );
}

function SceneWidget({
  id,
  selected,
  editor,
  style,
  onSelect,
  children,
}: {
  id: SceneWidgetId;
  selected: boolean;
  editor: boolean;
  style: CSSProperties;
  onSelect?: (id: SceneWidgetId) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="lyrics-scene__widget"
      data-widget={id}
      data-selected={selected || undefined}
      data-editor={editor || undefined}
      style={style}
      onPointerDown={() => {
        if (!editor || !onSelect) return;
        onSelect(id);
      }}
    >
      {children}
    </div>
  );
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
  transportHidden = false,
  layoutKey,
}: LyricsSceneProps & { transportHidden?: boolean; layoutKey?: string }) {
  const { t: player } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const { t: settings } = useTranslation('settings', { keyPrefix: 'lyricsPresets' });
  const root = useRef<HTMLDivElement>(null);
  const ink = coverInk(bindings.artworkColor);
  const editor = mode === 'editor';
  const scene = preset.scene;
  const progress =
    bindings.durationMs === 0 ? 0 : (bindings.positionMs / Math.max(bindings.durationMs, 1)) * 100;

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const update = () => applyTypography(node, preset.typography.fontScale);
    update();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [preset.typography.fontScale]);

  const style = {
    '--lyrics-color': bindings.artworkColor,
    '--lyrics-ink': ink.ink,
    '--lyrics-ink-contrast': ink.contrast,
    '--lyrics-stage-base': appearance.baseColor ?? scene.background.fallbackColor,
    '--lyrics-font-scale': preset.typography.fontScale,
    '--lyrics-font-size': `calc(clamp(18px, 5.6cqh, 96px) * ${preset.typography.fontScale})`,
    '--lyrics-secondary-font-size': `calc(var(--lyrics-font-size) * 0.42)`,
    '--lyrics-line-height': preset.typography.lineHeight,
    '--lyrics-line-gap': `${lineGapFromLineHeight(preset.typography.lineHeight)}em`,
    '--artwork-influence': String(scene.background.influence),
    backgroundColor: appearance.baseColor ?? scene.background.fallbackColor,
  } as SceneStyle;

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
      {scene.background.visible && appearance.imageSource && (
        <div
          className="lyrics-stage__backdrop"
          data-widget="background"
          data-selected={selectedWidgetId === 'background' || undefined}
          style={{
            backgroundImage: `url("${appearance.imageSource}")`,
            backgroundSize: appearance.imageFit,
            opacity: scene.background.opacity * scene.background.influence,
            filter: scene.background.blur > 0 ? `blur(${scene.background.blur}px)` : undefined,
            transform: scene.background.blur > 0 ? 'scale(1.5)' : undefined,
          }}
          aria-hidden="true"
        />
      )}
      {scene.background.visible && <div className="lyrics-stage__wash" aria-hidden="true" />}

      {scene.artwork.visible && (
        <SceneWidget
          id="artwork"
          editor={editor}
          selected={selectedWidgetId === 'artwork'}
          onSelect={onSelectWidget}
          style={widgetBoxStyle(scene.artwork)}
        >
          {scene.artwork.renderer === 'vinyl' ? (
            <div
              className="lyrics-stage__disc"
              data-playing={bindings.isPlaying || undefined}
              style={{ opacity: scene.artwork.opacity }}
            >
              {bindings.artworkSrc && (
                <img
                  className="lyrics-stage__disc-cover"
                  src={bindings.artworkSrc}
                  alt={bindings.artworkAlt}
                  draggable={false}
                />
              )}
            </div>
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
          onSelect={onSelectWidget}
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
          onSelect={onSelectWidget}
          style={widgetBoxStyle(scene.lyrics)}
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
            followAnchor={scene.lyrics.followAnchor}
            align={scene.lyrics.align}
            songId={bindings.songId}
            editorGesture={editorGesture}
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
          onSelect={onSelectWidget}
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
                <button
                  type="button"
                  className="lyrics-stage__play"
                  onClick={bindings.togglePlayback}
                  aria-label={bindings.isPlaying ? common('pause') : common('play')}
                >
                  {bindings.isPlaying ? (
                    <Pause size={20} fill="currentColor" />
                  ) : (
                    <Play size={20} fill="currentColor" />
                  )}
                </button>
                <IconButton label={player('next')} size="large" onClick={() => bindings.next?.()}>
                  <SkipForward size={18} fill="currentColor" />
                </IconButton>
              </div>
              <div className="lyrics-stage__progress">
                <span>{formatDuration(bindings.positionMs)}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(bindings.durationMs, 1)}
                  step={1_000}
                  value={bindings.positionMs}
                  onChange={(event) => bindings.seek(Number(event.target.value))}
                  aria-label={player('position')}
                  style={{ '--range-progress': `${progress}%` } as CSSProperties}
                />
                <span>{formatDuration(bindings.durationMs)}</span>
              </div>
            </div>
          </div>
        </SceneWidget>
      )}

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
