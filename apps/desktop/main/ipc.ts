import type { CoreError } from '@yaqmc/client';
import { CoreInvokeError } from './core/client';
import { ProtocolError } from './core/frames';

export const INVOKE_CHANNEL = 'yaqmc:invoke';
export const EVENT_CHANNEL = 'yaqmc:event';

export type InvokeRequest = {
  method: string;
  params?: unknown;
};

export type InvokeReply =
  | { ok: true; result: unknown }
  | { ok: false; error: CoreError };

export type InvokeTarget = {
  invoke(method: string, params?: unknown, origin?: string): Promise<unknown>;
};

export async function handleRendererInvoke(
  client: InvokeTarget | undefined,
  request: InvokeRequest | undefined,
  origin?: string,
): Promise<InvokeReply> {
  const method = request?.method;
  const params = request?.params;
  if (typeof method !== 'string' || method.length === 0) {
    return {
      ok: false,
      error: { code: 'core.protocol', message: 'missing method', retryable: false },
    };
  }
  if (!client) {
    return {
      ok: false,
      error: {
        code: 'core.unavailable',
        message: 'core supervisor is not running',
        retryable: true,
      },
    };
  }
  try {
    const result = await client.invoke(method, params, origin);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: toCoreError(error) };
  }
}

export function toCoreError(error: unknown): CoreError {
  if (error instanceof CoreInvokeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof ProtocolError) {
    return { code: 'core.protocol', message: error.message, retryable: false };
  }
  if (error instanceof Error) {
    return { code: 'core.unavailable', message: error.message, retryable: true };
  }
  return { code: 'core.protocol', message: String(error), retryable: false };
}
