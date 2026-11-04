import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPluginPageCall,
  clearPluginPageContributions,
  HOME_LAYOUT_SECTIONS,
  PLUGIN_PAGE_LIMITS,
  parsePageBlocks,
  pageKey,
  pluginPageSnapshot,
  resolveHomeLayout,
  validatePluginPagePayload,
  type PluginLayoutOverride,
} from './plugin-pages';
import { clearPluginUi } from './plugin-ui';
import { routesEqual } from './use-navigation-history';

const A = 'dev.example.alpha';
const B = 'dev.example.beta';

function register(pluginId: string, id: string, title = 'Page') {
  return applyPluginPageCall(pluginId, pluginId, 'ui.pages.register', { id, title });
}

afterEach(() => clearPluginPageContributions());

describe('plugin API v4 payload validation', () => {
  it('accepts every documented block type and normalizes optional fields', () => {
    const blocks = parsePageBlocks([
      { type: 'heading', text: 'Today' },
      { type: 'text', text: 'Body' },
      { type: 'notice', text: 'Heads up', level: 'warning' },
      { type: 'divider' },
      { type: 'stats', items: [{ label: 'Plays', value: '12' }] },
      { type: 'list', items: [{ id: 'one', title: 'Song', subtitle: 'Artist', actionId: 'open' }] },
      { type: 'actions', items: [{ id: 'go', label: 'Go', variant: 'primary' }] },
    ]);
    expect(blocks).not.toBeNull();
    expect(blocks![1]).toEqual({ type: 'text', text: 'Body', tone: 'default' });
    expect(blocks![2]).toMatchObject({ level: 'warning' });
  });

  it('rejects markup-like or unknown blocks instead of rendering them', () => {
    expect(parsePageBlocks([{ type: 'html', html: '<img src=x onerror=alert(1)>' }])).toBeNull();
    expect(parsePageBlocks([{ type: 'image', src: 'https://tracker.example/p.gif' }])).toBeNull();
    expect(parsePageBlocks([{ type: 'text', text: { toString: () => 'x' } }])).toBeNull();
    expect(parsePageBlocks('not-an-array')).toBeNull();
    // Text that looks like markup is accepted as text; the host never interprets it.
    expect(parsePageBlocks([{ type: 'text', text: '<b>bold</b>' }])).toEqual([
      { type: 'text', text: '<b>bold</b>', tone: 'default' },
    ]);
  });

  it('enforces size limits', () => {
    const many = Array.from({ length: PLUGIN_PAGE_LIMITS.blocks + 1 }, () => ({ type: 'divider' }));
    expect(parsePageBlocks(many)).toBeNull();
    expect(
      parsePageBlocks([{ type: 'text', text: 'x'.repeat(PLUGIN_PAGE_LIMITS.text + 1) }]),
    ).toBeNull();
    expect(
      parsePageBlocks([
        {
          type: 'actions',
          items: Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, label: 'A' })),
        },
      ]),
    ).toBeNull();
  });

  it('returns stable error codes per method', () => {
    expect(validatePluginPagePayload('ui.pages.register', { id: 'ok', title: 'T' })).toBeNull();
    expect(validatePluginPagePayload('ui.pages.register', { id: '../x', title: 'T' })).toBe(
      'invalid-page',
    );
    expect(validatePluginPagePayload('ui.pages.render', { pageId: 'ok', blocks: [{}] })).toBe(
      'invalid-page-blocks',
    );
    expect(validatePluginPagePayload('ui.navigation.register', { id: 'n', label: 'L' })).toBe(
      'invalid-navigation-entry',
    );
    expect(validatePluginPagePayload('ui.layout.set', { target: 'settings' })).toBe(
      'unsupported-layout-target',
    );
    expect(
      validatePluginPagePayload('ui.layout.set', { target: 'home', order: ['radar', 'radar'] }),
    ).toBe('invalid-layout');
    expect(
      validatePluginPagePayload('ui.layout.set', { target: 'home', hidden: ['sidebar'] }),
    ).toBe('invalid-layout');
    expect(validatePluginPagePayload('ui.layout.clear', { target: 'home' })).toBeNull();
    expect(validatePluginPagePayload('ui.pages.unregister', null)).toBe('invalid-payload');
  });
});

