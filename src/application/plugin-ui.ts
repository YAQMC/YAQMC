import { useEffect, useState } from 'react';
import { clearPluginPageContributions } from './plugin-pages';

export interface PluginUiContribution {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  icon?: string;
}

export interface PluginLyricsContribution extends PluginUiContribution {
  windowAction?: 'minimize' | 'toggleMaximize' | 'close';
}

export function isPluginLyricsMethod(method: string): boolean {
  return method === 'ui.lyrics.register' || method === 'ui.lyrics.unregister';
}

export function validatePluginLyricsPayload(method: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return 'invalid-lyrics-action';
  const action = payload as Record<string, unknown>;
  const allowed =
    method === 'ui.lyrics.unregister' ? ['id'] : ['id', 'label', 'icon', 'windowAction'];
  if (Object.keys(action).some((key) => !allowed.includes(key))) return 'invalid-lyrics-action';
  if (typeof action.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(action.id))
    return 'invalid-lyrics-action';
  if (method === 'ui.lyrics.unregister') return null;
  if (
    typeof action.label !== 'string' ||
    !action.label.trim() ||
    Array.from(action.label).length > 40
  )
    return 'invalid-lyrics-action';
  if (
    action.icon !== undefined &&
    (typeof action.icon !== 'string' ||
      !['minus', 'maximize', 'close', 'settings', 'info', 'music'].includes(action.icon))
  )
    return 'invalid-lyrics-action';
  if (
    action.windowAction !== undefined &&
    (typeof action.windowAction !== 'string' ||
      !['minimize', 'toggleMaximize', 'close'].includes(action.windowAction))
  )
    return 'invalid-lyrics-action';
  return null;
}

type Listener = () => void;

const listeners = new Set<Listener>();

let trackActions: PluginUiContribution[] = [];
let playerBarActions: PluginUiContribution[] = [];
let sidebarActions: PluginUiContribution[] = [];
let lyricsActions: PluginLyricsContribution[] = [];

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribePluginUi(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pluginTrackActions(): readonly PluginUiContribution[] {
  return trackActions;
}

export function pluginPlayerBarActions(): readonly PluginUiContribution[] {
  return playerBarActions;
}

export function pluginSidebarActions(): readonly PluginUiContribution[] {
  return sidebarActions;
}

export function pluginLyricsActions(): readonly PluginLyricsContribution[] {
  return lyricsActions;
}

export function registerPluginLyricsAction(item: PluginLyricsContribution): void {
  const previous = lyricsActions.find(
    (action) => action.pluginId === item.pluginId && action.id === item.id,
  );
  if (
    !previous &&
    (lyricsActions.length >= 12 ||
      lyricsActions.filter((action) => action.pluginId === item.pluginId).length >= 4)
  )
    throw new Error('lyrics-action-limit');
  lyricsActions = [...lyricsActions.filter((action) => action !== previous), item];
  emit();
}

export function unregisterPluginLyricsAction(pluginId: string, id: string): void {
  lyricsActions = lyricsActions.filter(
    (action) => action.pluginId !== pluginId || action.id !== id,
  );
  emit();
}

export function clearPluginUi(pluginId?: string): void {
  clearPluginPageContributions(pluginId);
  if (!pluginId) {
    trackActions = [];
    playerBarActions = [];
    sidebarActions = [];
    lyricsActions = [];
    emit();
    return;
  }
  trackActions = trackActions.filter((item) => item.pluginId !== pluginId);
  playerBarActions = playerBarActions.filter((item) => item.pluginId !== pluginId);
  sidebarActions = sidebarActions.filter((item) => item.pluginId !== pluginId);
  lyricsActions = lyricsActions.filter((item) => item.pluginId !== pluginId);
  emit();
}

function upsert(
  list: PluginUiContribution[],
  item: PluginUiContribution,
  limit: number,
): PluginUiContribution[] {
  const without = list.filter(
    (existing) => !(existing.pluginId === item.pluginId && existing.id === item.id),
  );
  return [...without, item].slice(0, limit);
}

export function registerPluginTrackAction(item: PluginUiContribution): void {
  trackActions = upsert(trackActions, item, 8);
  emit();
}

export function registerPluginPlayerBarAction(item: PluginUiContribution): void {
  playerBarActions = upsert(playerBarActions, item, 3);
  emit();
}

export function registerPluginSidebarAction(item: PluginUiContribution): void {
  sidebarActions = upsert(sidebarActions, item, 4);
  emit();
}

export function usePluginUiSnapshot(): {
  track: readonly PluginUiContribution[];
  playerBar: readonly PluginUiContribution[];
  sidebar: readonly PluginUiContribution[];
  lyrics: readonly PluginLyricsContribution[];
} {
  const [snapshot, setSnapshot] = useState({
    track: trackActions,
    playerBar: playerBarActions,
    sidebar: sidebarActions,
    lyrics: lyricsActions,
  });
  useEffect(
    () =>
      subscribePluginUi(() =>
        setSnapshot({
          track: [...trackActions],
          playerBar: [...playerBarActions],
          sidebar: [...sidebarActions],
          lyrics: [...lyricsActions],
        }),
      ),
    [],
  );
  return snapshot;
}
