import { parseYaqmcDeepLink, type CatalogSongDeepLink } from './deep-link';

const MAX_CLIPBOARD_CANDIDATE_CHARS = 2_048;

type ClipboardDeepLinkMonitorDeps = {
  readText: () => string;
  accept: (target: CatalogSongDeepLink) => void;
};

class ClipboardDeepLinkTracker {
  #initialized = false;
  #lastCandidate: string | null = null;
  readonly #consumedTargets = new Set<string>();

  baseline(value: string): void {
    this.#initialized = true;
    this.#lastCandidate = clipboardCandidate(value);
  }

  noteSelfWrite(value: string): void {
    const target = parseCandidate(value);
    if (!target) return;
    this.#initialized = true;
    this.#lastCandidate = value;
    this.#consumedTargets.add(targetKey(target));
  }

  observe(value: string): CatalogSongDeepLink | null {
    const candidate = clipboardCandidate(value);
    if (!this.#initialized) {
      this.#initialized = true;
      this.#lastCandidate = candidate;
      return null;
    }
    if (candidate === this.#lastCandidate) return null;
    this.#lastCandidate = candidate;
    if (!candidate) return null;

    const target = parseCandidate(candidate);
    if (!target) return null;
    const key = targetKey(target);
    if (this.#consumedTargets.has(key)) return null;
    this.#consumedTargets.add(key);
    return target;
  }
}

export function createClipboardDeepLinkMonitor(deps: ClipboardDeepLinkMonitorDeps): {
  setEnabled: (enabled: boolean) => void;
  setFocused: (focused: boolean) => void;
  noteSelfWrite: (value: string) => void;
} {
  const tracker = new ClipboardDeepLinkTracker();
  let enabled = false;
  let focused = false;
  let baselineRequired = true;

  const inspectOnFocus = (): void => {
    if (!enabled || !focused) return;
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
    const target = tracker.observe(value);
    if (!target) return;
    try {
      deps.accept(target);
    } catch {
      // Clipboard fallback must never destabilize the Electron main process.
    }
  };

  return {
    setEnabled: (nextEnabled) => {
      if (enabled === nextEnabled) return;
      enabled = nextEnabled;
      baselineRequired = true;
      if (enabled && focused) inspectOnFocus();
    },
    setFocused: (nextFocused) => {
      if (focused === nextFocused) return;
      focused = nextFocused;
      if (focused && enabled) inspectOnFocus();
    },
    noteSelfWrite: (value) => tracker.noteSelfWrite(value),
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

function targetKey(target: CatalogSongDeepLink): string {
  return `${target.providerId}\u0000${target.entityId}`;
}
