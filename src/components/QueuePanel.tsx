import { GripVertical, Play, X } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { usePlayerStore, type QueueEntry } from '../application/player-store';
import { useMusicProviderAvailability } from '../application/provider-context';
import type { Song } from '../domain/music';
import { formatDuration } from '../utils/format';
import { useAddToPlaylistPicker } from './AddToPlaylistPicker';
import { Artwork } from './ui/Artwork';
import { ActionMenu, ActionMenuItem } from './ui/ActionMenu';
import { IconButton } from './ui/IconButton';
import { useTranslation } from 'react-i18next';
import { EntityLink } from './EntityLink';

interface PointerDrag {
  entryId: string;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  targetId: string | null;
}

function legacyEntries(queue: QueueEntry['track'][]): QueueEntry[] {
  return queue.map((track, index) => ({ id: `legacy:${index}:${track.id}`, track }));
}

function QueueNowPlayingMenu({ track, available }: { track: Song; available: boolean }) {
  const { t } = useTranslation('queue');
  const addToPlaylist = useAddToPlaylistPicker(track);
  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={menuRef}>
      <ActionMenu label={t('moreActions', { title: track.title })} size="small">
        <ActionMenuItem disabled onClick={() => undefined}>
          {t('currentItem')}
        </ActionMenuItem>
        <ActionMenuItem
          disabled={!available || !addToPlaylist.available}
          onClick={() => {
            const bounds = menuRef.current?.getBoundingClientRect();
            addToPlaylist.openAt({
              x: bounds ? Math.min(bounds.right, window.innerWidth - 16) : 24,
              y: bounds ? bounds.bottom + 6 : 24,
            });
          }}
        >
          {addToPlaylist.label}
        </ActionMenuItem>
      </ActionMenu>
      {addToPlaylist.menu}
    </div>
  );
}

function QueueEntryOverflow({
  entry,
  onPlayNow,
  onPlayNext,
  onRemove,
  available,
}: {
  entry: QueueEntry;
  onPlayNow: () => void;
  onPlayNext: () => void;
  onRemove: () => void;
  available: boolean;
}) {
  const { t } = useTranslation('queue');
  const addToPlaylist = useAddToPlaylistPicker(entry.track);
  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={menuRef}>
      <ActionMenu label={t('moreActions', { title: entry.track.title })} size="small">
        <ActionMenuItem disabled={!available} onClick={onPlayNow}>
          {t('playNow')}
        </ActionMenuItem>
        <ActionMenuItem disabled={!available} onClick={onPlayNext}>
          {t('playNext')}
        </ActionMenuItem>
        <ActionMenuItem
          disabled={!available || !addToPlaylist.available}
          onClick={() => {
            const bounds = menuRef.current?.getBoundingClientRect();
            addToPlaylist.openAt({
              x: bounds ? Math.min(bounds.right, window.innerWidth - 16) : 24,
              y: bounds ? bounds.bottom + 6 : 24,
            });
          }}
        >
          {addToPlaylist.label}
        </ActionMenuItem>
        <ActionMenuItem onClick={onRemove}>{t('removeAction')}</ActionMenuItem>
      </ActionMenu>
      {addToPlaylist.menu}
    </div>
  );
}

