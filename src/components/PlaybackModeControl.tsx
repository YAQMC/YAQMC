import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { logger } from '../application/logger';
import {
  visualPlaybackMode,
  type PrimaryPlaybackMode,
  type VisualPlaybackMode,
} from '../application/playback-mode';
import { usePlayerStore } from '../application/player-store';
import { PlaybackModeGlyph, SelectedModeMark } from './playback-mode-icons';
import { IconButton } from './ui/IconButton';

const PRIMARY_MODES: readonly PrimaryPlaybackMode[] = ['sequential', 'shuffle', 'repeat-one'];

const MENU_WIDTH = 228;

export function PlaybackModeControl() {
  const { t } = useTranslation('player');
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const menuId = useId();
  const playbackOrder = usePlayerStore((state) => state.playbackOrder);
  const repeat = usePlayerStore((state) => state.repeat);
  const setPrimaryPlaybackMode = usePlayerStore((state) => state.setPrimaryPlaybackMode);
  const setRepeat = usePlayerStore((state) => state.setRepeat);
  const visual = visualPlaybackMode(playbackOrder, repeat);
  const currentLabel = modeLabel(visual, t);
  const triggerLabel = t('playbackMode', { mode: currentLabel });

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !surface.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !trigger.current) return;
    const updatePosition = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const estimatedHeight = Math.max(48, surface.current?.offsetHeight ?? 196);
      const top =
        anchor.top - estimatedHeight - 6 >= 8
          ? anchor.top - estimatedHeight - 6
          : Math.min(anchor.bottom + 6, window.innerHeight - estimatedHeight - 8);
      setPosition({
        top: Math.max(8, top),
        left: Math.max(8, Math.min(anchor.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
      });
    };
    updatePosition();
    requestAnimationFrame(() => {
      updatePosition();
      const selected = surface.current?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      );
      (
        selected ?? surface.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      )?.focus({ preventScroll: true });
    });
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const selectPrimary = (mode: PrimaryPlaybackMode) => {
    if (visual !== mode) {
      logger.info('player.mode', 'primary playback mode selected', { from: visual, to: mode });
    }
    setPrimaryPlaybackMode(mode);
    setOpen(false);
    trigger.current?.focus();
  };

  const selectRepeatAll = () => {
    if (visual !== 'repeat-all') {
      logger.info('player.mode', 'repeat all selected', { from: visual, to: 'repeat-all' });
    }
    setRepeat('all');
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="playback-mode" ref={root}>
      <IconButton
        ref={trigger}
        label={triggerLabel}
        size="small"
        className="playback-mode__trigger"
        active={open || visual !== 'sequential'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-pressed={visual !== 'sequential'}
        onClick={() => setOpen((value) => !value)}
      >
        <PlaybackModeGlyph mode={visual} />
      </IconButton>
      {open &&
        createPortal(
          <div
            id={menuId}
            className="playback-mode__surface"
            role="menu"
            aria-label={t('playbackModeMenu')}
            ref={surface}
            style={position}
            data-portal="true"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
                trigger.current?.focus();
                return;
              }
              handleMenuKeys(event, surface.current);
            }}
          >
            {PRIMARY_MODES.map((mode) => (
              <PlaybackModeOption
                key={mode}
                mode={mode}
                label={modeLabel(mode, t)}
                selected={visual === mode}
                onSelect={() => selectPrimary(mode)}
              />
            ))}
            <div className="playback-mode__divider" role="separator" />
            <PlaybackModeOption
              mode="repeat-all"
              label={t('modeRepeatAll')}
              selected={visual === 'repeat-all'}
              advanced
              onSelect={selectRepeatAll}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

function PlaybackModeOption({
  mode,
  label,
  selected,
  advanced = false,
  onSelect,
}: {
  mode: VisualPlaybackMode;
  label: string;
  selected: boolean;
  advanced?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('player');
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className="playback-mode__option"
      data-selected={selected || undefined}
      data-advanced={advanced || undefined}
      data-mode={mode}
      onClick={onSelect}
    >
      <span className="playback-mode__option-icon">
        <PlaybackModeGlyph mode={mode} />
      </span>
      <span className="playback-mode__option-copy">
        <span>{label}</span>
        {advanced ? <small>{t('modeRepeatAllHint')}</small> : null}
      </span>
      {selected ? (
        <span className="playback-mode__check">
          <SelectedModeMark />
        </span>
      ) : (
        <span className="playback-mode__check" aria-hidden="true" />
      )}
    </button>
  );
}

function modeLabel(
  mode: VisualPlaybackMode,
  t: (key: 'modeSequential' | 'modeShuffle' | 'modeRepeatOne' | 'modeRepeatAll') => string,
): string {
  if (mode === 'shuffle') return t('modeShuffle');
  if (mode === 'repeat-one') return t('modeRepeatOne');
  if (mode === 'repeat-all') return t('modeRepeatAll');
  return t('modeSequential');
}

function handleMenuKeys(event: ReactKeyboardEvent<HTMLDivElement>, surface: HTMLDivElement | null) {
  if (!surface) return;
  const items = [...surface.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (items.length === 0) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(index + delta + items.length) % items.length];
    next?.focus();
  }
  if (event.key === 'Home') {
    event.preventDefault();
    items[0]?.focus();
  }
  if (event.key === 'End') {
    event.preventDefault();
    items[items.length - 1]?.focus();
  }
}
