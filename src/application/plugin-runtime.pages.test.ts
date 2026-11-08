import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  dispatchPluginPageAction,
  notifyPluginPageVisibility,
  usePluginHost,
} from './plugin-runtime';
import { clearPluginPageContributions, pageKey, pluginPageSnapshot } from './plugin-pages';

const invokeMock = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (payload: never) => void>());

vi.mock('./logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('./native-player-runtime', () => ({ isNativeRuntime: true }));
vi.mock('./yaqmc-runtime', () => ({
  getHostBridge: () => ({ kind: 'electron' }),
  getYaqmcClient: () => ({
    invoke: invokeMock,
    on: (channel: string, handler: (payload: never) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  }),
}));

type Message = { type?: string; id?: string; ok?: boolean; error?: string; event?: string };

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: Message[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Message): void {
    this.posted.push(message);
  }
  terminate(): void {}
}

const OWNER = 'dev.example.pages';
const OTHER = 'dev.example.other';
/** Core's answer per (plugin, method); anything absent is a permission denial. */
let allowed: Record<string, string[]> = {};

function installHost(): void {
  invokeMock.mockImplementation(
    (method: string, args?: { request?: { token: string; method: string } }) => {
      if (method === 'plugin_active_resources') {
        return Promise.resolve({
          safeMode: false,
          developerMode: false,
          styleOrder: [],
          styles: [],
          scenes: [],
          scripts: [
            { pluginId: OWNER, pluginName: 'Pages', source: 'definePlugin({});' },
            { pluginId: OTHER, pluginName: 'Other', source: 'definePlugin({});' },
          ],
        });
      }
      if (method === 'plugin_list') return Promise.resolve([]);
      if (method === 'plugin_runtime_start') {
        return Promise.resolve(`token:${FakeWorker.instances.length}`);
      }
      if (method === 'plugin_bridge') {
        const request = args!.request!;
        const pluginId = request.token === 'token:0' ? OWNER : OTHER;
        return (allowed[pluginId] ?? []).includes(request.method)
          ? Promise.resolve({ ok: true, pluginId })
          : Promise.reject(new Error('plugin permission was not granted'));
      }
      return Promise.resolve(undefined);
    },
  );
}

function call(worker: FakeWorker, id: string, method: string, payload: unknown): void {
  worker.onmessage?.({ data: { type: 'yaqmc/call', id, method, payload } } as MessageEvent);
}

function result(worker: FakeWorker, id: string): Message | undefined {
  return worker.posted.find((message) => message.type === 'yaqmc/result' && message.id === id);
}

function bridgeCalls(method: string): number {
  return invokeMock.mock.calls.filter(
    ([name, args]) => name === 'plugin_bridge' && args?.request?.method === method,
  ).length;
}

describe('plugin API v4 runtime bridge', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    handlers.clear();
    allowed = {
      [OWNER]: ['ui.pages.register', 'ui.pages.render', 'ui.navigation.register', 'ui.layout.set'],
    };
    vi.stubGlobal('Worker', FakeWorker);
    URL.createObjectURL = () => 'blob:yaqmc-plugin';
    URL.revokeObjectURL = () => undefined;
    installHost();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    invokeMock.mockReset();
    clearPluginPageContributions();
  });

  async function start() {
    const hook = renderHook(() => usePluginHost());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    return { ...hook, owner: FakeWorker.instances[0]!, other: FakeWorker.instances[1]! };
  }

  it('applies a page only after Core authorizes the call', async () => {
    const { owner, unmount } = await start();
    call(owner, 'r1', 'ui.pages.register', { id: 'log', title: 'Log' });
    await waitFor(() => expect(result(owner, 'r1')).toMatchObject({ ok: true }));
    call(owner, 'r2', 'ui.pages.render', { pageId: 'log', blocks: [{ type: 'divider' }] });
    await waitFor(() => expect(result(owner, 'r2')).toMatchObject({ ok: true }));
    expect(pluginPageSnapshot().pages.get(pageKey(OWNER, 'log'))).toMatchObject({
      pluginName: 'Pages',
      blocks: [{ type: 'divider' }],
    });
    unmount();
  });

  it('keeps the UI unchanged when Core denies the permission', async () => {
    const { other, unmount } = await start();
    call(other, 'd1', 'ui.pages.register', { id: 'log', title: 'Log' });
    await waitFor(() =>
      expect(result(other, 'd1')).toMatchObject({
        ok: false,
        error: 'plugin permission was not granted',
      }),
    );
    expect(pluginPageSnapshot().pages.size).toBe(0);
    unmount();
  });

  it('rejects malformed payloads before they reach Core', async () => {
    const { owner, unmount } = await start();
    call(owner, 'bad', 'ui.pages.render', {
      pageId: 'log',
      blocks: [{ type: 'html', html: '<script>1</script>' }],
    });
    call(owner, 'target', 'ui.layout.set', { target: 'settings', order: [] });
    await waitFor(() =>
      expect(result(owner, 'bad')).toMatchObject({ ok: false, error: 'invalid-page-blocks' }),
    );
    expect(result(owner, 'target')).toMatchObject({
      ok: false,
      error: 'unsupported-layout-target',
    });
    expect(bridgeCalls('ui.pages.render')).toBe(0);
    expect(bridgeCalls('ui.layout.set')).toBe(0);
    unmount();
  });

  it('removes a plugin’s pages, navigation, and layout when it changes state', async () => {
    const { owner, unmount } = await start();
    call(owner, 'r', 'ui.pages.register', { id: 'log', title: 'Log' });
    await waitFor(() => expect(result(owner, 'r')).toMatchObject({ ok: true }));
    call(owner, 'n', 'ui.navigation.register', { id: 'nav', label: 'Log', pageId: 'log' });
    call(owner, 'l', 'ui.layout.set', { target: 'home', hidden: ['radar'] });
    await waitFor(() => expect(pluginPageSnapshot().layouts).toHaveLength(1));
    expect(pluginPageSnapshot().navigation).toHaveLength(1);

    handlers.get('plugin://changed')?.({ pluginId: OWNER } as never);
    await waitFor(() => expect(pluginPageSnapshot().pages.size).toBe(0));
    expect(pluginPageSnapshot().navigation).toEqual([]);
    expect(pluginPageSnapshot().layouts).toEqual([]);
    unmount();
  });

  it('addresses page lifecycle and actions to the owning plugin only', async () => {
    const { owner, other, unmount } = await start();
    notifyPluginPageVisibility(OWNER, 'log', true);
    dispatchPluginPageAction(OWNER, 'log', 'refresh');
    notifyPluginPageVisibility(OWNER, 'log', false);
    const events = (worker: FakeWorker) =>
      worker.posted.filter((message) => message.type === 'yaqmc/event');
    expect(events(owner)).toEqual([
      { type: 'yaqmc/event', event: 'page.mounted', payload: { pageId: 'log' } },
      {
        type: 'yaqmc/event',
        event: 'ui.action',
        payload: { id: 'refresh', slot: 'page', pageId: 'log' },
      },
      { type: 'yaqmc/event', event: 'page.unmounted', payload: { pageId: 'log' } },
    ]);
    expect(events(other)).toEqual([]);
    unmount();
  });
});
