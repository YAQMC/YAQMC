import type { MethodName } from '@yaqmc/client';
import { getYaqmcClient } from '../../application/yaqmc-runtime';
import { PROVIDER_ERROR_CODES, ProviderError, type ProviderErrorCode } from '../../domain/music';

interface NativeProviderError {
  code?: string;
  message?: string;
  retryable?: boolean;
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
  if (
    value &&
    typeof value === 'object' &&
    typeof value.code === 'string' &&
    providerErrorCodes.has(value.code as ProviderErrorCode)
  ) {
    return new ProviderError(
      value.code as ProviderErrorCode,
      typeof value.message === 'string' ? value.message : `${displayName} request failed.`,
      Boolean(value.retryable),
    );
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
