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
import {
  Pause,
  Play,
  Disc3,
  Image,
  Type,
  Music,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import {
  applyOverride,
  clampFollowAnchor,
  clampFontScale,
  clampLineHeight,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FOLLOW_ANCHOR_DEFAULT,
  factoryScene,
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
  resolvePrimaryFontSizePx,
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
  composerStageFit,
  constrainVisualSquare,
  DRAG_THRESHOLD_PX,
  logicalSceneSize,
  overlayBoundsForWidget,
  percentFromUnit,
  sceneAspectRatio,
  screenDeltaToNormalized,
  unitFromPercent,
  type ComposerZoom,
} from '../application/lyrics-composer-view';
import {
  placeWidget,
  snapWidgetPosition,
  widgetBoxStyle,
  widgetEdges,
} from '../application/lyrics-scene-geometry';
import { applySceneBackdrop, resolveLyricsAppearance } from '../application/lyrics-appearance';
import { useSafeArtworkSource } from '../application/artwork-source';
import { useBlurredArtwork } from '../application/blurred-artwork';
import { logger } from '../application/logger';
import { useLyricsPresetPreviewStore } from '../application/lyrics-preset-preview';
import { hydrateLyricsPresetPreview } from '../application/lyrics-preset-preview-hydrate';
import { usePreferencesStore, type SecondaryLyricVisibility } from '../application/preferences';
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
  return target instanceof Element && Boolean(target.closest('[data-editor-interactive]'));
}

function layerIcon(id: SceneWidgetId) {
  if (id === 'artwork') return <Disc3 size={14} />;
  if (id === 'metadata') return <Type size={14} />;
  if (id === 'lyrics') return <Music size={14} />;
  if (id === 'transport') return <Play size={14} />;
  return <Image size={14} />;
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

function PercentField({
  label,
  value,
  min = -20,
  max = 120,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="lyrics-preset-editor__select">
      <span>{label}</span>
      <span className="lyrics-composer-percent">
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={percentFromUnit(value)}
          aria-label={label}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(unitFromPercent(next));
          }}
        />
        <abbr>%</abbr>
      </span>
    </label>
  );
}

