import { getCurrentWindow } from '@tauri-apps/api/window';
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
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ThemePreference } from '../application/use-theme';
import { isNativeRuntime } from '../application/native-player-runtime';
import { IconButton } from './ui/IconButton';

interface TopBarProps {
  canGoBack: boolean;
  canGoForward: boolean;
  theme: ThemePreference;
  onBack: () => void;
  onForward: () => void;
  onSearch: () => void;
  onToggleTheme: () => void;
}

export function TopBar({
  canGoBack,
  canGoForward,
  theme,
  onBack,
  onForward,
  onSearch,
  onToggleTheme,
}: TopBarProps) {
  const { t } = useTranslation('navigation');
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isNativeRuntime) return;
    let active = true;
    const appWindow = getCurrentWindow();
    void appWindow.isMaximized().then((value) => {
      if (active) setMaximized(value);
    });
    let stop: (() => void) | null = null;
    void appWindow
      .onResized(async () => {
        if (active) setMaximized(await appWindow.isMaximized());
      })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  const minimize = () => void getCurrentWindow().minimize();
  const toggleMaximize = () => void getCurrentWindow().toggleMaximize();
  const close = () => void getCurrentWindow().close();

  return (
    <header className="topbar">
      <span
        className="topbar__drag"
        aria-hidden="true"
        data-tauri-drag-region={isNativeRuntime || undefined}
      />
      <div className="topbar__history">
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
      <div className="topbar__tools">
        <button type="button" className="search-trigger" onClick={onSearch}>
          <Search size={15} />
          <span>{t('searchShortcut')}</span>
          <kbd>Ctrl K</kbd>
        </button>
        <IconButton
          label={theme === 'dark' ? t('useLightTheme') : t('useDarkTheme')}
          size="small"
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>
        {isNativeRuntime && (
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
