import { definePlugin, type PluginContext } from '../../../sdk/plugin/src/index';

export default definePlugin({
  activate(ctx: PluginContext) {
    const stop = ctx.events.on('ui.action', () => {
      void ping(ctx);
    });
    void ctx.ui.notify({ level: 'info', message: 'Network example loaded' }).catch(() => undefined);
    void ping(ctx);
    return stop;
  },
});

async function ping(ctx: PluginContext): Promise<void> {
  try {
    const response = await ctx.network.request({
      url: 'https://example.com/',
      method: 'GET',
      headers: { accept: 'text/html' },
    });
    await ctx.log.info(`example.com status=${response.status}`);
  } catch (error) {
    await ctx.log.warn(String(error));
  }
}
