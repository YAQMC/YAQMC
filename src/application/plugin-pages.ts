import { useSyncExternalStore } from 'react';

/**
 * Plugin API v4: plugin-owned pages, navigation entries, and host-defined layout knobs.
 *
 * Plugins never provide markup. A page is a declarative block document that YAQMC renders with
 * its own components; every payload is validated here before the bridge call reaches Core, and
 * Core independently checks the permission, rate limit, and payload size.
 */
export const PLUGIN_PAGE_SCHEMA_VERSION = 1;

export const PLUGIN_PAGE_LIMITS = {
  pagesPerPlugin: 4,
  navigationPerPlugin: 4,
  blocks: 40,
  items: 50,
  title: 60,
  label: 40,
  text: 1_000,
} as const;

/** Home sections a plugin may reorder or hide. Adding one is an additive v4 change. */
export const HOME_LAYOUT_SECTIONS = ['for-you', 'radar', 'recommended-playlists'] as const;
export type HomeLayoutSection = (typeof HOME_LAYOUT_SECTIONS)[number];

/** Host pages whose layout plugins may customize. Unknown targets are rejected, not ignored. */
export const PLUGIN_LAYOUT_TARGETS = ['home'] as const;
export type PluginLayoutTarget = (typeof PLUGIN_LAYOUT_TARGETS)[number];

export type PluginPageBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; tone: 'default' | 'secondary' }
  | { type: 'stats'; items: { label: string; value: string }[] }
  | { type: 'list'; items: { id: string; title: string; subtitle?: string; actionId?: string }[] }
  | { type: 'actions'; items: { id: string; label: string; variant: 'primary' | 'secondary' }[] }
  | { type: 'notice'; text: string; level: 'info' | 'warning' | 'error' }
  | { type: 'divider' };

export interface PluginPage {
  pluginId: string;
  pluginName: string;
  id: string;
  title: string;
  blocks: PluginPageBlock[];
  /** Bumped on every accepted render so stale views can be detected. */
  revision: number;
}

export interface PluginNavigationEntry {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  pageId: string;
}

export interface PluginLayoutOverride {
  pluginId: string;
  pluginName: string;
  target: PluginLayoutTarget;
  order: HomeLayoutSection[];
  hidden: HomeLayoutSection[];
}

export interface HomeLayout {
  order: HomeLayoutSection[];
  hidden: ReadonlySet<HomeLayoutSection>;
  /** Names of plugins currently changing the Home layout, so the host can attribute it. */
  sources: string[];
}

export type PluginUiMethod =
  | 'ui.pages.register'
  | 'ui.pages.render'
  | 'ui.pages.unregister'
  | 'ui.navigation.register'
  | 'ui.navigation.unregister'
  | 'ui.layout.set'
  | 'ui.layout.clear';

export const PLUGIN_PAGE_METHODS: readonly PluginUiMethod[] = [
  'ui.pages.register',
  'ui.pages.render',
  'ui.pages.unregister',
  'ui.navigation.register',
  'ui.navigation.unregister',
  'ui.layout.set',
  'ui.layout.clear',
];

export function isPluginPageMethod(method: string): method is PluginUiMethod {
  return (PLUGIN_PAGE_METHODS as readonly string[]).includes(method);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

type Source = Record<string, unknown>;

function record(value: unknown): Source | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Source)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) ? value : null;
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return text(value, max);
}

function items<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > PLUGIN_PAGE_LIMITS.items) {
    return null;
  }
  const parsed = value.map(parse);
  return parsed.every((item): item is T => item !== null) ? parsed : null;
}

function parseBlock(value: unknown): PluginPageBlock | null {
  const source = record(value);
  if (!source) return null;
  switch (source.type) {
    case 'heading': {
      const content = text(source.text, PLUGIN_PAGE_LIMITS.title);
      return content ? { type: 'heading', text: content } : null;
    }
    case 'text': {
      const content = text(source.text, PLUGIN_PAGE_LIMITS.text);
      const tone = source.tone ?? 'default';
      if (!content || (tone !== 'default' && tone !== 'secondary')) return null;
      return { type: 'text', text: content, tone };
    }
    case 'notice': {
      const content = text(source.text, PLUGIN_PAGE_LIMITS.text);
      const level = source.level ?? 'info';
      if (!content || (level !== 'info' && level !== 'warning' && level !== 'error')) return null;
      return { type: 'notice', text: content, level };
    }
    case 'divider':
      return { type: 'divider' };
    case 'stats': {
      const parsed = items(source.items, (item) => {
        const entry = record(item);
        const label = text(entry?.label, PLUGIN_PAGE_LIMITS.label);
        const value = text(entry?.value, PLUGIN_PAGE_LIMITS.label);
        return label && value ? { label, value } : null;
      });
      return parsed && parsed.length <= 8 ? { type: 'stats', items: parsed } : null;
    }
    case 'list': {
      const parsed = items(source.items, (item) => {
        const entry = record(item);
        const id = identifier(entry?.id);
        const title = text(entry?.title, PLUGIN_PAGE_LIMITS.title * 2);
        const subtitle = optionalText(entry?.subtitle, PLUGIN_PAGE_LIMITS.title * 2);
        const actionId = entry?.actionId === undefined ? undefined : identifier(entry.actionId);
        if (!id || !title || subtitle === null || actionId === null) return null;
        return {
          id,
          title,
          ...(subtitle ? { subtitle } : {}),
          ...(actionId ? { actionId } : {}),
        };
      });
      return parsed ? { type: 'list', items: parsed } : null;
    }
    case 'actions': {
      const parsed = items(source.items, (item) => {
        const entry = record(item);
        const id = identifier(entry?.id);
        const label = text(entry?.label, PLUGIN_PAGE_LIMITS.label);
        const variant = entry?.variant ?? 'secondary';
        if (!id || !label || (variant !== 'primary' && variant !== 'secondary')) return null;
        return { id, label, variant } as const;
      });
      return parsed && parsed.length <= 4 ? { type: 'actions', items: parsed } : null;
    }
    default:
      return null;
  }
}

