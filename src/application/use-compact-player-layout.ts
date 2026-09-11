import { useEffect, useState } from 'react';
import { isAndroidRuntime } from './host-capabilities';

// Layout only. Never use this query to choose or restart an authorization protocol.
export const COMPACT_PLAYER_QUERY =
  '(orientation: portrait) and (max-width: 959px), (orientation: landscape) and (max-height: 599px)';

export function useCompactPlayerLayout(allHosts = false): boolean {
  const enabled = allHosts || isAndroidRuntime();
  const [compact, setCompact] = useState(() =>
    enabled && typeof window.matchMedia === 'function'
      ? window.matchMedia(COMPACT_PLAYER_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (!enabled || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_PLAYER_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [enabled]);
  return compact;
}
