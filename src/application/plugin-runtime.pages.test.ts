import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  dispatchPluginPageAction,
  notifyPluginPageVisibility,
  usePluginHost,
} from './plugin-runtime';
import { clearPluginPageContributions, pageKey, pluginPageSnapshot } from './plugin-pages';
import { clearPluginUi, pluginLyricsActions } from './plugin-ui';

const invokeMock = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (payload: never) => void>());
const fileHost = vi.hoisted(() => ({ invoke: vi.fn(), release: vi.fn() }));
const nativeFiles = vi.hoisted(() => ({ available: true }));

vi.mock('./logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('./native-player-runtime', () => ({ isNativeRuntime: true }));
vi.mock('./yaqmc-runtime', () => ({
  getHostBridge: () => ({ kind: 'electron' }),
  getYaqmcClient: () => ({
    bridge: {
      get pluginFiles() {
        return nativeFiles.available ? fileHost : undefined;
      },
    },
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

describe('plugin runtime native and UI bridges', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    handlers.clear();
    allowed = {
      [OWNER]: ['ui.pages.register', 'ui.pages.render', 'ui.navigation.register', 'ui.layout.set'],
    };
    nativeFiles.available = true;
    fileHost.invoke.mockReset().mockResolvedValue({ data: 'hello' });
    fileHost.release.mockReset().mockResolvedValue(undefined);
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
    clearPluginUi();
  });

  async function start() {
    const hook = renderHook(() => usePluginHost());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    return { ...hook, owner: FakeWorker.instances[0]!, other: FakeWorker.instances[1]! };
  }

  it('binds native file calls to the owning runtime and releases grants on unload', async () => {
    const { owner, other, unmount } = await start();
    call(owner, 'read', 'files.readFile', { handle: 'chosen', token: 'forged' });
    call(other, 'stat', 'files.stat', { handle: 'chosen' });
    await waitFor(() => expect(result(owner, 'read')).toMatchObject({ ok: true }));
    expect(fileHost.invoke).toHaveBeenCalledWith({
      token: 'token:0',
      method: 'files.readFile',
      payload: { handle: 'chosen', token: 'forged' },
    });
    expect(fileHost.invoke).toHaveBeenCalledWith({
      token: 'token:1',
      method: 'files.stat',
      payload: { handle: 'chosen' },
    });
    expect(bridgeCalls('files.readFile')).toBe(0);
    unmount();
    await waitFor(() => expect(fileHost.release).toHaveBeenCalledWith('token:0'));
    expect(fileHost.release).toHaveBeenCalledWith('token:1');
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('plugin_runtime_stop', { token: 'token:0' }),
    );
  });

  it('releases native handles immediately on a worker activation failure', async () => {
    const { owner, unmount } = await start();
    owner.onmessage?.({
      data: { type: 'yaqmc/error', message: 'activation failed' },
    } as MessageEvent);
    await waitFor(() => expect(fileHost.release).toHaveBeenCalledWith('token:0'));
    unmount();
  });

  it('releases native handles on an unhandled worker error and drops late responses', async () => {
    let finish!: (value: unknown) => void;
    fileHost.invoke.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { owner, unmount } = await start();
    call(owner, 'pending', 'files.pickFile', {});
    owner.onerror?.({ message: 'worker crashed' } as ErrorEvent);
    await waitFor(() => expect(fileHost.release).toHaveBeenCalledWith('token:0'));
    finish({ handle: 'late' });
    await Promise.resolve();
    expect(result(owner, 'pending')).toBeUndefined();
    unmount();
  });

  it('reports file support as unavailable on non-native hosts', async () => {
    nativeFiles.available = false;
    const { owner, unmount } = await start();
    call(owner, 'cap', 'files.capabilities', {});
    call(owner, 'pick', 'files.pickFile', {});
    await waitFor(() =>
      expect(result(owner, 'cap')).toMatchObject({ ok: true, value: { available: false } }),
    );
    expect(result(owner, 'pick')).toMatchObject({ ok: false, error: 'files.unsupported' });
    unmount();
  });

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

  it('authorizes lyrics controls before registration and rejects unknown commands before IPC', async () => {
    allowed[OWNER] = ['ui.lyrics.register', 'ui.lyrics.unregister'];
    const { owner, other, unmount } = await start();
    call(other, 'denied', 'ui.lyrics.register', {
      id: 'min',
      label: 'Min',
      windowAction: 'minimize',
    });
    await waitFor(() => expect(result(other, 'denied')).toMatchObject({ ok: false }));
    expect(pluginLyricsActions()).toHaveLength(0);
    call(owner, 'bad', 'ui.lyrics.register', {
      id: 'bad',
      label: 'Bad',
      windowAction: 'shell.open',
    });
    await waitFor(() =>
      expect(result(owner, 'bad')).toMatchObject({ ok: false, error: 'invalid-lyrics-action' }),
    );
    expect(bridgeCalls('ui.lyrics.register')).toBe(1);
    call(owner, 'add', 'ui.lyrics.register', { id: 'min', label: 'Min', windowAction: 'minimize' });
    await waitFor(() => expect(result(owner, 'add')).toMatchObject({ ok: true }));
    expect(pluginLyricsActions()).toMatchObject([{ pluginId: OWNER, windowAction: 'minimize' }]);
    call(owner, 'remove', 'ui.lyrics.unregister', { id: 'min' });
    await waitFor(() => expect(result(owner, 'remove')).toMatchObject({ ok: true }));
    expect(pluginLyricsActions()).toHaveLength(0);
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