export function parsePageBlocks(value: unknown): PluginPageBlock[] | null {
  if (!Array.isArray(value) || value.length > PLUGIN_PAGE_LIMITS.blocks) return null;
  const blocks = value.map(parseBlock);
  return blocks.every((block): block is PluginPageBlock => block !== null) ? blocks : null;
}

function sections(value: unknown): HomeLayoutSection[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const known = new Set<string>(HOME_LAYOUT_SECTIONS);
  if (!value.every((item) => typeof item === 'string' && known.has(item))) return null;
  const unique = [...new Set(value as HomeLayoutSection[])];
  return unique.length === value.length ? unique : null;
}

/**
 * Validates a v4 UI payload. Returns a stable error code, or null when the payload is acceptable.
 * The same code is returned to the plugin Worker, so plugin authors get a deterministic failure.
 */
export function validatePluginPagePayload(method: PluginUiMethod, payload: unknown): string | null {
  const source = record(payload);
  if (!source) return 'invalid-payload';
  switch (method) {
    case 'ui.pages.register':
      return identifier(source.id) && text(source.title, PLUGIN_PAGE_LIMITS.title)
        ? null
        : 'invalid-page';
    case 'ui.pages.render':
      if (!identifier(source.pageId)) return 'invalid-page';
      return parsePageBlocks(source.blocks) ? null : 'invalid-page-blocks';
    case 'ui.pages.unregister':
      return identifier(source.pageId) ? null : 'invalid-page';
    case 'ui.navigation.register':
      return identifier(source.id) &&
        identifier(source.pageId) &&
        text(source.label, PLUGIN_PAGE_LIMITS.label)
        ? null
        : 'invalid-navigation-entry';
    case 'ui.navigation.unregister':
      return identifier(source.id) ? null : 'invalid-navigation-entry';
    case 'ui.layout.set': {
      if (!(PLUGIN_LAYOUT_TARGETS as readonly unknown[]).includes(source.target)) {
        return 'unsupported-layout-target';
      }
      const order = sections(source.order);
      const hidden = sections(source.hidden);
      return order && hidden ? null : 'invalid-layout';
    }
    case 'ui.layout.clear':
      return (PLUGIN_LAYOUT_TARGETS as readonly unknown[]).includes(source.target)
        ? null
        : 'unsupported-layout-target';
  }
}

// ---- Store -----------------------------------------------------------------------------------

interface Snapshot {
  pages: ReadonlyMap<string, PluginPage>;
  navigation: readonly PluginNavigationEntry[];
  layouts: readonly PluginLayoutOverride[];
}

let snapshot: Snapshot = { pages: new Map(), navigation: [], layouts: [] };
let revision = 0;
const listeners = new Set<() => void>();

