import { useCallback, useEffect, useState } from 'react';
import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

const client = getYaqmcClient();

export type LocalApiRunState = 'disabled' | 'starting' | 'running' | 'error';

export interface LocalApiStatus {
  enabled: boolean;
  state: LocalApiRunState;
  host: '127.0.0.1';
  configuredPort: number;
  boundPort: number | null;
  tokenConfigured: boolean;
  lastError: string | null;
}

interface LocalApiSettings {
  available: boolean;
  status: LocalApiStatus | null;
  token: string | null;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setPort: (port: number) => Promise<void>;
  revealToken: () => Promise<void>;
  hideToken: () => void;
  regenerateToken: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLocalApiSettings(): LocalApiSettings {
  const [status, setStatus] = useState<LocalApiStatus | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await operation();
    } catch (caught) {
      setError(errorMessage(caught));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!isNativeRuntime) return;
    const next = await run(() => client.invoke('local_api_status'));
    if (next) setStatus(next);
  }, [run]);

  useEffect(() => {
    if (!isNativeRuntime) return;
    let active = true;
    void client
      .invoke('local_api_status')
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      });
    return () => {
      active = false;
    };
  }, []);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const next = await run(() => client.invoke('local_api_set_enabled', { enabled }));
      if (next) setStatus(next);
      else await refresh();
    },
    [refresh, run],
  );

  const setPort = useCallback(
    async (port: number) => {
      const next = await run(() => client.invoke('local_api_set_port', { port }));
      if (next) setStatus(next);
      else await refresh();
    },
    [refresh, run],
  );

  const revealToken = useCallback(async () => {
    const revealed = await run(() => client.invoke('local_api_reveal_token'));
    if (revealed) setToken(revealed);
  }, [run]);

  const regenerateToken = useCallback(async () => {
    const next = await run(() => client.invoke('local_api_regenerate_token'));
    if (next) {
      setStatus(next);
      setToken(null);
    } else await refresh();
  }, [refresh, run]);

  return {
    available: isNativeRuntime,
    status,
    token,
    busy,
    error,
    refresh,
    setEnabled,
    setPort,
    revealToken,
    hideToken: () => setToken(null),
    regenerateToken,
  };
}
