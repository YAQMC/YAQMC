import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play } from 'lucide-react';
import {
  applyOverride,
  clampFontScale,
  clampLineHeight,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  hasBuiltinOverride,
  isBuiltinPresetId,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  listResolvedPresets,
  patchFromDefinition,
  resetOverride,
  resetSceneWidget,
  resetSceneWidgetPosition,
  resolveLyricsPreset,
  saveAsNewPreset,
  SCENE_WIDGET_IDS,
  updateSceneWidget,
  WIDGET_ANCHORS,
  type LyricsAlign,
  type LyricsArtworkRenderer,
  type LyricsBackgroundFit,
  type LyricsBackgroundKind,
  type LyricsPresetDefinition,
  type LyricsPreviewFrame,
  type SceneWidgetId,
  type WidgetAnchor,
  type WidgetTransform,
} from '../application/lyrics-preset';
import {
  clonePresetDraft,
  presetsEqualForHistory,
  pushComposerHistory,
} from '../application/lyrics-composer';
import {
  placeWidget,
  snapWidgetPosition,
  widgetBoxStyle,
  widgetEdges,
} from '../application/lyrics-scene-geometry';
import { resolveLyricsAppearance } from '../application/lyrics-appearance';
import { useSafeArtworkSource } from '../application/artwork-source';
import { logger } from '../application/logger';
import { useLyricsPresetPreviewStore } from '../application/lyrics-preset-preview';
import { hydrateLyricsPresetPreview } from '../application/lyrics-preset-preview-hydrate';
import { usePreferencesStore } from '../application/preferences';
import { ProviderContext } from '../application/provider-context';
import { joinArtistNames } from '../utils/format';
import { LyricsScene } from './lyrics-scene';
import type { LyricsSceneBindings } from './lyrics-scene';

const PREVIEW_FRAMES: LyricsPreviewFrame[] = ['desktop', 'window'];
const PRESET_NAME_KEYS = ['classic', 'immersive', 'vinyl', 'custom'] as const;
const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type ResizeHandle = (typeof RESIZE_HANDLES)[number];
type PresetNameKey = (typeof PRESET_NAME_KEYS)[number];

function isPresetNameKey(value: string): value is PresetNameKey {
  return (PRESET_NAME_KEYS as readonly string[]).includes(value);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('button, input, textarea, select, a, [data-no-drag]'))
  );
}

function ComposerRange({
  value,
  min,
  max,
  step,
  label,
  output,
  onChange,
  onGestureStart,
  onGestureEnd,
  onReset,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  output: string;
  onChange: (value: number) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onReset?: () => void;
}) {
  const progress = ((value - min) / Math.max(max - min, 0.0001)) * 100;
  return (
    <label className="settings-range">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        onPointerDown={onGestureStart}
        onPointerUp={onGestureEnd}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
        style={{ '--range-progress': `${progress}%` } as CSSProperties}
      />
      <output onDoubleClick={onReset}>{output}</output>
    </label>
  );
}

function applyResize(
  start: WidgetTransform,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): WidgetTransform {
  const edges = widgetEdges(start);
  if (handle.includes('e')) edges.right += dx;
  if (handle.includes('w')) edges.left += dx;
  if (handle.includes('s')) edges.bottom += dy;
  if (handle.includes('n')) edges.top += dy;
  const width = Math.max(0.08, edges.right - edges.left);
  const height = Math.max(0.08, edges.bottom - edges.top);
  const left = handle.includes('w') ? edges.right - width : edges.left;
  const top = handle.includes('n') ? edges.bottom - height : edges.top;
  const placed = placeWidget({ left, top, width, height }, start.anchor);
  return { ...start, ...placed, width, height };
}

