import { Maximize2, Minus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supportsWindowControls } from '../application/host-capabilities';
import { getYaqmcClient } from '../application/yaqmc-runtime';
import { logger } from '../application/logger';
import { IconButton } from './ui/IconButton';

export function LyricsWindowControls() {
  const { t } = useTranslation('navigation');
  if (!supportsWindowControls()) return null;

  const run = (command: 'minimize' | 'toggleMaximize' | 'close') => {
    const windowHost = getYaqmcClient().host.window;
    if (!windowHost) return;
    void windowHost[command]().catch((error: unknown) =>
      logger.error('lyrics.window_control_failed', error),
    );
  };

  return (
    <div className="lyrics-stage__window-controls yaqmc-no-drag">
      <IconButton label={t('minimizeWindow')} size="small" onClick={() => run('minimize')}>
        <Minus size={16} />
      </IconButton>
      <IconButton
        label={`${t('maximizeWindow')} / ${t('restoreWindow')}`}
        size="small"
        onClick={() => run('toggleMaximize')}
      >
        <Maximize2 size={15} />
      </IconButton>
      <IconButton
        label={t('closeWindow')}
        size="small"
        className="lyrics-stage__window-close"
        onClick={() => run('close')}
      >
        <X size={16} />
      </IconButton>
    </div>
  );
}
