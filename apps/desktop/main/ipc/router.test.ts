import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { WindowRole } from '@yaqmc/client';
import type { InvokeTarget } from '../ipc';
import {
  eventAllowed,
  hostDenied,
  loadMethodAclFromFile,
  methodAllowed,
  originToRole,
  parseMethodAcl,
} from './channels';
import { IpcRouter } from './router';

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/yaqmc-client/fixtures',
);

const methods = loadMethodAclFromFile(path.join(fixturesRoot, 'methods.json'));

function routerWith(
  role: WindowRole,
  invoke: InvokeTarget['invoke'] = vi.fn(async () => ({ ok: true })),
  hostHandlers?: ConstructorParameters<typeof IpcRouter>[0]['hostHandlers'],
): { router: IpcRouter; invoke: ReturnType<typeof vi.fn<InvokeTarget['invoke']>> } {
  const mockInvoke = invoke as ReturnType<typeof vi.fn<InvokeTarget['invoke']>>;
  const router = new IpcRouter({
    methods,
    client: { invoke: mockInvoke },
    hostHandlers,
  });
  router.registerWindow(1, role);
  return { router, invoke: mockInvoke };
}

describe('method ACL table', () => {
  it('matches the live protocol fixture owners and renderer origins', () => {
    const raw = JSON.parse(readFileSync(path.join(fixturesRoot, 'methods.json'), 'utf8')) as unknown;
    const parsed = parseMethodAcl(raw);
    expect(parsed.map((row) => row.name)).toEqual(methods.map((row) => row.name));
    expect(methods.some((row) => row.owner === 'host')).toBe(true);
    const snapshot = methods.find((row) => row.name === 'player_snapshot');
    expect(snapshot?.owner).toBe('core');
    expect(snapshot?.allowedOrigins).toEqual(['host', 'main']);
    expect(methodAllowed(snapshot, 'main')).toBe(true);
    expect(methodAllowed(snapshot, 'lyrics-desktop')).toBe(false);
    expect(originToRole('lyrics-desktop-unlock')).toBe('unlock-desktop');
  });
});

describe('IpcRouter', () => {
  it('returns host.denied when a surface invokes a main-only method', async () => {
    const { router, invoke } = routerWith('lyrics-desktop');
    await expect(router.invoke(1, { method: 'player_snapshot' })).resolves.toEqual({
      ok: false,
      error: hostDenied('player_snapshot', 'lyrics-desktop'),
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('proxies an allowed core method and intercepts host methods', async () => {
    const { router, invoke } = routerWith('main', vi.fn(async () => ({ playbackState: 'paused' })));
    await expect(router.invoke(1, { method: 'player_snapshot' })).resolves.toEqual({
      ok: true,
      result: { playbackState: 'paused' },
    });
    expect(invoke).toHaveBeenCalledWith('player_snapshot', undefined);

    invoke.mockClear();
    await expect(router.invoke(1, { method: 'system_integration_status' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'host.denied',
        message: 'system_integration_status is implemented by the host',
        retryable: false,
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not send denied events to lyrics surfaces', () => {
    const router = new IpcRouter({ methods });
    router.registerWindow(1, 'main');
    router.registerWindow(2, 'lyrics-desktop');
    const sent: Array<{ id: number; channel: string }> = [];
    router.fanout('api://event', { type: 'x' }, (id, frame) => {
      sent.push({ id, channel: frame.channel });
    });
    expect(sent).toEqual([{ id: 1, channel: 'api://event' }]);
    expect(eventAllowed('lyrics-desktop', 'player://snapshot')).toBe(true);
    expect(eventAllowed('unlock-desktop', 'lyrics://surface-closed')).toBe(true);
    expect(eventAllowed('unlock-desktop', 'player://snapshot')).toBe(false);
  });

  it('returns host.denied for unknown methods without calling core', async () => {
    const { router, invoke } = routerWith('main');
    await expect(router.invoke(1, { method: 'not_a_method' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'host.denied', retryable: false },
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
