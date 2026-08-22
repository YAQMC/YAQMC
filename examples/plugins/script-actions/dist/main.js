'use strict';
"use strict";
definePlugin({
    activate(ctx) {
        const unsubscribers = [
            ctx.events.on('ui.action', (payload) => {
                void handleAction(ctx, payload);
            }),
            ctx.events.on('settings.changed', () => {
                void ctx.log.info('settings.changed');
            }),
        ];
        void ctx.ui.contextMenu.track.register({ id: 'copy-title', label: 'Copy title' });
        void ctx.ui.playerBar.register({ id: 'announce', label: 'Announce track' });
        return () => {
            for (const unsubscribe of unsubscribers)
                unsubscribe();
        };
    },
});
async function handleAction(ctx, payload) {
    const action = payload && typeof payload === 'object' && 'id' in payload
        ? String(payload.id)
        : '';
    const track = await ctx.track.read();
    const settings = await ctx.settings.get();
    const prefix = typeof settings.prefix === 'string' ? settings.prefix : 'Copy title';
    if (action === 'copy-title' || action === 'announce') {
        await ctx.storage.set('lastTitle', track.title ?? '');
        if (settings.notify !== false) {
            await ctx.ui.notify({
                level: 'info',
                message: `${prefix}: ${track.title ?? 'none'}`,
            });
        }
    }
}
