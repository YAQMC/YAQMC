import { GripVertical, MoreHorizontal, Play, Trash2, X } from 'lucide-react';
import { useCurrentSong, usePlayerStore } from '../application/player-store';
import { formatDuration, joinArtistNames } from '../utils/format';
import { Artwork } from './ui/Artwork';
import { IconButton } from './ui/IconButton';
import { useTranslation } from 'react-i18next';

export function QueuePanel() {
  const { t } = useTranslation('queue');
  const { t: common } = useTranslation('common');
  const current = useCurrentSong();
  const queue = usePlayerStore((state) => state.queue);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const queueOpen = usePlayerStore((state) => state.queueOpen);
  const playFromQueue = usePlayerStore((state) => state.playFromQueue);
  const removeFromQueue = usePlayerStore((state) => state.removeFromQueue);
  const closePanels = usePlayerStore((state) => state.closePanels);

  if (!queueOpen) return null;

  const upNext = queue.slice(currentIndex + 1);

  return (
    <>
      <button className="panel-scrim" type="button" onClick={closePanels} aria-label={t('close')} />
      <aside className="context-panel" aria-label={t('region')}>
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
            <div className="queue-now__track">
              <Artwork artwork={current.artwork} />
              <div>
                <strong>{current.title}</strong>
                <span>{joinArtistNames(current.artists)}</span>
              </div>
              <MoreHorizontal size={17} />
            </div>
          </section>
        )}

        <section className="queue-next">
          <p className="context-panel__label">{t('upNext')}</p>
          {upNext.length === 0 ? (
            <p className="queue-empty">{t('empty')}</p>
          ) : (
            <div className="queue-list">
              {upNext.map((track, offset) => {
                const queueIndex = currentIndex + offset + 1;
                return (
                  <div className="queue-row" key={`${track.id}-${queueIndex}`}>
                    <GripVertical className="queue-row__grip" size={14} />
                    <button
                      type="button"
                      className="queue-row__main"
                      onClick={() => playFromQueue(queueIndex)}
                    >
                      <span className="queue-row__play">
                        <Play size={12} fill="currentColor" />
                      </span>
                      <span>
                        <strong>{track.title}</strong>
                        <small>{joinArtistNames(track.artists)}</small>
                      </span>
                    </button>
                    <span className="queue-row__duration">{formatDuration(track.durationMs)}</span>
                    <IconButton
                      label={t('remove', { title: track.title })}
                      size="small"
                      onClick={() => removeFromQueue(queueIndex)}
                    >
                      <Trash2 size={14} />
                    </IconButton>
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
