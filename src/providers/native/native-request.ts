import type { MethodName } from '@yaqmc/client';
import { getYaqmcClient } from '../../application/yaqmc-runtime';
import { PROVIDER_ERROR_CODES, ProviderError, type ProviderErrorCode } from '../../domain/music';

interface NativeProviderError {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
  data?: unknown;
}

const providerErrorCodes = new Set<ProviderErrorCode>(PROVIDER_ERROR_CODES);

function abortError(): DOMException {
  return new DOMException('The provider request was cancelled.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function normalizeProviderError(error: unknown, displayName: string): ProviderError {
  const value = error as NativeProviderError | null;
  if (value && typeof value === 'object') {
    const data = value.data as NativeProviderError | null;
    const candidates: unknown[] = [value, value.details, data, data?.details];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const providerError = candidate as NativeProviderError;
      if (
        typeof providerError.code !== 'string' ||
        !providerErrorCodes.has(providerError.code as ProviderErrorCode)
      ) {
        continue;
      }
      return new ProviderError(
        providerError.code as ProviderErrorCode,
        typeof providerError.message === 'string'
          ? providerError.message
          : `${displayName} request failed.`,
        Boolean(providerError.retryable),
      );
    }
  }
  return new ProviderError('provider-failure', `${displayName} request failed.`, false);
}

export async function nativeProviderRequest<T>(
  command: MethodName,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  displayName = 'Music provider',
): Promise<T> {
  throwIfAborted(signal);
  try {
    const client = getYaqmcClient();
    const result = (await (args === undefined
      ? client.invoke(command)
      : client.invoke(command, args as never))) as T;
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw normalizeProviderError(error, displayName);
  }
}
