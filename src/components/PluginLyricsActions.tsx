import { Info, Maximize2, Minus, Music, Settings, X } from 'lucide-react';
import { usePluginUiSnapshot, pluginLyricsActions } from '../application/plugin-ui';
import { dispatchPluginUiAction } from '../application/plugin-runtime';
import { supportsWindowControls } from '../application/host-capabilities';
import { getYaqmcClient } from '../application/yaqmc-runtime';
import { logger } from '../application/logger';
import { IconButton } from './ui/IconButton';

const icons = {
  minus: Minus,
  maximize: Maximize2,
  close: X,
  settings: Settings,
  info: Info,
  music: Music,
};

export function PluginLyricsActions({
  includeWindowActions = true,
}: { includeWindowActions?: boolean } = {}) {
  const { lyrics } = usePluginUiSnapshot();
  return lyrics
    .filter((action) => !action.windowAction || (includeWindowActions && supportsWindowControls()))
    .map((action) => {
      const icon =
        action.icon ??
        (action.windowAction === 'minimize'
          ? 'minus'
          : action.windowAction === 'toggleMaximize'
            ? 'maximize'
            : action.windowAction === 'close'
              ? 'close'
              : 'music');
      const Icon = icons[icon as keyof typeof icons] ?? Music;
      return (
        <IconButton
          key={`${action.pluginId}/${action.id}`}
          label={action.label}
          title={`${action.label} · ${action.pluginName}`}
          size="large"
          className="yaqmc-no-drag"
          data-plugin-id={action.pluginId}
          onClick={() => {
            // Resolve the current registration again so a retired button cannot perform an action.
            const current = pluginLyricsActions().find(
              (item) => item.pluginId === action.pluginId && item.id === action.id,
            );
            if (!current) return;
            if (current.windowAction) {
              const windowHost = getYaqmcClient().host.window;
              if (!supportsWindowControls() || !windowHost) return;
              void windowHost[current.windowAction]().catch((error: unknown) =>
                logger.error('plugin.lyrics.window_failed', error),
              );
            } else dispatchPluginUiAction(current.pluginId, current.id, 'lyrics');
          }}
        >
          <Icon size={18} />
        </IconButton>
      );
    });
}
