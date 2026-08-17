import type { WindowRole } from '@yaqmc/client';
import {
  handleRendererInvoke,
  toCoreError,
  type InvokeReply,
  type InvokeRequest,
  type InvokeTarget,
} from '../ipc';
import {
  eventAllowed,
  hostDenied,
  hostOwnedUnimplemented,
  methodAllowed,
  type MethodAclRow,
} from './channels';

export type HostHandler = (params?: unknown) => Promise<unknown>;

export type EventFrame = {
  channel: string;
  payload: unknown;
};

export class IpcRouter {
  private readonly methods = new Map<string, MethodAclRow>();
  private readonly windows = new Map<number, WindowRole>();
  private readonly hostHandlers: Record<string, HostHandler>;
  private client: InvokeTarget | undefined;

  constructor(options: {
    methods: readonly MethodAclRow[];
    client?: InvokeTarget;
    hostHandlers?: Record<string, HostHandler>;
  }) {
    for (const row of options.methods) {
      this.methods.set(row.name, row);
    }
    this.client = options.client;
    this.hostHandlers = options.hostHandlers ?? {};
  }

  setClient(client: InvokeTarget | undefined): void {
    this.client = client;
  }

  registerWindow(webContentsId: number, role: WindowRole): void {
    this.windows.set(webContentsId, role);
  }

  unregisterWindow(webContentsId: number): void {
    this.windows.delete(webContentsId);
  }

  listWindows(): Array<{ webContentsId: number; role: WindowRole }> {
    return [...this.windows.entries()].map(([webContentsId, role]) => ({
      webContentsId,
      role,
    }));
  }

  async invoke(webContentsId: number, request: InvokeRequest | undefined): Promise<InvokeReply> {
    const method = request?.method;
    if (typeof method !== 'string' || method.length === 0) {
      return {
        ok: false,
        error: { code: 'core.protocol', message: 'missing method', retryable: false },
      };
    }
    const role = this.windows.get(webContentsId);
    if (!role) {
      return { ok: false, error: hostDenied(method, 'main') };
    }
    const spec = this.methods.get(method);
    const handler = this.hostHandlers[method];
    if (handler) {
      if (spec ? !methodAllowed(spec, role) : role !== 'main') {
        return { ok: false, error: hostDenied(method, role) };
      }
      try {
        return { ok: true, result: await handler(request?.params) };
      } catch (error) {
        return { ok: false, error: toCoreError(error) };
      }
    }
    if (!spec || !methodAllowed(spec, role)) {
      return { ok: false, error: hostDenied(method, role) };
    }
    if (spec.owner === 'host') {
      return { ok: false, error: hostOwnedUnimplemented(method) };
    }
    return handleRendererInvoke(this.client, request);
  }

  fanout(
    channel: string,
    payload: unknown,
    send: (webContentsId: number, frame: EventFrame) => void,
  ): void {
    for (const [webContentsId, role] of this.windows) {
      if (eventAllowed(role, channel)) {
        send(webContentsId, { channel, payload });
      }
    }
  }
}