export function QueuePanel() {
  const { t } = useTranslation('queue');
  const { t: common } = useTranslation('common');
  const providerAvailable = useMusicProviderAvailability();
  const queue = usePlayerStore((state) => state.queue);
  const authoritativeEntries = usePlayerStore((state) => state.queueEntries);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const currentQueueEntryId = usePlayerStore((state) => state.currentQueueEntryId);
  const upcomingQueueEntryIds = usePlayerStore((state) => state.upcomingQueueEntryIds);
  const playbackOrder = usePlayerStore((state) => state.playbackOrder);
  const repeat = usePlayerStore((state) => state.repeat);
  const queueOpen = usePlayerStore((state) => state.queueOpen);
  const playQueueEntry = usePlayerStore((state) => state.playQueueEntry);
  const playNextQueueEntry = usePlayerStore((state) => state.playNextQueueEntry);
  const removeQueueEntry = usePlayerStore((state) => state.removeQueueEntry);
  const reorderQueueEntry = usePlayerStore((state) => state.reorderQueueEntry);
  const closePanels = usePlayerStore((state) => state.closePanels);
  const entries =
    authoritativeEntries.length === queue.length ? authoritativeEntries : legacyEntries(queue);
  const hasAuthoritativeTraversal =
    authoritativeEntries.length === queue.length &&
    (authoritativeEntries.length === 0 || currentQueueEntryId !== null);
  const currentId = currentQueueEntryId ?? entries[currentIndex]?.id ?? null;
  const current = entries.find((entry) => entry.id === currentId) ?? null;
  const currentAvailable = current ? providerAvailable(current.track.provider?.providerId) : false;
  const fallbackUpcoming = entries.slice(Math.max(0, currentIndex + 1)).map((entry) => entry.id);
  const visibleUpcomingIds = hasAuthoritativeTraversal ? upcomingQueueEntryIds : fallbackUpcoming;
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const upNext = visibleUpcomingIds.flatMap((id) => {
    const entry = entriesById.get(id);
    return entry ? [entry] : [];
  });
  const drag = useRef<PointerDrag | null>(null);
  const [draggedEntryId, setDraggedEntryId] = useState<string | null>(null);
  const [dropTargetEntryId, setDropTargetEntryId] = useState<string | null>(null);

  useEffect(() => {
    const clearDrag = () => {
      drag.current = null;
      setDraggedEntryId(null);
      setDropTargetEntryId(null);
    };
    const move = (event: PointerEvent) => {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      if (
        !active.started &&
        Math.hypot(event.clientX - active.startX, event.clientY - active.startY) >= 4
      ) {
        active.started = true;
        setDraggedEntryId(active.entryId);
      }
      if (!active.started) return;
      event.preventDefault();
      const row = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-queue-entry-id]');
      const targetId = row?.dataset.queueEntryId ?? null;
      active.targetId = targetId;
      setDropTargetEntryId(targetId);
    };
    const end = (event: PointerEvent) => {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      if (active.started && active.targetId && active.targetId !== active.entryId) {
        const targetIndex = entries.findIndex((entry) => entry.id === active.targetId);
        if (targetIndex >= 0) reorderQueueEntry(active.entryId, targetIndex);
      }
      clearDrag();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', clearDrag);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', clearDrag);
    };
  }, [entries, reorderQueueEntry]);

  if (!queueOpen) return null;

  const beginDrag = (entryId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = {
      entryId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      targetId: entryId,
    };
  };

  const moveWithKeyboard = (entryId: string, direction: -1 | 1) => {
    const index = entries.findIndex((entry) => entry.id === entryId);
    const targetIndex = index + direction;
    if (index >= 0 && targetIndex >= 0 && targetIndex < entries.length) {
      reorderQueueEntry(entryId, targetIndex);
    }
  };

  return (
    <>
      <button className="panel-scrim" type="button" onClick={closePanels} aria-label={t('close')} />
      <aside className="context-panel" aria-label={t('region')} data-yaqmc="queue">
        <header className="context-panel__header">
          <div>
            <p>{t('playingNext')}</p>
            <span>{common('trackCount', { count: upNext.length })}</span>
          </div>
          <IconButton label={t('close')} size="small" onClick={closePanels}>
            <X size={17} />
          </IconButton>
        </header>

        {current && (
          <section className="queue-now">
            <p className="context-panel__label">{t('nowPlaying')}</p>
            <div
              className="queue-now__track"
              data-queue-entry-id={current.id}
              data-provider-unavailable={!currentAvailable || undefined}
            >
              <Artwork artwork={current.track.artwork} purpose="small" />
              <div>
                <EntityLink
                  entity="song"
                  id={currentAvailable ? current.track.id : null}
                  providerId={current.track.provider?.providerId}
                  className="queue-now__title"
                >
                  <strong>{current.track.title}</strong>
                </EntityLink>
                <span className="queue-now__artists">
                  {current.track.artists.map((artist, index) => (
                    <Fragment key={`${artist.id}:${artist.name}:${index}`}>
                      {index > 0 && <span aria-hidden="true">, </span>}
                      <EntityLink
                        entity="artist"
                        id={currentAvailable ? artist.id : null}
                        providerId={current.track.provider?.providerId}
                        className="queue-now__artist"
                      >
                        {artist.name}
                      </EntityLink>
                    </Fragment>
                  ))}
                </span>
                {!currentAvailable && (
                  <span className="queue-provider-unavailable">{t('providerUnavailable')}</span>
                )}
              </div>
              <QueueNowPlayingMenu track={current.track} available={currentAvailable} />
            </div>
          </section>
        )}

        <section className="queue-next">
          <div className="queue-next__heading">
            <p className="context-panel__label">{t('upNext')}</p>
            <div className="queue-next__meta">
              {repeat === 'one' && <span>{t('repeatOneActive')}</span>}
              {playbackOrder === 'shuffle' && <span>{t('shuffleTraversal')}</span>}
            </div>
          </div>
          {upNext.length === 0 ? (
            <p className="queue-empty">{t('empty')}</p>
          ) : (
            <div className="queue-list">
              {upNext.map((entry) => {
                const canonicalIndex = entries.findIndex((candidate) => candidate.id === entry.id);
                const available = providerAvailable(entry.track.provider?.providerId);
                const isDragged = draggedEntryId === entry.id;
                const isDropTarget = dropTargetEntryId === entry.id && draggedEntryId !== entry.id;
                return (
                  <div
                    className="queue-row"
                    key={entry.id}
                    data-queue-entry-id={entry.id}
                    data-dragging={isDragged || undefined}
                    data-drop-target={isDropTarget || undefined}
                    data-provider-unavailable={!available || undefined}
                  >
                    <button
                      type="button"
                      className="queue-row__grip"
                      aria-label={t('move', { title: entry.track.title })}
                      onPointerDown={(event) => beginDrag(entry.id, event)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault();
                          moveWithKeyboard(entry.id, event.key === 'ArrowUp' ? -1 : 1);
                        }
                      }}
                    >
                      <GripVertical size={14} />
                    </button>
                    <button
                      type="button"
                      className="queue-row__play-button"
                      aria-label={`${t('playNow')} ${entry.track.title}`}
                      disabled={!available}
                      onClick={() => playQueueEntry(entry.id)}
                    >
                      <span className="queue-row__play-icon">
                        <Play size={12} fill="currentColor" />
                      </span>
                    </button>
                    <div className="queue-row__main">
                      <EntityLink
                        entity="song"
                        id={available ? entry.track.id : null}
                        providerId={entry.track.provider?.providerId}
                        className="queue-row__title"
                      >
                        <strong>{entry.track.title}</strong>
                      </EntityLink>
                      <small className="queue-row__artists">
                        {entry.track.artists.map((artist, index) => (
                          <Fragment key={`${artist.id}:${artist.name}:${index}`}>
                            {index > 0 && <span aria-hidden="true">, </span>}
                            <EntityLink
                              entity="artist"
                              id={available ? artist.id : null}
                              providerId={entry.track.provider?.providerId}
                              className="queue-row__artist"
                            >
                              {artist.name}
                            </EntityLink>
                          </Fragment>
                        ))}
                      </small>
                      {!available && (
                        <small className="queue-provider-unavailable">
                          {t('providerUnavailable')}
                        </small>
                      )}
                    </div>
                    <span className="queue-row__duration">
                      {formatDuration(entry.track.durationMs)}
                    </span>
                    <QueueEntryOverflow
                      entry={entry}
                      onPlayNow={() => playQueueEntry(entry.id)}
                      onPlayNext={() => playNextQueueEntry(entry.id)}
                      onRemove={() => removeQueueEntry(entry.id)}
                      available={available}
                    />
                    <span className="queue-row__canonical-position" aria-hidden="true">
                      {canonicalIndex + 1}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </aside>
    </>
  );
}
