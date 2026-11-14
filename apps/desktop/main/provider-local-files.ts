import { PluginFilesHost } from './plugin-files';
import type { ShowOpenDialog } from './dialogs';

type CoreInvoke = (method: string, params: unknown, origin?: string) => Promise<unknown>;
const READ_METHODS = new Set(['files.pickDirectory', 'files.stat', 'files.list', 'files.readFile']);

/** Private Core -> native broker. This channel never reaches a renderer. */
export class ProviderLocalFilesHost {
  private readonly files: PluginFilesHost;
  constructor(
    private readonly invoke: CoreInvoke,
    pick: ShowOpenDialog,
  ) {
    this.files = new PluginFilesHost(
      (request) => invoke('plugin_local_files', { operation: 'authorize', request }, 'host'),
      pick,
    );
  }
  async handle(payload: unknown): Promise<void> {
    const event = payload as {
      release?: string;
      requestId?: string;
      request?: { token: string; method: string; payload: { writable?: boolean } };
    };
    if (typeof event?.release === 'string') {
      this.files.release(event.release, 0);
      return;
    }
    if (typeof event?.requestId !== 'string') return;
    let value: unknown;
    let error: string | undefined;
    try {
      if (
        !event.request ||
        !READ_METHODS.has(event.request.method) ||
        event.request.payload?.writable === true
      )
        throw new Error('files.permission-denied');
      value = await this.files.invoke({ request: event.request }, 0);
    } catch {
      error = 'files.native-operation-failed';
    }
    await this.invoke(
      'plugin_local_files',
      { operation: 'complete', requestId: event.requestId, value, error },
      'host',
    ).catch(() => undefined);
  }
}
