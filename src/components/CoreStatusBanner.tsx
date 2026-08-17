import { useEffect, useState } from 'react';
import type { CoreStatus, CoreStatusPayload } from '@yaqmc/client';

export type CoreStatusSubscribe = (handler: (payload: CoreStatusPayload) => void) => () => void;

const COPY: Record<Exclude<CoreStatus, 'ready'>, string> = {
  down: 'Playback engine is down…',
  restarting: 'Playback engine restarting…',
  'safe-mode': 'Playback engine is in safe mode. Playback will not resume automatically.',
};

function defaultSubscribe(handler: (payload: CoreStatusPayload) => void): () => void {
  const yaqmc = Reflect.get(window, 'yaqmc') as
    | { on?: (channel: string, cb: (payload: unknown) => void) => () => void }
    | undefined;
  if (typeof yaqmc?.on !== 'function') {
    return () => undefined;
  }
  return yaqmc.on('host://core-status', (payload) => {
    if (
      payload !== null &&
      typeof payload === 'object' &&
      'status' in payload &&
      typeof (payload as CoreStatusPayload).status === 'string'
    ) {
      handler(payload as CoreStatusPayload);
    }
  });
}

/**
 * Host-agnostic core-status banner. On Tauri, `host://core-status` never fires
 * and `window.yaqmc` is absent, so this stays inert.
 */
export function CoreStatusBanner({
  subscribe = defaultSubscribe,
}: {
  subscribe?: CoreStatusSubscribe;
} = {}) {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  useEffect(() => subscribe((payload) => setStatus(payload.status)), [subscribe]);
  if (!status || status === 'ready') {
    return null;
  }
  return (
    <div className="core-status-banner" data-status={status} role="status">
      {COPY[status]}
    </div>
  );
}
