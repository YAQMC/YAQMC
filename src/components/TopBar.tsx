import { ChevronLeft, ChevronRight, Moon, Search, Sun } from 'lucide-react';
import type { ThemePreference } from '../application/use-theme';
import { IconButton } from './ui/IconButton';
import { useTranslation } from 'react-i18next';

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
  return (
    <header className="topbar">
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
      </div>
    </header>
  );
}
