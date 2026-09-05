import { useEffect, useState } from 'react';
import { isAndroidRuntime } from './host-capabilities';

// Layout only. Never use this query to choose or restart an authorization protocol.
export const COMPACT_PLAYER_QUERY =
  '(orientation: portrait) and (max-width: 959px), (orientation: landscape) and (max-height: 599px)';

export function useCompactPlayerLayout(): boolean {
  const android = isAndroidRuntime();
  const [compact, setCompact] = useState(() =>
    android && typeof window.matchMedia === 'function'
      ? window.matchMedia(COMPACT_PLAYER_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (!android || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_PLAYER_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [android]);
  return compact;
}