describe('plugin API v4 registration', () => {
  it('registers, renders, and isolates pages per plugin', () => {
    expect(register(A, 'log', 'Log')).toBe(true);
    expect(
      applyPluginPageCall(A, A, 'ui.pages.render', {
        pageId: 'log',
        blocks: [{ type: 'heading', text: 'Hi' }],
      }),
    ).toBe(true);
    const page = pluginPageSnapshot().pages.get(pageKey(A, 'log'));
    expect(page).toMatchObject({ pluginId: A, title: 'Log', blocks: [{ type: 'heading' }] });

    // Another plugin can neither render into nor see A's page under its own id.
    expect(
      applyPluginPageCall(B, B, 'ui.pages.render', {
        pageId: 'log',
        blocks: [{ type: 'divider' }],
      }),
    ).toBe(false);
    expect(pluginPageSnapshot().pages.get(pageKey(A, 'log'))?.blocks).toHaveLength(1);
  });

  it('keeps blocks across re-registration and caps pages per plugin', () => {
    register(A, 'p0');
    applyPluginPageCall(A, A, 'ui.pages.render', { pageId: 'p0', blocks: [{ type: 'divider' }] });
    register(A, 'p0', 'Renamed');
    expect(pluginPageSnapshot().pages.get(pageKey(A, 'p0'))).toMatchObject({
      title: 'Renamed',
      blocks: [{ type: 'divider' }],
    });
    for (let index = 1; index < PLUGIN_PAGE_LIMITS.pagesPerPlugin; index += 1) {
      expect(register(A, `p${index}`)).toBe(true);
    }
    expect(register(A, 'overflow')).toBe(false);
    expect(register(B, 'other')).toBe(true);
  });

  it('only lets navigation open the plugin’s own registered pages', () => {
    register(A, 'log');
    expect(
      applyPluginPageCall(B, B, 'ui.navigation.register', {
        id: 'n',
        label: 'Steal',
        pageId: 'log',
      }),
    ).toBe(false);
    expect(
      applyPluginPageCall(A, A, 'ui.navigation.register', {
        id: 'n',
        label: 'Log',
        pageId: 'missing',
      }),
    ).toBe(false);
    expect(
      applyPluginPageCall(A, A, 'ui.navigation.register', { id: 'n', label: 'Log', pageId: 'log' }),
    ).toBe(true);
    expect(pluginPageSnapshot().navigation).toEqual([
      { pluginId: A, pluginName: A, id: 'n', label: 'Log', pageId: 'log' },
    ]);

    // Unregistering a page removes navigation that pointed at it.
    applyPluginPageCall(A, A, 'ui.pages.unregister', { pageId: 'log' });
    expect(pluginPageSnapshot().navigation).toEqual([]);
  });

  it('clears one plugin’s pages, navigation, and layout when its runtime stops', () => {
    register(A, 'log');
    register(B, 'log');
    applyPluginPageCall(A, A, 'ui.navigation.register', { id: 'n', label: 'Log', pageId: 'log' });
    applyPluginPageCall(A, A, 'ui.layout.set', { target: 'home', hidden: ['radar'] });

    clearPluginUi(A);

    const snapshot = pluginPageSnapshot();
    expect(snapshot.pages.has(pageKey(A, 'log'))).toBe(false);
    expect(snapshot.pages.has(pageKey(B, 'log'))).toBe(true);
    expect(snapshot.navigation).toEqual([]);
    expect(snapshot.layouts).toEqual([]);
  });
});

describe('plugin API v4 layout', () => {
  const override = (
    pluginId: string,
    order: PluginLayoutOverride['order'],
    hidden: PluginLayoutOverride['hidden'] = [],
  ): PluginLayoutOverride => ({ pluginId, pluginName: pluginId, target: 'home', order, hidden });

  it('defaults to the host order with nothing hidden and no attribution', () => {
    const layout = resolveHomeLayout([]);
    expect(layout.order).toEqual([...HOME_LAYOUT_SECTIONS]);
    expect(layout.hidden.size).toBe(0);
    expect(layout.sources).toEqual([]);
  });

  it('merges deterministically regardless of activation order', () => {
    const first = resolveHomeLayout([
      override(B, ['recommended-playlists']),
      override(A, ['radar'], ['for-you']),
    ]);
    const second = resolveHomeLayout([
      override(A, ['radar'], ['for-you']),
      override(B, ['recommended-playlists']),
    ]);
    expect(first).toEqual(second);
    // A sorts first, so its order wins; unmentioned sections keep default relative order.
    expect(first.order).toEqual(['radar', 'for-you', 'recommended-playlists']);
    expect([...first.hidden]).toEqual(['for-you']);
    expect(first.sources).toEqual([A, B]);
  });

  it('applies and clears through the bridge contract', () => {
    applyPluginPageCall(A, A, 'ui.layout.set', { target: 'home', order: ['radar'] });
    expect(resolveHomeLayout(pluginPageSnapshot().layouts).order[0]).toBe('radar');
    expect(applyPluginPageCall(A, A, 'ui.layout.clear', { target: 'home' })).toBe(true);
    expect(pluginPageSnapshot().layouts).toEqual([]);
  });
});

describe('plugin page routing', () => {
  it('compares plugin page routes by owner and page id', () => {
    const route = { page: 'plugin-page', pluginId: A, pageId: 'log' } as const;
    expect(routesEqual(route, { ...route })).toBe(true);
    expect(routesEqual(route, { ...route, pageId: 'other' })).toBe(false);
    expect(routesEqual(route, { ...route, pluginId: B })).toBe(false);
  });
});
