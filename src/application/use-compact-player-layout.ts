import { useEffect, useState } from 'react';

// Layout only. Never use this query to choose or restart an authorization protocol.
// Mirrors the compact shell blocks in styles/shell.css, including narrow landscape windows.
export const COMPACT_PLAYER_QUERY =
  '(max-width: 599px), (orientation: portrait) and (max-width: 959px), (orientation: landscape) and (max-height: 599px), (orientation: landscape) and (max-width: 839px)';

export function useCompactPlayerLayout(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia(COMPACT_PLAYER_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_PLAYER_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return compact;
}
