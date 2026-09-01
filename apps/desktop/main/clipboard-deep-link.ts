import { parseYaqmcDeepLink, type CatalogSongDeepLink } from './deep-link';

export const CLIPBOARD_DEEP_LINK_POLL_INTERVAL_MS = 1_000;
export const SELF_SHARE_SUPPRESSION_MS = 5_000;

const MAX_CLIPBOARD_CANDIDATE_CHARS = 2_048;

type ClipboardDeepLinkMonitorDeps = {
  readText: () => string;
  enabled: () => boolean;
  accept: (target: CatalogSongDeepLink) => void;
  now?: () => number;
  pollIntervalMs?: number;
};

class ClipboardDeepLinkTracker {
  #initialized = false;
  #lastCandidate: string | null = null;
  #selfWrite: { value: string; expiresAt: number } | null = null;

  noteSelfWrite(value: string, now = Date.now()): void {
    if (!parseCandidate(value)) return;
    this.#initialized = true;
    this.#lastCandidate = value;
    this.#selfWrite = { value, expiresAt: now + SELF_SHARE_SUPPRESSION_MS };
  }

  observe(value: string, now = Date.now()): CatalogSongDeepLink | null {
    const candidate = clipboardCandidate(value);
    if (!this.#initialized) {
      this.#initialized = true;
      this.#lastCandidate = candidate;
      return null;
    }
    if (candidate === this.#lastCandidate) return null;
    this.#lastCandidate = candidate;
    if (!candidate) return null;

    const selfWrite = this.#selfWrite;
    if (selfWrite && now >= selfWrite.expiresAt) {
      this.#selfWrite = null;
    } else if (selfWrite?.value === candidate) {
      return null;
    }
    return parseCandidate(candidate);
  }
}

export function createClipboardDeepLinkMonitor(deps: ClipboardDeepLinkMonitorDeps): {
  start: () => void;
  stop: () => void;
  noteSelfWrite: (value: string) => void;
} {
  const tracker = new ClipboardDeepLinkTracker();
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? CLIPBOARD_DEEP_LINK_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;

  const poll = (): void => {
    let value: string;
    try {
      value = deps.readText();
    } catch {
      return;
    }
    const target = tracker.observe(value, now());
    if (!target) return;
    try {
      if (deps.enabled()) deps.accept(target);
    } catch {
      // Clipboard fallback must never destabilize the Electron main process.
    }
  };

  return {
    start: () => {
      if (timer) return;
      poll();
      timer = setInterval(poll, pollIntervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
    noteSelfWrite: (value) => tracker.noteSelfWrite(value, now()),
  };
}

function clipboardCandidate(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_CLIPBOARD_CANDIDATE_CHARS ||
    !value.toLowerCase().startsWith('yaqmc:')
  ) {
    return null;
  }
  return value;
}

function parseCandidate(value: string): CatalogSongDeepLink | null {
  return clipboardCandidate(value) ? parseYaqmcDeepLink(value) : null;
}
