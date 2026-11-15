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
const cancellableRequestCommand: Partial<Record<MethodName, string>> = {
  provider_comments: 'provider_comments_cancel',
  provider_lyrics: 'provider_comments_cancel',
  qqmusic_lyrics: 'provider_comments_cancel',
  provider_search: 'provider_search_cancel',
  qqmusic_search: 'provider_search_cancel',
};

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
    const cancelCommand = cancellableRequestCommand[command];
    if (cancelCommand && signal && args) {
      const requestId = crypto.randomUUID();
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(abortError());
          const invoke = client.invoke as (
            method: string,
            args: Record<string, unknown>,
          ) => Promise<unknown>;
          void invoke(cancelCommand, {
            providerId: (args.providerId as string | undefined) ?? 'qqmusic',
            profileId: args.profileId as string | undefined,
            requestId,
          }).catch(() => undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const result = client.invoke(command, { ...args, requestId } as never);
        return (await Promise.race([result, cancelled])) as T;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
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
