import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Minus,
  Moon,
  Search,
  Sun,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ThemePreference } from '../application/use-theme';
import { getYaqmcClient } from '../application/yaqmc-runtime';
import { isNativeRuntime } from '../application/native-player-runtime';
import { useAccountIdentity } from '../application/account-identity';
import { AccountAvatar } from './AccountAvatar';
import { IconButton } from './ui/IconButton';

interface TopBarProps {
  canGoBack: boolean;
  canGoForward: boolean;
  theme: ThemePreference;
  onBack: () => void;
  onForward: () => void;
  onSearch: () => void;
  onToggleTheme: () => void;
  onAccount?: () => void;
}

export function TopBar({
  canGoBack,
  canGoForward,
  theme,
  onBack,
  onForward,
  onSearch,
  onToggleTheme,
  onAccount,
}: TopBarProps) {
  const { t } = useTranslation('navigation');
  const accountIdentity = useAccountIdentity();
  const [maximized, setMaximized] = useState(false);
  const windowHost = () => getYaqmcClient().host.window;
  const bridge = getYaqmcClient().bridge;
  const android = bridge?.kind === 'android';
  const windowControls = bridge?.capabilities?.windowControls ?? (isNativeRuntime && !android);

  const minimize = () => void windowHost()?.minimize();
  const toggleMaximize = () => {
    setMaximized((value) => !value);
    void windowHost()?.toggleMaximize();
  };
  const close = () => void windowHost()?.close();

  return (
    <header className="topbar">
      <span
        className={windowControls ? 'topbar__drag yaqmc-drag' : 'topbar__drag'}
        aria-hidden="true"
      />
      <div className="topbar__history yaqmc-no-drag">
        <IconButton label={t('goBack')} size="small" disabled={!canGoBack} onClick={onBack}>
          <ChevronLeft size={18} />
        </IconButton>
        <IconButton
          label={t('goForward')}
          size="small"
          disabled={!canGoForward}
          onClick={onForward}
        >
          <ChevronRight size={18} />
        </IconButton>
      </div>
      <div className="topbar__tools yaqmc-no-drag">
        <button
          type="button"
          className="search-trigger"
          aria-label={t('search')}
          onClick={onSearch}
        >
          <Search size={15} />
          <span>{t('searchShortcut')}</span>
          {!android && <kbd aria-hidden="true">Ctrl K</kbd>}
        </button>
        <IconButton
          label={theme === 'dark' ? t('useLightTheme') : t('useDarkTheme')}
          size="small"
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>
        {onAccount && (
          <button
            type="button"
            className="topbar__account"
            aria-label={t('openSettings')}
            title={t('openSettings')}
            data-yaqmc="account-avatar"
            onClick={onAccount}
          >
            <AccountAvatar identity={accountIdentity} className="topbar__account-avatar" />
          </button>
        )}
        {windowControls && (
          <div className="topbar__window-controls">
            <IconButton label={t('minimizeWindow')} size="small" onClick={minimize}>
              <Minus size={15} />
            </IconButton>
            <IconButton
              label={maximized ? t('restoreWindow') : t('maximizeWindow')}
              size="small"
              onClick={toggleMaximize}
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
            <IconButton
              label={t('closeWindow')}
              size="small"
              className="topbar__close"
              onClick={close}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
      </div>
    </header>
  );
}
