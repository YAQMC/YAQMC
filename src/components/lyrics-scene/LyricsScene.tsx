import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
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
  '--lyrics-font-scale': string;
  '--lyrics-font-size': string;
  '--lyrics-secondary-font-size': string;
  '--lyrics-line-height': string;
  '--lyrics-line-gap': string;
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
  const [sceneHeight, setSceneHeight] = useState(0);
  const ink = coverInk(bindings.artworkColor);
  const editor = mode === 'editor';
  const scene = preset.scene;
  const progress =
    bindings.durationMs === 0 ? 0 : (bindings.positionMs / Math.max(bindings.durationMs, 1)) * 100;
  const primaryFontPx = resolvePrimaryFontSizePx(preset.typography.fontScale, sceneHeight);
  const secondaryFontPx = resolveSecondaryFontSizePx(primaryFontPx);

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
            opacity: scene.background.opacity,
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
          onSelect={(id) => onSelectWidget?.(id)}
          onEditorDragStart={onEditorDragStart}
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
                  onPointerDown={() => bindings.beginScrub?.()}
                  onPointerUp={(event) =>
                    (bindings.commitScrub ?? bindings.seek)(Number(event.currentTarget.value))
                  }
                  onPointerCancel={(event) =>
                    (bindings.commitScrub ?? bindings.seek)(Number(event.currentTarget.value))
                  }
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (event.buttons > 0 && bindings.previewScrub) bindings.previewScrub(next);
                    else bindings.seek(next);
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