export function LyricsPresetEditor({
  presetId,
  onClose,
}: {
  presetId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings', { keyPrefix: 'lyricsPresets' });
  const { t: appearance } = useTranslation('settings', { keyPrefix: 'appearance' });
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const provider = useContext(ProviderContext);
  const lyricsPresets = usePreferencesStore((state) => state.lyricsPresets);
  const updateLyricsPresets = usePreferencesStore((state) => state.updateLyricsPresets);
  const source = resolveLyricsPreset(lyricsPresets, presetId);
  const [draft, setDraft] = useState<LyricsPresetDefinition>(source);
  const [frame, setFrame] = useState<LyricsPreviewFrame>('desktop');
  const [savePrompt, setSavePrompt] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [newName, setNewName] = useState(source.name ?? '');
  const [selectedId, setSelectedId] = useState<SceneWidgetId | null>(null);
  const [guides, setGuides] = useState<{ axis: 'x' | 'y'; position: number }[]>([]);
  const [past, setPast] = useState<LyricsPresetDefinition[]>([]);
  const [future, setFuture] = useState<LyricsPresetDefinition[]>([]);
  const [editorGesture, setEditorGesture] = useState(false);
  const gesture = useRef<{
    kind: 'move' | 'resize';
    id: Exclude<SceneWidgetId, 'background'>;
    handle?: ResizeHandle;
    start: WidgetTransform;
    snapshot: LyricsPresetDefinition;
    originX: number;
    originY: number;
  } | null>(null);
  const sliderSnapshot = useRef<LyricsPresetDefinition | null>(null);
  const draftRef = useRef(draft);
  const preview = useLyricsPresetPreviewStore();
  const artworkSrc = useSafeArtworkSource(preview.artworkSrc);
  const builtin = isBuiltinPresetId(presetId);
  const getPositionMs = useCallback(() => useLyricsPresetPreviewStore.getState().positionMs, []);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    logger.info('lyrics.composer.open', 'opened lyrics composer', { id: presetId });
    const node = dialogRef.current;
    if (!node) return;
    try {
      node.showModal();
    } catch {
      node.setAttribute('open', '');
    }
    const controller = new AbortController();
    if (provider) void hydrateLyricsPresetPreview(provider, controller.signal);
    return () => {
      controller.abort();
      useLyricsPresetPreviewStore.getState().reset();
    };
  }, [presetId, provider]);

  useEffect(() => {
    if (!preview.isPlaying) return undefined;
    let frameHandle = 0;
    let last = performance.now();
    const loop = (now: number) => {
      useLyricsPresetPreviewStore.getState().tick(now - last);
      last = now;
      frameHandle = window.requestAnimationFrame(loop);
    };
    frameHandle = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frameHandle);
  }, [preview.isPlaying]);

  const commit = (next: LyricsPresetDefinition, snapshot = draft) => {
    if (presetsEqualForHistory(snapshot, next)) {
      setDraft(next);
      return;
    }
    setPast((current) => pushComposerHistory(current, snapshot));
    setFuture([]);
    setDraft(next);
  };

  const undo = () => {
    const snapshot = past.at(-1);
    if (!snapshot) return;
    setPast((current) => current.slice(0, -1));
    setFuture((current) => [clonePresetDraft(draft), ...current]);
    setDraft(snapshot);
  };

  const redo = () => {
    const snapshot = future[0];
    if (!snapshot) return;
    setFuture((current) => current.slice(1));
    setPast((current) => pushComposerHistory(current, draft));
    setDraft(snapshot);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (!selectedId || selectedId === 'background' || draft.scene[selectedId].locked) return;
      const step = event.shiftKey ? 0.02 : 0.008;
      const delta =
        event.key === 'ArrowLeft'
          ? { x: -step, y: 0 }
          : event.key === 'ArrowRight'
            ? { x: step, y: 0 }
            : event.key === 'ArrowUp'
              ? { x: 0, y: -step }
              : event.key === 'ArrowDown'
                ? { x: 0, y: step }
                : null;
      if (!delta) return;
      event.preventDefault();
      commit(
        updateSceneWidget(draft, selectedId, {
          x: draft.scene[selectedId].x + delta.x,
          y: draft.scene[selectedId].y + delta.y,
        }),
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const presetLabel =
    source.name ?? (isPresetNameKey(source.nameKey) ? t(source.nameKey) : t('custom'));

  const applyToSlot = () => {
    updateLyricsPresets((current) => applyOverride(current, presetId, patchFromDefinition(draft)));
    logger.info('lyrics.preset.save', 'applied lyrics preset configuration', {
      id: presetId,
      mode: builtin ? 'override' : 'custom',
    });
    onClose();
  };

  const saveAsNew = () => {
    let createdId = '';
    const name = newName.trim() || undefined;
    updateLyricsPresets((current) => {
      const created = saveAsNewPreset(current, presetId, {
        patch: patchFromDefinition(draft),
        name,
      });
      createdId = created.id;
      return created.state;
    });
    logger.info('lyrics.preset.save', 'saved new lyrics preset', {
      id: createdId,
      sourceId: presetId,
    });
    onClose();
  };

  const duplicate = () => {
    let createdId = '';
    updateLyricsPresets((current) => {
      const created = saveAsNewPreset(current, presetId, {
        patch: patchFromDefinition(draft),
        name: `${presetLabel} copy`,
      });
      createdId = created.id;
      return created.state;
    });
    logger.info('lyrics.preset.save', 'duplicated lyrics preset', {
      id: createdId,
      sourceId: presetId,
    });
    onClose();
  };

  const resetToBuiltin = () => {
    updateLyricsPresets((current) => resetOverride(current, presetId));
    logger.info('lyrics.preset.reset', 'removed builtin override', { id: presetId });
    onClose();
  };

  const handlePlayToggle = () => {
    try {
      preview.toggle();
    } catch (caught) {
      logger.error('lyrics.preview.error', 'preset preview failed', {
        error: String(caught),
        songId: preview.songId,
      });
    }
  };

  const appearanceModel = resolveLyricsAppearance(
    {
      mode:
        draft.scene.background.source === 'color'
          ? 'color'
          : draft.scene.background.source === 'image'
            ? 'image'
            : 'artwork',
      imageSource: artworkSrc,
      imageFit: draft.background.fit,
      color: draft.background.fallbackColor,
    },
    artworkSrc,
  );

  const bindings: LyricsSceneBindings = useMemo(
    () => ({
      songId: preview.songId,
      title: preview.song.title,
      artistLabel: joinArtistNames(preview.song.artists),
      artworkSrc,
      artworkAlt: preview.song.artwork.alt,
      artworkColor: preview.song.artwork.dominantColor,
      lyrics: preview.lyrics,
      lyricsStatus: 'ready',
      isPlaying: preview.isPlaying,
      positionMs: preview.positionMs,
      durationMs: preview.durationMs,
      timelineRevision: preview.timelineRevision,
      presentationOffsetMs: 0,
      getPositionMs,
      seek: preview.seek,
      togglePlayback: preview.toggle,
      translation: 'show',
      romanization: 'show',
    }),
    [
      artworkSrc,
      getPositionMs,
      preview.durationMs,
      preview.isPlaying,
      preview.lyrics,
      preview.positionMs,
      preview.seek,
      preview.timelineRevision,
      preview.song,
      preview.songId,
      preview.toggle,
    ],
  );

  const movable = selectedId && selectedId !== 'background' ? draft.scene[selectedId] : null;

  const sceneRect = () =>
    canvasRef.current?.querySelector('.lyrics-scene')?.getBoundingClientRect();

  const onPointerMove = (event: PointerEvent) => {
    const current = gesture.current;
    const rect = sceneRect();
    if (!current || !rect || rect.width === 0 || rect.height === 0) return;
    const dx = (event.clientX - current.originX) / rect.width;
    const dy = (event.clientY - current.originY) / rect.height;
    const bypass = event.altKey || event.ctrlKey || event.metaKey;
    if (current.kind === 'move') {
      const nextBox = {
        ...current.start,
        x: current.start.x + dx,
        y: current.start.y + dy,
      };
      const snapped = snapWidgetPosition(
        nextBox,
        SCENE_WIDGET_IDS.filter(
          (id) => id !== 'background' && id !== current.id && draft.scene[id].visible,
        ).map((id) => draft.scene[id] as WidgetTransform),
        bypass,
      );
      setGuides(snapped.guides);
      setDraft(updateSceneWidget(draft, current.id, { x: snapped.x, y: snapped.y }));
    } else if (current.handle) {
      const resized = applyResize(current.start, current.handle, dx, dy);
      setDraft(updateSceneWidget(draft, current.id, resized));
    }
  };

  const endGesture = () => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setEditorGesture(false);
    setGuides([]);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endGesture);
    if (!presetsEqualForHistory(current.snapshot, draftRef.current)) {
      setPast((history) => pushComposerHistory(history, current.snapshot));
      setFuture([]);
      logger.info(
        current.kind === 'move' ? 'lyrics.composer.drag' : 'lyrics.composer.resize',
        'committed composer gesture',
        { id: current.id },
      );
    }
  };

  const startMove = (id: Exclude<SceneWidgetId, 'background'>, event: ReactPointerEvent) => {
    if (draft.scene[id].locked) return;
    gesture.current = {
      kind: 'move',
      id,
      start: { ...draft.scene[id] },
      snapshot: clonePresetDraft(draft),
      originX: event.clientX,
      originY: event.clientY,
    };
    setEditorGesture(id === 'lyrics');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endGesture);
  };

  const startResize = (handle: ResizeHandle, event: ReactPointerEvent) => {
    if (!selectedId || selectedId === 'background' || draft.scene[selectedId].locked) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = {
      kind: 'resize',
      id: selectedId,
      handle,
      start: { ...draft.scene[selectedId] },
      snapshot: clonePresetDraft(draft),
      originX: event.clientX,
      originY: event.clientY,
    };
    setEditorGesture(selectedId === 'lyrics');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endGesture);
  };

  return (
    <dialog
      ref={dialogRef}
      className="lyrics-preset-editor"
      aria-labelledby="lyrics-preset-editor-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="lyrics-preset-editor__body">
        <header className="lyrics-preset-editor__header">
          <div>
            <h2 id="lyrics-preset-editor-title">{t('editorTitle', { name: presetLabel })}</h2>
            <p>
              {preview.song.title} — {joinArtistNames(preview.song.artists)}
            </p>
          </div>
          <button type="button" className="button button--quiet" onClick={onClose}>
            {t('cancel')}
          </button>
        </header>

        <div
          className="lyrics-preset-editor__toolbar"
          role="toolbar"
          aria-label={t('previewFrame')}
        >
          {PREVIEW_FRAMES.map((option) => (
            <button
              key={option}
              type="button"
              className="button button--quiet"
              aria-pressed={frame === option}
              onClick={() => setFrame(option)}
            >
              {t(`frames.${option}`)}
            </button>
          ))}
          <button
            type="button"
            className="button button--secondary"
            aria-pressed={preview.isPlaying}
            onClick={handlePlayToggle}
          >
            {preview.isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {preview.isPlaying ? t('pausePreview') : t('playPreview')}
          </button>
          <label className="settings-range lyrics-preset-editor__seek">
            <input
              type="range"
              min={0}
              max={preview.durationMs}
              step={50}
              value={preview.positionMs}
              aria-label={t('seekPreview')}
              onChange={(event) => preview.seek(Number(event.target.value))}
              style={
                {
                  '--range-progress': `${(preview.positionMs / Math.max(preview.durationMs, 1)) * 100}%`,
                } as CSSProperties
              }
            />
          </label>
          <button
            type="button"
            className="button button--quiet"
            onClick={undo}
            disabled={past.length === 0}
          >
            {t('undo')}
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={redo}
            disabled={future.length === 0}
          >
            {t('redo')}
          </button>
        </div>

        <div className="lyrics-preset-editor__workspace">
          <div
            ref={canvasRef}
            className="lyrics-composer-canvas"
            onPointerDown={(event) => {
              const handle = (event.target as HTMLElement).closest('[data-resize]');
              if (handle) return;
              const widget = (event.target as HTMLElement).closest('[data-widget]');
              const id = widget?.getAttribute('data-widget') as SceneWidgetId | null;
              if (!id) {
                setSelectedId(null);
                return;
              }
              if (
                id === 'background' ||
                isInteractiveTarget(event.target) ||
                draft.scene[id].locked
              ) {
                return;
              }
              startMove(id, event);
            }}
          >
            <LyricsScene
              preset={draft}
              bindings={bindings}
              appearance={appearanceModel}
              mode="editor"
              selectedWidgetId={selectedId}
              onSelectWidget={(id) => setSelectedId(id as SceneWidgetId | null)}
              editorGesture={editorGesture}
              guides={guides}
              previewFrame={frame}
              fallbackNotice={preview.offline ? t('offlinePreview') : null}
            />
            {movable && !movable.locked && (
              <div className="lyrics-composer-handles" style={widgetBoxStyle(movable)}>
                {RESIZE_HANDLES.map((handle) => (
                  <button
                    key={handle}
                    type="button"
                    className="lyrics-composer-handle"
                    data-resize={handle}
                    aria-label={t('resizeHandle', { handle })}
                    onPointerDown={(event) => startResize(handle, event)}
                  />
                ))}
              </div>
            )}
          </div>

          <aside className="lyrics-preset-editor__side">
            <div className="lyrics-composer-layers" aria-label={t('layers')}>
              <strong>{t('layers')}</strong>
              {SCENE_WIDGET_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="button button--quiet"
                  aria-pressed={selectedId === id}
                  onClick={() => setSelectedId(id)}
                >
                  {t(`widgets.${id}`)}
                  {draft.scene[id].locked ? ` · ${t('locked')}` : ''}
                  {!draft.scene[id].visible ? ` · ${t('hidden')}` : ''}
                </button>
              ))}
            </div>

            <div className="lyrics-composer-inspector">
              <ComposerRange
                label={t('fontSize')}
                min={FONT_SCALE_MIN}
                max={FONT_SCALE_MAX}
                step={0.01}
                value={draft.typography.fontScale}
                output={`${Math.round(draft.typography.fontScale * 100)}%`}
                onGestureStart={() => {
                  sliderSnapshot.current = clonePresetDraft(draft);
                }}
                onGestureEnd={() => {
                  if (sliderSnapshot.current) commit(draft, sliderSnapshot.current);
                  sliderSnapshot.current = null;
                }}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    typography: { ...draft.typography, fontScale: clampFontScale(value) },
                  })
                }
                onReset={() =>
                  commit({
                    ...draft,
                    typography: { ...draft.typography, fontScale: 1 },
                  })
                }
              />
              <ComposerRange
                label={t('lineSpacing')}
                min={LINE_HEIGHT_MIN}
                max={LINE_HEIGHT_MAX}
                step={0.01}
                value={draft.typography.lineHeight}
                output={draft.typography.lineHeight.toFixed(2)}
                onGestureStart={() => {
                  sliderSnapshot.current = clonePresetDraft(draft);
                }}
                onGestureEnd={() => {
                  if (sliderSnapshot.current) commit(draft, sliderSnapshot.current);
                  sliderSnapshot.current = null;
                }}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    typography: { ...draft.typography, lineHeight: clampLineHeight(value) },
                  })
                }
                onReset={() =>
                  commit({
                    ...draft,
                    typography: { ...draft.typography, lineHeight: 1.16 },
                  })
                }
              />
              <label className="lyrics-preset-editor__select">
                <span>{appearance('fit')}</span>
                <select
                  value={draft.background.fit}
                  aria-label={appearance('fit')}
                  onChange={(event) =>
                    commit(
                      updateSceneWidget(draft, 'background', {
                        fit: event.target.value as LyricsBackgroundFit,
                      }),
                    )
                  }
                >
                  <option value="cover">{appearance('fitCover')}</option>
                  <option value="contain">{appearance('fitContain')}</option>
                </select>
              </label>
              {selectedId && (
                <>
                  <label className="lyrics-preset-editor__select">
                    <span>{t('visible')}</span>
                    <input
                      type="checkbox"
                      checked={draft.scene[selectedId].visible}
                      aria-label={t('visible')}
                      onChange={(event) =>
                        commit(
                          updateSceneWidget(draft, selectedId, { visible: event.target.checked }),
                        )
                      }
                    />
                  </label>
                  <label className="lyrics-preset-editor__select">
                    <span>{t('locked')}</span>
                    <input
                      type="checkbox"
                      checked={draft.scene[selectedId].locked}
                      aria-label={t('locked')}
                      onChange={(event) =>
                        commit(
                          updateSceneWidget(draft, selectedId, { locked: event.target.checked }),
                        )
                      }
                    />
                  </label>
                  <ComposerRange
                    label={t('zOrder')}
                    min={0}
                    max={12}
                    step={1}
                    value={draft.scene[selectedId].zIndex}
                    output={String(draft.scene[selectedId].zIndex)}
                    onChange={(value) =>
                      setDraft(updateSceneWidget(draft, selectedId, { zIndex: value }))
                    }
                    onGestureStart={() => {
                      sliderSnapshot.current = clonePresetDraft(draft);
                    }}
                    onGestureEnd={() => {
                      if (sliderSnapshot.current) commit(draft, sliderSnapshot.current);
                      sliderSnapshot.current = null;
                    }}
                  />
                </>
              )}
              {movable && (
                <>
                  <label className="lyrics-preset-editor__select">
                    <span>{t('anchor')}</span>
                    <select
                      value={movable.anchor}
                      aria-label={t('anchor')}
                      onChange={(event) =>
                        commit(
                          updateSceneWidget(
                            draft,
                            selectedId as Exclude<SceneWidgetId, 'background'>,
                            {
                              anchor: event.target.value as WidgetAnchor,
                            },
                          ),
                        )
                      }
                    >
                      {WIDGET_ANCHORS.map((anchor) => (
                        <option key={anchor} value={anchor}>
                          {anchor}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() =>
                      commit(
                        resetSceneWidgetPosition(
                          draft,
                          selectedId as Exclude<SceneWidgetId, 'background'>,
                        ),
                      )
                    }
                  >
                    {t('resetPosition')}
                  </button>
                </>
              )}
              {selectedId && (
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => commit(resetSceneWidget(draft, selectedId))}
                >
                  {t('resetWidget')}
                </button>
              )}
              {selectedId === 'artwork' && (
                <label className="lyrics-preset-editor__select">
                  <span>{t('artworkRenderer')}</span>
                  <select
                    value={draft.scene.artwork.renderer}
                    aria-label={t('artworkRenderer')}
                    onChange={(event) =>
                      commit(
                        updateSceneWidget(draft, 'artwork', {
                          renderer: event.target.value as LyricsArtworkRenderer,
                        }),
                      )
                    }
                  >
                    <option value="square">square</option>
                    <option value="rounded">rounded</option>
                    <option value="vinyl">vinyl</option>
                  </select>
                </label>
              )}
              {(selectedId === 'lyrics' ||
                selectedId === 'metadata' ||
                selectedId === 'transport') && (
                <label className="lyrics-preset-editor__select">
                  <span>{t('align')}</span>
                  <select
                    value={
                      selectedId === 'lyrics'
                        ? draft.scene.lyrics.align
                        : selectedId === 'metadata'
                          ? draft.scene.metadata.align
                          : draft.scene.transport.align
                    }
                    aria-label={t('align')}
                    onChange={(event) =>
                      commit(
                        updateSceneWidget(draft, selectedId, {
                          align: event.target.value as LyricsAlign,
                        }),
                      )
                    }
                  >
                    <option value="left">left</option>
                    <option value="center">center</option>
                    <option value="right">right</option>
                  </select>
                </label>
              )}
              {selectedId === 'background' && (
                <>
                  <label className="lyrics-preset-editor__select">
                    <span>{t('backgroundKind')}</span>
                    <select
                      value={draft.scene.background.source}
                      aria-label={t('backgroundKind')}
                      onChange={(event) =>
                        commit(
                          updateSceneWidget(draft, 'background', {
                            source: event.target.value as LyricsBackgroundKind,
                          }),
                        )
                      }
                    >
                      <option value="artwork">artwork</option>
                      <option value="color">color</option>
                      <option value="image">image</option>
                    </select>
                  </label>
                  <label className="lyrics-preset-editor__select">
                    <span>{t('fallbackColor')}</span>
                    <input
                      type="color"
                      value={draft.scene.background.fallbackColor}
                      aria-label={t('fallbackColor')}
                      onChange={(event) =>
                        commit(
                          updateSceneWidget(draft, 'background', {
                            fallbackColor: event.target.value.toUpperCase(),
                          }),
                        )
                      }
                    />
                  </label>
                </>
              )}
            </div>
          </aside>
        </div>

        {savePrompt ? (
          <div className="lyrics-preset-editor__prompt" role="group" aria-label={t('save')}>
            <label className="lyrics-preset-editor__select">
              <span>{t('presetName')}</span>
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                aria-label={t('presetName')}
              />
            </label>
            {builtin ? (
              <>
                <button type="button" className="button button--primary" onClick={applyToSlot}>
                  {t('applyToPreset')}
                </button>
                <button type="button" className="button button--secondary" onClick={saveAsNew}>
                  {t('saveAsNew')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="button button--primary" onClick={applyToSlot}>
                  {t('save')}
                </button>
                <button type="button" className="button button--secondary" onClick={saveAsNew}>
                  {t('saveAsNew')}
                </button>
              </>
            )}
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setSavePrompt(false)}
            >
              {t('cancel')}
            </button>
          </div>
        ) : confirmReset ? (
          <div
            className="lyrics-preset-editor__prompt"
            role="alertdialog"
            aria-label={t('resetConfirm')}
          >
            <p>{t('resetConfirm')}</p>
            <button type="button" className="button button--primary" onClick={resetToBuiltin}>
              {t('reset')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setConfirmReset(false)}
            >
              {t('cancel')}
            </button>
          </div>
        ) : (
          <div className="lyrics-preset-editor__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => setSavePrompt(true)}
            >
              {t('save')}
            </button>
            <button type="button" className="button button--quiet" onClick={duplicate}>
              {t('duplicate')}
            </button>
            {builtin && hasBuiltinOverride(lyricsPresets, presetId) && (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => setConfirmReset(true)}
              >
                {t('reset')}
              </button>
            )}
            <button type="button" className="button button--quiet" onClick={onClose}>
              {t('cancel')}
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}

export function LyricsPresetPicker() {
  const { t } = useTranslation('settings', { keyPrefix: 'lyricsPresets' });
  const lyricsPresets = usePreferencesStore((state) => state.lyricsPresets);
  const selectLyricsPreset = usePreferencesStore((state) => state.selectLyricsPreset);
  const [editingId, setEditingId] = useState<string | null>(null);
  const resolved = listResolvedPresets(lyricsPresets);

  return (
    <div className="lyrics-preset-picker">
      <div className="lyrics-preset-picker__grid" role="radiogroup" aria-label={t('title')}>
        {resolved.map((preset) => {
          const selected = lyricsPresets.selectedId === preset.id;
          const label =
            preset.name ?? (isPresetNameKey(preset.nameKey) ? t(preset.nameKey) : t('custom'));
          return (
            <button
              key={preset.id}
              type="button"
              className="lyrics-preset-card"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              data-selected={selected || undefined}
              onClick={() => selectLyricsPreset(preset.id)}
            >
              <strong>{label}</strong>
              <span>{t(`layouts.${preset.layout}`)}</span>
              {hasBuiltinOverride(lyricsPresets, preset.id) && <em>{t('customized')}</em>}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="button button--secondary"
        onClick={() => setEditingId(lyricsPresets.selectedId)}
      >
        {t('customize')}
      </button>
      {editingId && <LyricsPresetEditor presetId={editingId} onClose={() => setEditingId(null)} />}
    </div>
  );
}
