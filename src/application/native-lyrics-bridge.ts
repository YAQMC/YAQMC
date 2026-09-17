import type { RenderLyricLine } from './lyrics-render-model';

export interface NativeLyricsBounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface NativeLyricsOptions {
  align: string;
  followAnchor: number;
  enableSpring: boolean;
  enableScale: boolean;
  enableBlur: boolean;
  hidePassedLines: boolean;
  wordFadeWidth: number;
}

interface CapacitorYaqmcNativePlugin {
  invoke(options: { method: string; params?: unknown }): Promise<{ value: unknown }>;
  addListener(
    event: string,
    listener: (payload: Record<string, unknown>) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

interface GlobalWithCapacitor {
  Capacitor?: {
    Plugins?: {
      YaqmcNative?: CapacitorYaqmcNativePlugin;
    };
  };
}

function getCapacitorPlugin(): CapacitorYaqmcNativePlugin | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const root = globalThis as unknown as GlobalWithCapacitor;
  return root.Capacitor?.Plugins?.YaqmcNative;
}

export async function showNativeLyrics(
  bounds: NativeLyricsBounds | null,
  lines: RenderLyricLine[],
  options: NativeLyricsOptions,
): Promise<void> {
  const plugin = getCapacitorPlugin();
  if (!plugin) return;
  await plugin.invoke({
    method: 'lyrics_show',
    params: { bounds, lines, options },
  });
}

export async function hideNativeLyrics(): Promise<void> {
  const plugin = getCapacitorPlugin();
  if (!plugin) return;
  await plugin.invoke({
    method: 'lyrics_hide',
  });
}

export function onNativeLyricsSeek(callback: (positionMs: number) => void): () => void {
  const plugin = getCapacitorPlugin();
  if (!plugin) return () => {};
  let removed = false;
  let handle: { remove: () => Promise<void> } | null = null;

  void plugin
    .addListener('lyricsSeek', (event) => {
      const pos = event.positionMs;
      if (typeof pos === 'number') {
        callback(pos);
      }
    })
    .then((h) => {
      if (removed) {
        void h.remove();
      } else {
        handle = h;
      }
    });

  return () => {
    removed = true;
    void handle?.remove();
  };
}
