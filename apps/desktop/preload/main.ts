import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { createPreloadHostInfo } from './packaged';

type InvokeReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; retryable: boolean; details?: unknown } };

type EventFrame = {
  channel: string;
  payload: unknown;
};

contextBridge.exposeInMainWorld('yaqmc', {
  invokeResult: (method: string, params?: unknown): Promise<InvokeReply> =>
    ipcRenderer.invoke('yaqmc:invoke', { method, params }),
  invoke: async (method: string, params?: unknown) => {
    const reply = (await ipcRenderer.invoke('yaqmc:invoke', { method, params })) as InvokeReply;
    if (!reply || typeof reply !== 'object' || !('ok' in reply)) {
      throw new Error('invalid invoke reply');
    }
    if (!reply.ok) {
      const error = new Error(reply.error.message);
      error.name = 'YaqmcInvokeError';
      Object.assign(error, reply.error);
      throw error;
    }
    return reply.result;
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, frame: EventFrame) => {
      if (frame.channel === channel) {
        cb(frame.payload);
      }
    };
    ipcRenderer.on('yaqmc:event', listener);
    return () => {
      ipcRenderer.removeListener('yaqmc:event', listener);
    };
  },
  windowRole: 'main',
  hostInfo: createPreloadHostInfo(process.versions.electron, process.platform, process.execPath),
  // macOS uses its native traffic lights (titleBarStyle hiddenInset) instead of YAQMC's controls.
  ...(process.platform === 'darwin' ? { capabilities: { windowControls: false } } : {}),
});
