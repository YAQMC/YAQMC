import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHANNEL_API_EVENT,
  type StatisticsExportFormat,
  type StatisticsExportResult,
  type StatisticsRange,
  type StatisticsSnapshot,
} from '@yaqmc/client';
import { getYaqmcClient } from './yaqmc-runtime';

const EVENT_REFRESH_DELAY_MS = 250;

export type StatisticsResource =
  | { status: 'loading'; data: StatisticsSnapshot | null; error: null }
  | { status: 'ready'; data: StatisticsSnapshot; error: null }
  | { status: 'error'; data: StatisticsSnapshot | null; error: string };

export function useStatisticsRuntime(range: StatisticsRange) {
  const client = getYaqmcClient();
  const [resource, setResource] = useState<StatisticsResource>({
    status: 'loading',
    data: null,
    error: null,
  });
  const generation = useRef(0);
  const eventTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRevision = useRef(0);

  const refresh = useCallback(
    async (quiet = false): Promise<StatisticsSnapshot | null> => {
      const requestGeneration = ++generation.current;
      if (!quiet) {
        setResource((current) => ({ status: 'loading', data: current.data, error: null }));
      }
      try {
        const snapshot = await client.statistics.snapshot(range);
        if (generation.current !== requestGeneration) return null;
        setResource({ status: 'ready', data: snapshot, error: null });
        return snapshot;
      } catch (error) {
        if (generation.current !== requestGeneration) return null;
        setResource((current) => ({
          status: 'error',
          data: current.data,
          error: error instanceof Error ? error.message : String(error),
        }));
        return null;
      }
    },
    [client, range],
  );

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const stop = client.on(CHANNEL_API_EVENT, (event) => {
      if (event.type !== 'statistics.changed') return;
      const revision =
        event.data && typeof event.data === 'object' && 'revision' in event.data
          ? Number((event.data as { revision?: unknown }).revision)
          : 0;
      if (!Number.isSafeInteger(revision) || revision <= latestRevision.current) return;
      latestRevision.current = revision;
      if (eventTimer.current !== null) clearTimeout(eventTimer.current);
      eventTimer.current = setTimeout(() => {
        eventTimer.current = null;
        void refresh(true);
      }, EVENT_REFRESH_DELAY_MS);
    });
    return () => {
      stop();
      if (eventTimer.current !== null) clearTimeout(eventTimer.current);
      eventTimer.current = null;
    };
  }, [client, refresh]);

  const exportData = useCallback(
    (format: StatisticsExportFormat): Promise<StatisticsExportResult | null> =>
      client.statistics.export(range, format),
    [client, range],
  );

  const clear = useCallback(async () => {
    const result = await client.statistics.clear();
    latestRevision.current = Math.max(latestRevision.current, result.revision);
    if (eventTimer.current !== null) clearTimeout(eventTimer.current);
    eventTimer.current = null;
    await refresh(true);
    return result;
  }, [client, refresh]);

  return { resource, refresh, exportData, clear };
}
