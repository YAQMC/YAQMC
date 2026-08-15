import { useEffect, useState } from 'react';

export interface PluginUiContribution {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  icon?: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();

let trackActions: PluginUiContribution[] = [];
let playerBarActions: PluginUiContribution[] = [];
let sidebarActions: PluginUiContribution[] = [];

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

export function clearPluginUi(pluginId?: string): void {
  if (!pluginId) {
    trackActions = [];
    playerBarActions = [];
    sidebarActions = [];
    emit();
    return;
  }
  trackActions = trackActions.filter((item) => item.pluginId !== pluginId);
  playerBarActions = playerBarActions.filter((item) => item.pluginId !== pluginId);
  sidebarActions = sidebarActions.filter((item) => item.pluginId !== pluginId);
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
} {
  const [snapshot, setSnapshot] = useState({
    track: trackActions,
    playerBar: playerBarActions,
    sidebar: sidebarActions,
  });
  useEffect(
    () =>
      subscribePluginUi(() =>
        setSnapshot({
          track: [...trackActions],
          playerBar: [...playerBarActions],
          sidebar: [...sidebarActions],
        }),
      ),
    [],
  );
  return snapshot;
}
