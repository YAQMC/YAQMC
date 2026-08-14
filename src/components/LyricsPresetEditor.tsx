import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
  lineGapFromLineHeight,
  listResolvedPresets,
  patchFromDefinition,
  resetOverride,
  resolveLyricsPreset,
  saveAsNewPreset,
  type LyricsBackgroundFit,
  type LyricsPresetDefinition,
  type LyricsPreviewFrame,
} from '../application/lyrics-preset';
import {
  PREVIEW_FIXTURE_SONG_ID,
  previewFixtureLyrics,
  previewFixtureSong,
  useLyricsPresetPreviewStore,
} from '../application/lyrics-preset-preview';
import { logger } from '../application/logger';
import { selectLyricCursor } from '../application/lyrics-timing';
import { shouldShowLyricSecondary } from '../application/lyrics-presentation';
import { usePreferencesStore } from '../application/preferences';
import { joinArtistNames } from '../utils/format';

type LyricsPreviewStyle = CSSProperties & {
  '--lyrics-color': string;
  '--lyrics-ink': string;
  '--lyrics-ink-contrast': string;
  '--lyrics-stage-base': string;
  '--lyrics-font-scale': number;
  '--lyrics-line-height': number;
  '--lyrics-line-gap': string;
};

const PREVIEW_FRAMES: LyricsPreviewFrame[] = ['desktop', 'window'];
const PRESET_NAME_KEYS = ['classic', 'immersive', 'vinyl', 'custom'] as const;
type PresetNameKey = (typeof PRESET_NAME_KEYS)[number];

function isPresetNameKey(value: string): value is PresetNameKey {
  return (PRESET_NAME_KEYS as readonly string[]).includes(value);
}

function coverInk(hexColor: string): { ink: string; contrast: string } {
  const normalized = hexColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { ink: '#ffffff', contrast: '#10140c' };
  }
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.62
    ? { ink: '#171a12', contrast: '#ffffff' }
    : { ink: '#ffffff', contrast: '#10140c' };
}

