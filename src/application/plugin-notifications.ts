export type PluginNoticeLevel = 'info' | 'success' | 'warning' | 'error';

export interface PluginNotice {
  id: string;
  pluginId: string;
  pluginName?: string;
  level: PluginNoticeLevel;
  message: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let notices: PluginNotice[] = [];
let seq = 1;
const lastByPlugin = new Map<string, number>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribePluginNotices(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pluginNotices(): readonly PluginNotice[] {
  return notices;
}

export function pushPluginNotice(notice: Omit<PluginNotice, 'id'>): void {
  const now = Date.now();
  const previous = lastByPlugin.get(notice.pluginId) ?? 0;
  if (now - previous < 1000) return;
  lastByPlugin.set(notice.pluginId, now);
  const id = `notice-${seq++}`;
  notices = [...notices.slice(-4), { ...notice, id }];
  emit();
  window.setTimeout(() => dismissPluginNotice(id), 6000);
}

export function dismissPluginNotice(id: string): void {
  notices = notices.filter((notice) => notice.id !== id);
  emit();
}

export function clearPluginNotices(): void {
  notices = [];
  emit();
}
