import { useEffect, useRef, useState } from 'react';

export type EntityDetailStatus = 'loading' | 'ready' | 'error';

export interface EntityDetailResource<T> {
  status: EntityDetailStatus;
  data: T | null;
  error: Error | null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function useEntityDetail<T>(
  id: string,
  load: (id: string, signal: AbortSignal) => Promise<T>,
  preview?: T,
): EntityDetailResource<T> {
  const requestVersion = useRef(0);
  const [resource, setResource] = useState<EntityDetailResource<T>>({
    status: 'loading',
    data: preview ?? null,
    error: null,
  });

  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setResource({ status: 'loading', data: preview ?? null, error: null });
    });

    void load(id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setResource({ status: 'ready', data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setResource({ status: 'error', data: preview ?? null, error: asError(error) });
      });

    return () => {
      controller.abort();
      if (requestVersion.current === version) requestVersion.current += 1;
    };
  }, [id, load, preview]);

  return resource;
}