function PresetPreviewStage({
  draft,
  frame,
}: {
  draft: LyricsPresetDefinition;
  frame: LyricsPreviewFrame;
}) {
  const positionMs = useLyricsPresetPreviewStore((state) => state.positionMs);
  const isPlaying = useLyricsPresetPreviewStore((state) => state.isPlaying);
  const seek = useLyricsPresetPreviewStore((state) => state.seek);
  const cursor = useMemo(() => selectLyricCursor(previewFixtureLyrics, positionMs), [positionMs]);
  const artwork = previewFixtureSong.artwork.src;
  const ink = coverInk(previewFixtureSong.artwork.dominantColor);
  const style = {
    '--lyrics-color': previewFixtureSong.artwork.dominantColor,
    '--lyrics-ink': ink.ink,
    '--lyrics-ink-contrast': ink.contrast,
    '--lyrics-stage-base': draft.background.fallbackColor,
    '--lyrics-font-scale': draft.typography.fontScale,
    '--lyrics-line-height': draft.typography.lineHeight,
    '--lyrics-line-gap': `${lineGapFromLineHeight(draft.typography.lineHeight)}em`,
    backgroundColor: draft.background.fallbackColor,
  } as LyricsPreviewStyle;

  return (
    <div
      className="lyrics-stage lyrics-preset-preview"
      data-preview-frame={frame}
      data-cover-layout={draft.layout}
      data-image-fit={draft.background.fit}
      data-background-mode="artwork"
      style={style}
      aria-label={`${previewFixtureSong.title} — ${joinArtistNames(previewFixtureSong.artists)}`}
    >
      <div
        className="lyrics-stage__backdrop"
        style={{ backgroundImage: `url("${artwork}")` }}
        aria-hidden="true"
      />
      <div className="lyrics-stage__wash" aria-hidden="true" />
      <div className="lyrics-stage__content">
        <aside className="lyrics-stage__control-panel">
          {draft.artwork.style === 'vinyl' || draft.layout === 'vinyl' ? (
            <div className="lyrics-stage__disc" data-playing={isPlaying || undefined}>
              <img
                className="lyrics-stage__disc-cover"
                src={artwork}
                alt={previewFixtureSong.artwork.alt}
                draggable={false}
              />
            </div>
          ) : (
            <img
              className="lyrics-stage__control-panel__artwork"
              src={artwork}
              alt={previewFixtureSong.artwork.alt}
              draggable={false}
            />
          )}
          <div className="lyrics-stage__control-panel__info">
            <strong>{previewFixtureSong.title}</strong>
            <span>{joinArtistNames(previewFixtureSong.artists)}</span>
          </div>
        </aside>
        <div className="lyrics-stage__viewport">
          {draft.layout === 'full' && (
            <div className="lyrics-stage__track-heading">
              <strong>{previewFixtureSong.title}</strong>
              <span>{joinArtistNames(previewFixtureSong.artists)}</span>
            </div>
          )}
          <div className="lyrics-stage__scroll">
            <div className="lyrics-stage__scroll-content">
              {previewFixtureLyrics.lines.map((line, lineIndex) => {
                const active = cursor.lineIndex === lineIndex;
                return (
                  <button
                    key={line.id}
                    type="button"
                    className="lyrics-line"
                    data-active={active || undefined}
                    aria-current={active ? 'true' : undefined}
                    aria-label={line.text}
                    onClick={() => line.startMs !== null && seek(line.startMs)}
                  >
                    <span className="lyrics-line__primary">{line.text}</span>
                    {shouldShowLyricSecondary(
                      'show',
                      line.romanization,
                      line.text,
                      'romanization',
                    ) && <span className="lyrics-line__romanization">{line.romanization}</span>}
                    {shouldShowLyricSecondary(
                      'show',
                      line.translation,
                      line.text,
                      'translation',
                    ) && <span className="lyrics-line__translation">{line.translation}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
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
  const lyricsPresets = usePreferencesStore((state) => state.lyricsPresets);
  const updateLyricsPresets = usePreferencesStore((state) => state.updateLyricsPresets);
  const source = resolveLyricsPreset(lyricsPresets, presetId);
  const [draft, setDraft] = useState<LyricsPresetDefinition>(source);
  const [frame, setFrame] = useState<LyricsPreviewFrame>('desktop');
  const [savePrompt, setSavePrompt] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const preview = useLyricsPresetPreviewStore();
  const builtin = isBuiltinPresetId(presetId);

  useEffect(() => {
    logger.info('lyrics.preset.edit', 'opened preset editor', { id: presetId });
    const node = dialogRef.current;
    if (!node) return;
    try {
      node.showModal();
    } catch {
      node.setAttribute('open', '');
    }
    return () => {
      useLyricsPresetPreviewStore.getState().reset();
    };
  }, [presetId]);

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

  const presetLabel =
    source.name ?? (isPresetNameKey(source.nameKey) ? t(source.nameKey) : t('custom'));

  const persistDraft = (next: LyricsPresetDefinition) => {
    setDraft(next);
  };

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
    updateLyricsPresets((current) => {
      const created = saveAsNewPreset(current, presetId, {
        patch: patchFromDefinition(draft),
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
        songId: PREVIEW_FIXTURE_SONG_ID,
      });
    }
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
              {previewFixtureSong.title} — {joinArtistNames(previewFixtureSong.artists)}
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
            />
          </label>
        </div>

        <PresetPreviewStage draft={draft} frame={frame} />

        <div className="lyrics-preset-editor__controls">
          <label className="settings-range">
            <span>{t('fontSize')}</span>
            <input
              type="range"
              min={FONT_SCALE_MIN}
              max={FONT_SCALE_MAX}
              step={0.01}
              value={draft.typography.fontScale}
              aria-valuemin={FONT_SCALE_MIN}
              aria-valuemax={FONT_SCALE_MAX}
              aria-valuenow={draft.typography.fontScale}
              aria-label={t('fontSize')}
              onInput={(event) =>
                persistDraft({
                  ...draft,
                  typography: {
                    ...draft.typography,
                    fontScale: clampFontScale(Number(event.currentTarget.value)),
                  },
                })
              }
            />
            <output>{Math.round(draft.typography.fontScale * 100)}%</output>
          </label>
          <label className="settings-range">
            <span>{t('lineSpacing')}</span>
            <input
              type="range"
              min={LINE_HEIGHT_MIN}
              max={LINE_HEIGHT_MAX}
              step={0.01}
              value={draft.typography.lineHeight}
              aria-valuemin={LINE_HEIGHT_MIN}
              aria-valuemax={LINE_HEIGHT_MAX}
              aria-valuenow={draft.typography.lineHeight}
              aria-label={t('lineSpacing')}
              onInput={(event) =>
                persistDraft({
                  ...draft,
                  typography: {
                    ...draft.typography,
                    lineHeight: clampLineHeight(Number(event.currentTarget.value)),
                  },
                })
              }
            />
            <output>{draft.typography.lineHeight.toFixed(2)}</output>
          </label>
          <label className="lyrics-preset-editor__select">
            <span>{appearance('fit')}</span>
            <select
              value={draft.background.fit}
              aria-label={appearance('fit')}
              onChange={(event) =>
                persistDraft({
                  ...draft,
                  background: {
                    ...draft.background,
                    fit: event.target.value as LyricsBackgroundFit,
                  },
                })
              }
            >
              <option value="cover">{appearance('fitCover')}</option>
              <option value="contain">{appearance('fitContain')}</option>
            </select>
          </label>
        </div>

        {savePrompt ? (
          <div className="lyrics-preset-editor__prompt" role="group" aria-label={t('save')}>
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
              <button type="button" className="button button--primary" onClick={applyToSlot}>
                {t('save')}
              </button>
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