function AnchorPicker({
  value,
  label,
  onChange,
}: {
  value: WidgetAnchor;
  label: string;
  onChange: (value: WidgetAnchor) => void;
}) {
  return (
    <div className="lyrics-preset-editor__select">
      <span>{label}</span>
      <div className="lyrics-composer-anchor" role="group" aria-label={label}>
        {WIDGET_ANCHORS.map((anchor) => (
          <button
            key={anchor}
            type="button"
            aria-label={anchor}
            aria-pressed={value === anchor}
            title={anchor}
            onClick={() => onChange(anchor)}
          />
        ))}
      </div>
    </div>
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
  const { t: lyricsCopy } = useTranslation('settings', { keyPrefix: 'lyrics' });
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const provider = useContext(ProviderContext);
  const lyricsPresets = usePreferencesStore((state) => state.lyricsPresets);
  const updateLyricsPresets = usePreferencesStore((state) => state.updateLyricsPresets);
  const translation = usePreferencesStore((state) => state.lyrics.translation);
  const romanization = usePreferencesStore((state) => state.lyrics.romanization);
  const wordEffect = usePreferencesStore((state) => state.lyrics.wordEffect);
  const updateLyrics = usePreferencesStore((state) => state.updateLyrics);
  const source = resolveLyricsPreset(lyricsPresets, presetId);
  const [draft, setDraft] = useState<LyricsPresetDefinition>(source);
  const [frame, setFrame] = useState<LyricsPreviewFrame>('desktop');
  const [savePrompt, setSavePrompt] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [newName, setNewName] = useState(source.name ?? '');
  const [selectedId, setSelectedId] = useState<SceneWidgetId | null>(null);
  const [guides, setGuides] = useState<{ axis: 'x' | 'y'; position: number }[]>([]);
  const [past, setPast] = useState<LyricsPresetDefinition[]>([]);
  const [future, setFuture] = useState<LyricsPresetDefinition[]>([]);
  const [editorGesture, setEditorGesture] = useState(false);
  const [zoom, setZoom] = useState<ComposerZoom>('fit');
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [windowSize, setWindowSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1920 : window.innerWidth,
    height: typeof window === 'undefined' ? 1080 : window.innerHeight,
  }));
  const openedDraft = useRef(source);
  const gesture = useRef<{
    kind: 'move' | 'resize';
    id: Exclude<SceneWidgetId, 'background'>;
    handle?: ResizeHandle;
    start: WidgetTransform;
    snapshot: LyricsPresetDefinition;
    originX: number;
    originY: number;
    pointerId: number;
    dragging: boolean;
  } | null>(null);
  const sliderSnapshot = useRef<LyricsPresetDefinition | null>(null);
  const draftRef = useRef(draft);
  const moveRaf = useRef<number | null>(null);
  const pendingMove = useRef<PointerEvent | null>(null);
  const preview = useLyricsPresetPreviewStore();
  const artworkSrc = useSafeArtworkSource(preview.artworkSrc);
  const previewBlurred = useBlurredArtwork(
    draft.scene.background.source === 'color' || draft.scene.background.blur <= 0
      ? null
      : artworkSrc,
  );
  const builtin = isBuiltinPresetId(presetId);
  const getPositionMs = useCallback(() => useLyricsPresetPreviewStore.getState().positionMs, []);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const assignDraft = useCallback((next: LyricsPresetDefinition) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const commit = (next: LyricsPresetDefinition, snapshot = draftRef.current) => {
    if (presetsEqualForHistory(snapshot, next)) {
      assignDraft(next);
      return;
    }
    setPast((current) => pushComposerHistory(current, snapshot));
    setFuture([]);
    assignDraft(next);
  };

  const beginSlider = () => {
    sliderSnapshot.current = clonePresetDraft(draftRef.current);
  };

  const endSlider = () => {
    if (!sliderSnapshot.current) return;
    commit(draftRef.current, sliderSnapshot.current);
    sliderSnapshot.current = null;
  };

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
    const node = canvasRef.current;
    if (!node || typeof ResizeObserver !== 'function') return;
    const update = () => setAvailable({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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

  const undo = () => {
    const snapshot = past.at(-1);
    if (!snapshot) return;
    setPast((current) => current.slice(0, -1));
    setFuture((current) => [clonePresetDraft(draftRef.current), ...current]);
    assignDraft(snapshot);
  };

  const redo = () => {
    const snapshot = future[0];
    if (!snapshot) return;
    setFuture((current) => current.slice(1));
    setPast((current) => pushComposerHistory(current, draftRef.current));
    assignDraft(snapshot);
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
      if (!selectedId || selectedId === 'background' || draftRef.current.scene[selectedId].locked) {
        return;
      }
      const live = draftRef.current;
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
        updateSceneWidget(live, selectedId, {
          x: live.scene[selectedId].x + delta.x,
          y: live.scene[selectedId].y + delta.y,
        }),
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const presetLabel =
    source.name ?? (isPresetNameKey(source.nameKey) ? t(source.nameKey) : t('custom'));

  const applyToSlot = () => {
    updateLyricsPresets((current) =>
      applyOverride(current, presetId, patchFromDefinition(draftRef.current)),
    );
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
        patch: patchFromDefinition(draftRef.current),
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
        patch: patchFromDefinition(draftRef.current),
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

  const requestClose = () => {
    if (gesture.current) return;
    if (!presetsEqualForHistory(openedDraft.current, draftRef.current)) {
      setConfirmDiscard(true);
      return;
    }
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

  const appearanceModel = applySceneBackdrop(
    resolveLyricsAppearance(
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
    ),
    draft.scene.background.blur,
    previewBlurred,
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
      translation,
      romanization,
      wordEffect,
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
      romanization,
      translation,
      wordEffect,
    ],
  );

  const logical = useMemo(() => logicalSceneSize(frame, windowSize), [frame, windowSize]);
  const fit = useMemo(() => composerStageFit(available, logical, zoom), [available, logical, zoom]);
  const viewRef = useRef({ fit, logical, aspect: sceneAspectRatio(logical) });
  useEffect(() => {
    viewRef.current = { fit, logical, aspect: sceneAspectRatio(logical) };
  }, [fit, logical]);

  const movable = selectedId && selectedId !== 'background' ? draft.scene[selectedId] : null;
  const overlayBox =
    movable && selectedId === 'artwork' && draft.scene.artwork.renderer === 'vinyl'
      ? overlayBoundsForWidget(movable, 'vinyl', sceneAspectRatio(logical))
      : movable;

  const applyPointerMove = useCallback(
    (event: PointerEvent) => {
      const current = gesture.current;
      const view = viewRef.current;
      if (!current || view.fit.scale === 0) return;
      const pixelDx = event.clientX - current.originX;
      const pixelDy = event.clientY - current.originY;
      if (!current.dragging) {
        if (Math.hypot(pixelDx, pixelDy) < DRAG_THRESHOLD_PX) return;
        current.dragging = true;
        if (current.id === 'lyrics') setEditorGesture(true);
      }
      const delta = screenDeltaToNormalized(pixelDx, pixelDy, view.fit.scale, view.logical);
      const bypass = event.altKey || event.ctrlKey || event.metaKey;
      if (current.kind === 'move') {
        const nextBox = {
          ...current.start,
          x: current.start.x + delta.x,
          y: current.start.y + delta.y,
        };
        const snapped = snapWidgetPosition(
          nextBox,
          SCENE_WIDGET_IDS.filter(
            (id) => id !== 'background' && id !== current.id && current.snapshot.scene[id].visible,
          ).map((id) => current.snapshot.scene[id] as WidgetTransform),
          bypass,
        );
        setGuides(snapped.guides);
        assignDraft(
          updateSceneWidget(current.snapshot, current.id, { x: snapped.x, y: snapped.y }),
        );
      } else if (current.handle) {
        let resized = applyResize(current.start, current.handle, delta.x, delta.y);
        if (
          current.id === 'artwork' &&
          current.snapshot.scene.artwork.renderer === 'vinyl' &&
          !bypass
        ) {
          const prefer =
            current.handle.includes('e') || current.handle.includes('w') ? 'width' : 'height';
          const square = constrainVisualSquare(resized.width, resized.height, view.aspect, prefer);
          resized = { ...resized, ...square };
        }
        assignDraft(updateSceneWidget(current.snapshot, current.id, resized));
      }
    },
    [assignDraft],
  );

  const flushPendingMove = useCallback(() => {
    if (moveRaf.current !== null) {
      window.cancelAnimationFrame(moveRaf.current);
      moveRaf.current = null;
    }
    const pending = pendingMove.current;
    pendingMove.current = null;
    if (pending) applyPointerMove(pending);
  }, [applyPointerMove]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      pendingMove.current = event;
      if (moveRaf.current !== null) return;
      moveRaf.current = window.requestAnimationFrame(() => {
        moveRaf.current = null;
        const pending = pendingMove.current;
        pendingMove.current = null;
        if (pending) applyPointerMove(pending);
      });
    },
    [applyPointerMove],
  );

  const endGestureRef = useRef<() => void>(() => {});

  const onPointerUp = useCallback(() => {
    endGestureRef.current();
  }, []);

  const endGesture = useCallback(() => {
    flushPendingMove();
    const current = gesture.current;
    if (!current) return;
    const pointerId = current.pointerId;
    gesture.current = null;
    setEditorGesture(false);
    setGuides([]);
    canvasRef.current?.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    try {
      canvasRef.current?.releasePointerCapture(pointerId);
    } catch {
      /* capture may already be released */
    }
    if (current.dragging && !presetsEqualForHistory(current.snapshot, draftRef.current)) {
      setPast((history) => pushComposerHistory(history, current.snapshot));
      setFuture([]);
      logger.info(
        current.kind === 'move' ? 'lyrics.composer.drag' : 'lyrics.composer.resize',
        'committed composer gesture',
        { id: current.id },
      );
    }
  }, [flushPendingMove, onPointerMove, onPointerUp]);

  useEffect(() => {
    endGestureRef.current = endGesture;
  }, [endGesture]);

  const startMove = (id: Exclude<SceneWidgetId, 'background'>, event: ReactPointerEvent) => {
    const live = draftRef.current;
    if (live.scene[id].locked) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = {
      kind: 'move',
      id,
      start: { ...live.scene[id] },
      snapshot: clonePresetDraft(live),
      originX: event.clientX,
      originY: event.clientY,
      pointerId: event.pointerId,
      dragging: false,
    };
    setSelectedId(id);
    try {
      canvasRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom */
    }
    canvasRef.current?.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const startResize = (handle: ResizeHandle, event: ReactPointerEvent) => {
    const live = draftRef.current;
    if (!selectedId || selectedId === 'background' || live.scene[selectedId].locked) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = {
      kind: 'resize',
      id: selectedId,
      handle,
      start: { ...live.scene[selectedId] },
      snapshot: clonePresetDraft(live),
      originX: event.clientX,
      originY: event.clientY,
      pointerId: event.pointerId,
      dragging: false,
    };
    try {
      canvasRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom */
    }
    canvasRef.current?.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  useEffect(
    () => () => {
      if (moveRaf.current !== null) window.cancelAnimationFrame(moveRaf.current);
      canvasRef.current?.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );

  return (
    <dialog
      ref={dialogRef}
      className="lyrics-preset-editor"
      aria-labelledby="lyrics-preset-editor-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        if (gesture.current) {
          assignDraft(gesture.current.snapshot);
          gesture.current = null;
          setEditorGesture(false);
          setGuides([]);
          return;
        }
        if (selectedId) {
          setSelectedId(null);
          return;
        }
        requestClose();
      }}
    >
      <div className="lyrics-preset-editor__body">
        <header className="lyrics-preset-editor__header">
          <div>
            <h2 id="lyrics-preset-editor-title">{t('editorTitle', { name: presetLabel })}</h2>
            <p>
              {preview.song.title} — {joinArtistNames(preview.song.artists)}
            </p>
          </div>
          <button type="button" className="button button--quiet" onClick={requestClose}>
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
          {(['fit', 1, 0.75, 0.5] as const).map((option) => (
            <button
              key={String(option)}
              type="button"
              className="button button--quiet"
              aria-pressed={zoom === option}
              onClick={() => setZoom(option)}
            >
              {option === 'fit' ? t('fit') : `${option * 100}%`}
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
              if (event.target === event.currentTarget) {
                setSelectedId(null);
              }
            }}
          >
            <div
              className="lyrics-composer-stage"
              data-composer-stage="true"
              style={{
                width: Math.max(1, fit.width),
                height: Math.max(1, fit.height),
              }}
            >
              <LyricsScene
                preset={draft}
                bindings={bindings}
                appearance={appearanceModel}
                mode="editor"
                selectedWidgetId={selectedId}
                onSelectWidget={(id) => {
                  if (gesture.current && id === null) return;
                  setSelectedId(id as SceneWidgetId | null);
                }}
                onEditorDragStart={(id, event) => {
                  if (id === 'background' || isInteractiveTarget(event.target)) return;
                  startMove(id, event);
                }}
                editorGesture={editorGesture}
                guides={guides}
                previewFrame={frame}
                fallbackNotice={preview.offline ? t('offlinePreview') : null}
              />
              {overlayBox && !movable?.locked && (
                <div className="lyrics-composer-handles">
                  <div
                    className="lyrics-composer-handles__box"
                    data-selection-bounds={selectedId ?? undefined}
                    style={widgetBoxStyle(overlayBox)}
                    onPointerDown={(event) => {
                      if ((event.target as HTMLElement).closest('[data-resize]')) return;
                      if (!selectedId || selectedId === 'background') return;
                      const hits = document.elementsFromPoint(event.clientX, event.clientY);
                      const interactive = hits.find(
                        (node) =>
                          node instanceof Element && node.closest('[data-editor-interactive]'),
                      );
                      if (interactive instanceof Element) {
                        const control = interactive.closest('[data-editor-interactive]');
                        if (control instanceof HTMLElement) control.click();
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      startMove(selectedId, event);
                    }}
                  >
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
                </div>
              )}
            </div>
          </div>

          <aside className="lyrics-preset-editor__side">
            <div className="lyrics-composer-layers" aria-label={t('layers')}>
              <strong>{t('layers')}</strong>
              {SCENE_WIDGET_IDS.map((id) => (
                <div key={id} className="lyrics-composer-layer-row">
                  <button
                    type="button"
                    className="lyrics-composer-layer"
                    aria-pressed={selectedId === id}
                    onClick={() => setSelectedId(id)}
                  >
                    {layerIcon(id)}
                    <span>{t(`widgets.${id}`)}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button--small"
                    aria-label={t('visible')}
                    aria-pressed={draft.scene[id].visible}
                    onClick={() =>
                      commit(
                        updateSceneWidget(draftRef.current, id, {
                          visible: !draftRef.current.scene[id].visible,
                        }),
                      )
                    }
                  >
                    {draft.scene[id].visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button--small"
                    aria-label={t('locked')}
                    aria-pressed={draft.scene[id].locked}
                    onClick={() =>
                      commit(
                        updateSceneWidget(draftRef.current, id, {
                          locked: !draftRef.current.scene[id].locked,
                        }),
                      )
                    }
                  >
                    {draft.scene[id].locked ? <Lock size={14} /> : <LockOpen size={14} />}
                  </button>
                </div>
              ))}
            </div>

            <div className="lyrics-composer-inspector">
              <div className="lyrics-composer-section">
                <h3>{t('typographySection')}</h3>
                <ComposerRange
                  label={t('fontSize')}
                  min={FONT_SCALE_MIN}
                  max={FONT_SCALE_MAX}
                  step={0.01}
                  value={draft.typography.fontScale}
                  output={`${Math.round(draft.typography.fontScale * 100)}% · ${Math.round(resolvePrimaryFontSizePx(draft.typography.fontScale, fit.height))}px`}
                  onGestureStart={beginSlider}
                  onGestureEnd={endSlider}
                  onChange={(value) =>
                    assignDraft({
                      ...draftRef.current,
                      typography: {
                        ...draftRef.current.typography,
                        fontScale: clampFontScale(value),
                      },
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
                  onGestureStart={beginSlider}
                  onGestureEnd={endSlider}
                  onChange={(value) =>
                    assignDraft({
                      ...draftRef.current,
                      typography: {
                        ...draftRef.current.typography,
                        lineHeight: clampLineHeight(value),
                      },
                    })
                  }
                  onReset={() =>
                    commit({
                      ...draft,
                      typography: { ...draft.typography, lineHeight: 1.16 },
                    })
                  }
                />
              </div>
              <div className="lyrics-composer-section">
                <h3>{t('backgroundSection')}</h3>
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
              </div>
              {selectedId && (
                <div className="lyrics-composer-section">
                  <h3>{t('behaviorSection')}</h3>
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
                      assignDraft(
                        updateSceneWidget(draftRef.current, selectedId, { zIndex: value }),
                      )
                    }
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                  />
                  {selectedId !== 'background' && (
                    <div>
                      <button
                        type="button"
                        className="button button--quiet"
                        onClick={() =>
                          commit(
                            updateSceneWidget(draftRef.current, selectedId, {
                              zIndex: Math.min(12, draftRef.current.scene[selectedId].zIndex + 1),
                            }),
                          )
                        }
                      >
                        <ChevronUp size={14} /> {t('bringForward')}
                      </button>
                      <button
                        type="button"
                        className="button button--quiet"
                        onClick={() =>
                          commit(
                            updateSceneWidget(draftRef.current, selectedId, {
                              zIndex: Math.max(0, draftRef.current.scene[selectedId].zIndex - 1),
                            }),
                          )
                        }
                      >
                        <ChevronDown size={14} /> {t('sendBackward')}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {movable && (
                <div className="lyrics-composer-section">
                  <h3>{t('layoutSection')}</h3>
                  <AnchorPicker
                    label={t('anchor')}
                    value={movable.anchor}
                    onChange={(anchor) =>
                      commit(
                        updateSceneWidget(
                          draftRef.current,
                          selectedId as Exclude<SceneWidgetId, 'background'>,
                          { anchor },
                        ),
                      )
                    }
                  />
                  <PercentField
                    label={t('positionX')}
                    value={movable.x}
                    onChange={(value) =>
                      commit(
                        updateSceneWidget(
                          draftRef.current,
                          selectedId as Exclude<SceneWidgetId, 'background'>,
                          { x: value },
                        ),
                      )
                    }
                  />
                  <PercentField
                    label={t('positionY')}
                    value={movable.y}
                    onChange={(value) =>
                      commit(
                        updateSceneWidget(
                          draftRef.current,
                          selectedId as Exclude<SceneWidgetId, 'background'>,
                          { y: value },
                        ),
                      )
                    }
                  />
                  <PercentField
                    label={t('width')}
                    value={movable.width}
                    min={4}
                    max={120}
                    onChange={(value) =>
                      commit(
                        updateSceneWidget(
                          draftRef.current,
                          selectedId as Exclude<SceneWidgetId, 'background'>,
                          { width: value },
                        ),
                      )
                    }
                  />
                  <PercentField
                    label={t('height')}
                    value={movable.height}
                    min={4}
                    max={120}
                    onChange={(value) =>
                      commit(
                        updateSceneWidget(
                          draftRef.current,
                          selectedId as Exclude<SceneWidgetId, 'background'>,
                          { height: value },
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() =>
                      commit(
                        resetSceneWidgetPosition(
                          draftRef.current,
                          selectedId as Exclude<SceneWidgetId, 'background'>,
                        ),
                      )
                    }
                  >
                    {t('resetPosition')}
                  </button>
                </div>
              )}
              {selectedId && (
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => commit(resetSceneWidget(draftRef.current, selectedId))}
                >
                  {t('resetWidget')}
                </button>
              )}
              {selectedId === 'artwork' && (
                <div className="lyrics-composer-section">
                  <h3>{t('artworkSection')}</h3>
                  <label className="lyrics-preset-editor__select">
                    <span>{t('artworkRenderer')}</span>
                    <select
                      value={draft.scene.artwork.renderer}
                      aria-label={t('artworkRenderer')}
                      onChange={(event) =>
                        commit(
                          updateSceneWidget(draftRef.current, 'artwork', {
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
                  <ComposerRange
                    label={t('artworkOpacity')}
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.scene.artwork.opacity}
                    output={`${Math.round(draft.scene.artwork.opacity * 100)}%`}
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                    onChange={(value) =>
                      assignDraft(
                        updateSceneWidget(draftRef.current, 'artwork', { opacity: value }),
                      )
                    }
                    onReset={() =>
                      commit(updateSceneWidget(draftRef.current, 'artwork', { opacity: 1 }))
                    }
                  />
                  <ComposerRange
                    label={t('artworkRadius')}
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.scene.artwork.radius}
                    output={`${Math.round(draft.scene.artwork.radius * 100)}%`}
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                    onChange={(value) =>
                      assignDraft(updateSceneWidget(draftRef.current, 'artwork', { radius: value }))
                    }
                    onReset={() =>
                      commit(
                        updateSceneWidget(draftRef.current, 'artwork', {
                          radius: factoryScene(draftRef.current.layout).artwork.radius,
                        }),
                      )
                    }
                  />
                </div>
              )}
              {selectedId === 'metadata' && (
                <div className="lyrics-composer-section">
                  <h3>{t('typographySection')}</h3>
                  <ComposerRange
                    label={t('titleScale')}
                    min={0.4}
                    max={1.2}
                    step={0.01}
                    value={draft.scene.metadata.titleScale}
                    output={`${Math.round(draft.scene.metadata.titleScale * 100)}%`}
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                    onChange={(value) =>
                      assignDraft(
                        updateSceneWidget(draftRef.current, 'metadata', { titleScale: value }),
                      )
                    }
                    onReset={() =>
                      commit(updateSceneWidget(draftRef.current, 'metadata', { titleScale: 1 }))
                    }
                  />
                  <ComposerRange
                    label={t('artistScale')}
                    min={0.4}
                    max={1.2}
                    step={0.01}
                    value={draft.scene.metadata.artistScale}
                    output={`${Math.round(draft.scene.metadata.artistScale * 100)}%`}
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                    onChange={(value) =>
                      assignDraft(
                        updateSceneWidget(draftRef.current, 'metadata', { artistScale: value }),
                      )
                    }
                    onReset={() =>
                      commit(updateSceneWidget(draftRef.current, 'metadata', { artistScale: 0.72 }))
                    }
                  />
                </div>
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
                        updateSceneWidget(draftRef.current, selectedId, {
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
              {selectedId === 'lyrics' && (
                <>
                  <ComposerRange
                    label={t('followAnchor')}
                    min={0.15}
                    max={0.85}
                    step={0.01}
                    value={draft.scene.lyrics.followAnchor}
                    output={`${Math.round(draft.scene.lyrics.followAnchor * 100)}%`}
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                    onChange={(value) =>
                      assignDraft(
                        updateSceneWidget(draftRef.current, 'lyrics', {
                          followAnchor: clampFollowAnchor(value),
                        }),
                      )
                    }
                    onReset={() =>
                      commit(
                        updateSceneWidget(draftRef.current, 'lyrics', {
                          followAnchor: FOLLOW_ANCHOR_DEFAULT,
                        }),
                      )
                    }
                  />
                  <label className="lyrics-preset-editor__select">
                    <span>{lyricsCopy('translation')}</span>
                    <select
                      value={translation}
                      aria-label={lyricsCopy('visibilityLabel', {
                        name: lyricsCopy('translation'),
                      })}
                      onChange={(event) =>
                        updateLyrics({
                          translation: event.target.value as SecondaryLyricVisibility,
                        })
                      }
                    >
                      <option value="auto">{lyricsCopy('auto')}</option>
                      <option value="show">{lyricsCopy('show')}</option>
                      <option value="hide">{lyricsCopy('hide')}</option>
                    </select>
                  </label>
                  <label className="lyrics-preset-editor__select">
                    <span>{lyricsCopy('romanization')}</span>
                    <select
                      value={romanization}
                      aria-label={lyricsCopy('visibilityLabel', {
                        name: lyricsCopy('romanization'),
                      })}
                      onChange={(event) =>
                        updateLyrics({
                          romanization: event.target.value as SecondaryLyricVisibility,
                        })
                      }
                    >
                      <option value="auto">{lyricsCopy('auto')}</option>
                      <option value="show">{lyricsCopy('show')}</option>
                      <option value="hide">{lyricsCopy('hide')}</option>
                    </select>
                  </label>
                </>
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
                          updateSceneWidget(draftRef.current, 'background', {
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
                          updateSceneWidget(draftRef.current, 'background', {
                            fallbackColor: event.target.value.toUpperCase(),
                          }),
                        )
                      }
                    />
                  </label>
                  <ComposerRange
                    label={t('backgroundBlur')}
                    min={0}
                    max={64}
                    step={1}
                    value={draft.scene.background.blur}
                    output={`${Math.round(draft.scene.background.blur)}px`}
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                    onChange={(value) =>
                      assignDraft(
                        updateSceneWidget(draftRef.current, 'background', { blur: value }),
                      )
                    }
                    onReset={() =>
                      commit(
                        updateSceneWidget(draftRef.current, 'background', {
                          blur: factoryScene(draftRef.current.layout).background.blur,
                        }),
                      )
                    }
                  />
                  <ComposerRange
                    label={t('backgroundInfluence')}
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.scene.background.influence}
                    output={`${Math.round(draft.scene.background.influence * 100)}%`}
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                    onChange={(value) =>
                      assignDraft(
                        updateSceneWidget(draftRef.current, 'background', { influence: value }),
                      )
                    }
                    onReset={() =>
                      commit(
                        updateSceneWidget(draftRef.current, 'background', {
                          influence: factoryScene(draftRef.current.layout).background.influence,
                        }),
                      )
                    }
                  />
                  <ComposerRange
                    label={t('backgroundOpacity')}
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.scene.background.opacity}
                    output={`${Math.round(draft.scene.background.opacity * 100)}%`}
                    onGestureStart={beginSlider}
                    onGestureEnd={endSlider}
                    onChange={(value) =>
                      assignDraft(
                        updateSceneWidget(draftRef.current, 'background', { opacity: value }),
                      )
                    }
                    onReset={() =>
                      commit(updateSceneWidget(draftRef.current, 'background', { opacity: 1 }))
                    }
                  />
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
        ) : confirmDiscard ? (
          <div
            className="lyrics-preset-editor__prompt"
            role="alertdialog"
            aria-label={t('discardConfirm')}
          >
            <p>{t('discardConfirm')}</p>
            <button type="button" className="button button--primary" onClick={onClose}>
              {t('discardChanges')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setConfirmDiscard(false)}
            >
              {t('keepEditing')}
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
            <button type="button" className="button button--quiet" onClick={requestClose}>
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
