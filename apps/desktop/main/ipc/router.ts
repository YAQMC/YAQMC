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
  PROTOCOL_ORIGIN_BY_ROLE,
  type MethodAclRow,
} from './channels';

export type HostHandler = (
  params?: unknown,
  webContentsId?: number,
  origin?: string,
) => Promise<unknown>;

export type EventFrame = {
  channel: string;
  payload: unknown;
};

export class IpcRouter {
  private readonly methods = new Map<string, MethodAclRow>();
  private readonly windows = new Map<number, WindowRole>();
  private readonly hostHandlers: Record<string, HostHandler>;
  private readonly onDenied?: (info: { method: string; role: WindowRole }) => void;
  private client: InvokeTarget | undefined;

  constructor(options: {
    methods: readonly MethodAclRow[];
    client?: InvokeTarget;
    hostHandlers?: Record<string, HostHandler>;
    onDenied?: (info: { method: string; role: WindowRole }) => void;
  }) {
    for (const row of options.methods) {
      this.methods.set(row.name, row);
    }
    this.client = options.client;
    this.hostHandlers = options.hostHandlers ?? {};
    this.onDenied = options.onDenied;
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
      return this.deny(method, 'main');
    }
    const spec = this.methods.get(method);
    const handler = this.hostHandlers[method];
    const origin = PROTOCOL_ORIGIN_BY_ROLE[role];
    if (handler) {
      if (spec ? !methodAllowed(spec, role) : role !== 'main') {
        return this.deny(method, role);
      }
      try {
        return { ok: true, result: await handler(request?.params, webContentsId, origin) };
      } catch (error) {
        return { ok: false, error: toCoreError(error) };
      }
    }
    if (!spec || !methodAllowed(spec, role)) {
      return this.deny(method, role);
    }
    if (spec.owner === 'host') {
      this.onDenied?.({ method, role });
      return { ok: false, error: hostOwnedUnimplemented(method) };
    }
    return handleRendererInvoke(this.client, { method, params: request?.params }, origin);
  }

  private deny(method: string, role: WindowRole): InvokeReply {
    this.onDenied?.({ method, role });
    return { ok: false, error: hostDenied(method, role) };
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
