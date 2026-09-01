import { parseYaqmcDeepLink, type CatalogSongDeepLink } from './deep-link';

export const CLIPBOARD_DEEP_LINK_POLL_INTERVAL_MS = 1_000;
export const SELF_SHARE_SUPPRESSION_MS = 5_000;

const MAX_CLIPBOARD_CANDIDATE_CHARS = 2_048;

type ClipboardDeepLinkMonitorDeps = {
  readText: () => string;
  accept: (target: CatalogSongDeepLink) => void;
  now?: () => number;
  pollIntervalMs?: number;
};

class ClipboardDeepLinkTracker {
  #initialized = false;
  #lastCandidate: string | null = null;
  #selfWrite: { value: string; expiresAt: number } | null = null;

  baseline(value: string): void {
    this.#initialized = true;
    this.#lastCandidate = clipboardCandidate(value);
  }

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
  setActive: (active: boolean) => void;
  noteSelfWrite: (value: string) => void;
} {
  const tracker = new ClipboardDeepLinkTracker();
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? CLIPBOARD_DEEP_LINK_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let active = false;
  let baselineRequired = true;

  const poll = (): void => {
    if (!started || !active) return;
    let value: string;
    try {
      value = deps.readText();
    } catch {
      return;
    }
    if (baselineRequired) {
      tracker.baseline(value);
      baselineRequired = false;
      return;
    }
    const target = tracker.observe(value, now());
    if (!target) return;
    try {
      deps.accept(target);
    } catch {
      // Clipboard fallback must never destabilize the Electron main process.
    }
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      timer = setInterval(poll, pollIntervalMs);
      timer.unref?.();
      poll();
    },
    stop: () => {
      if (!started) return;
      started = false;
      active = false;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      baselineRequired = true;
    },
    setActive: (nextActive) => {
      if (active === nextActive) return;
      active = nextActive;
      baselineRequired = true;
      if (active) poll();
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
