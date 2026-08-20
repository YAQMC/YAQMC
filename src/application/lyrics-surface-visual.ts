/** Overlay-document visual clock. Never import from the main-window Fullscreen Lyrics renderer. */

const MAX_CSS_CLOCK_MS = 2_500;

export function surfaceVisualActive(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState === 'hidden') return false;
  if (document.documentElement.dataset.surfaceVisual === 'idle') return false;
  if (document.documentElement.dataset.compositorProbe === 'no-surface-anim') return false;
  return true;
}

export function syncSurfaceVisualDataset(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'hidden') {
    document.documentElement.dataset.surfaceVisual = 'idle';
  }
}

export function subscribeSurfaceVisualActive(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const notify = () => {
    syncSurfaceVisualDataset();
    onChange();
  };
  syncSurfaceVisualDataset();
  document.addEventListener('visibilitychange', notify);
  window.addEventListener('yaqmc-surface-visual', notify);
  return () => {
    document.removeEventListener('visibilitychange', notify);
    window.removeEventListener('yaqmc-surface-visual', notify);
  };
}

export function drivePercentageClock(
  node: HTMLElement | null,
  property: string,
  from01: number,
  remainingMs: number,
): void {
  if (!node) return;
  const from = `${Math.max(0, Math.min(1, from01)) * 100}%`;
  node.style.transition = 'none';
  node.style.setProperty(property, from);
  void node.offsetWidth;
  if (!surfaceVisualActive() || remainingMs <= 16 || remainingMs > MAX_CSS_CLOCK_MS) return;
  node.style.transition = `${property} ${Math.round(remainingMs)}ms linear`;
  node.style.setProperty(property, '100%');
}

export function freezePercentageClock(node: HTMLElement | null, property: string, value01: number): void {
  if (!node) return;
  node.style.transition = 'none';
  node.style.setProperty(property, `${Math.max(0, Math.min(1, value01)) * 100}%`);
}