function commit(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pageKey(pluginId: string, pageId: string): string {
  return `${pluginId}/${pageId}`;
}

export function pluginPageSnapshot(): Snapshot {
  return snapshot;
}

export function clearPluginPageContributions(pluginId?: string): void {
  if (!pluginId) {
    commit({ pages: new Map(), navigation: [], layouts: [] });
    return;
  }
  commit({
    pages: new Map([...snapshot.pages].filter(([, page]) => page.pluginId !== pluginId)),
    navigation: snapshot.navigation.filter((entry) => entry.pluginId !== pluginId),
    layouts: snapshot.layouts.filter((layout) => layout.pluginId !== pluginId),
  });
}

/**
 * Applies an accepted v4 bridge call. Payloads are re-validated so a caller cannot bypass the
 * pre-flight check; returns false when nothing changed.
 */
export function applyPluginPageCall(
  pluginId: string,
  pluginName: string,
  method: PluginUiMethod,
  payload: unknown,
): boolean {
  if (validatePluginPagePayload(method, payload) !== null) return false;
  const source = payload as Source;
  switch (method) {
    case 'ui.pages.register': {
      const id = source.id as string;
      const key = pageKey(pluginId, id);
      const existing = snapshot.pages.get(key);
      const owned = [...snapshot.pages.values()].filter((page) => page.pluginId === pluginId);
      if (!existing && owned.length >= PLUGIN_PAGE_LIMITS.pagesPerPlugin) return false;
      const pages = new Map(snapshot.pages);
      pages.set(key, {
        pluginId,
        pluginName,
        id,
        title: text(source.title, PLUGIN_PAGE_LIMITS.title)!,
        blocks: existing?.blocks ?? [],
        revision: (revision += 1),
      });
      commit({ pages });
      return true;
    }
    case 'ui.pages.render': {
      const key = pageKey(pluginId, source.pageId as string);
      const existing = snapshot.pages.get(key);
      if (!existing) return false;
      const pages = new Map(snapshot.pages);
      pages.set(key, {
        ...existing,
        blocks: parsePageBlocks(source.blocks)!,
        revision: (revision += 1),
      });
      commit({ pages });
      return true;
    }
    case 'ui.pages.unregister': {
      const pageId = source.pageId as string;
      const key = pageKey(pluginId, pageId);
      if (!snapshot.pages.has(key)) return false;
      const pages = new Map(snapshot.pages);
      pages.delete(key);
      commit({
        pages,
        navigation: snapshot.navigation.filter(
          (entry) => !(entry.pluginId === pluginId && entry.pageId === pageId),
        ),
      });
      return true;
    }
    case 'ui.navigation.register': {
      const id = source.id as string;
      const pageId = source.pageId as string;
      // Entries may only open the plugin's own, already registered pages.
      if (!snapshot.pages.has(pageKey(pluginId, pageId))) return false;
      const others = snapshot.navigation.filter(
        (entry) => !(entry.pluginId === pluginId && entry.id === id),
      );
      if (
        others.filter((entry) => entry.pluginId === pluginId).length >=
        PLUGIN_PAGE_LIMITS.navigationPerPlugin
      ) {
        return false;
      }
      const label = text(source.label, PLUGIN_PAGE_LIMITS.label)!;
      commit({ navigation: [...others, { pluginId, pluginName, id, label, pageId }] });
      return true;
    }
    case 'ui.navigation.unregister': {
      const next = snapshot.navigation.filter(
        (entry) => !(entry.pluginId === pluginId && entry.id === source.id),
      );
      if (next.length === snapshot.navigation.length) return false;
      commit({ navigation: next });
      return true;
    }
    case 'ui.layout.set': {
      const target = source.target as PluginLayoutTarget;
      const others = snapshot.layouts.filter(
        (layout) => !(layout.pluginId === pluginId && layout.target === target),
      );
      commit({
        layouts: [
          ...others,
          {
            pluginId,
            pluginName,
            target,
            order: sections(source.order)!,
            hidden: sections(source.hidden)!,
          },
        ],
      });
      return true;
    }
    case 'ui.layout.clear': {
      const next = snapshot.layouts.filter(
        (layout) => !(layout.pluginId === pluginId && layout.target === source.target),
      );
      if (next.length === snapshot.layouts.length) return false;
      commit({ layouts: next });
      return true;
    }
  }
}

/**
 * Deterministic merge independent of activation order: overrides are applied by plugin id,
 * hidden sections are the union, and the first plugin that declares an order wins it.
 * Sections a plugin did not mention keep their default relative order after the ordered ones.
 */
export function resolveHomeLayout(layouts: readonly PluginLayoutOverride[]): HomeLayout {
  const home = layouts
    .filter((layout) => layout.target === 'home')
    .sort((first, second) => first.pluginId.localeCompare(second.pluginId));
  const declared = home.find((layout) => layout.order.length > 0)?.order ?? [];
  const order = [
    ...declared,
    ...HOME_LAYOUT_SECTIONS.filter((section) => !declared.includes(section)),
  ];
  const hidden = new Set(home.flatMap((layout) => layout.hidden));
  const sources = home
    .filter((layout) => layout.order.length > 0 || layout.hidden.length > 0)
    .map((layout) => layout.pluginName);
  return { order, hidden, sources };
}

export function usePluginPage(pluginId: string, pageId: string): PluginPage | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.pages.get(pageKey(pluginId, pageId)) ?? null,
  );
}

export function usePluginNavigation(): readonly PluginNavigationEntry[] {
  return useSyncExternalStore(subscribe, () => snapshot.navigation);
}

let cachedLayouts: readonly PluginLayoutOverride[] | null = null;
let cachedHome: HomeLayout = resolveHomeLayout([]);

export function useHomeLayout(): HomeLayout {
  return useSyncExternalStore(subscribe, () => {
    if (cachedLayouts !== snapshot.layouts) {
      cachedLayouts = snapshot.layouts;
      cachedHome = resolveHomeLayout(snapshot.layouts);
    }
    return cachedHome;
  });
}
