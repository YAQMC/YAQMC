import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { Song } from '../domain/music';
import { pluginSongBadgeLabel, usePluginSongBadges } from '../application/plugin-song-badges';

/** Generic presentation only: labels, colors and matching rules come from enabled plugins. */
export function PluginSongBadges({ song }: { song: Pick<Song, 'provider'> }) {
  const { i18n } = useTranslation();
  const badges = usePluginSongBadges(song.provider);
  if (badges.length === 0) return null;
  return (
    <span className="plugin-song-badges">
      {badges.map((badge) => {
        const label = pluginSongBadgeLabel(badge, i18n.language);
        return (
          <span
            key={`${badge.pluginId}/${badge.id}`}
            className="plugin-song-badge"
            data-plugin-id={badge.pluginId}
            title={`${badge.pluginName}: ${label}`}
            style={
              badge.color ? ({ '--plugin-badge-color': badge.color } as CSSProperties) : undefined
            }
          >
            {label}
          </span>
        );
      })}
    </span>
  );
}
