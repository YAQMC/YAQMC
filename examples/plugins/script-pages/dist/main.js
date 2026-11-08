'use strict';
"use strict";
const PAGE_ID = 'log';
const MAX_ENTRIES = 20;
definePlugin({
    activate(ctx) {
        const titles = [];
        let radarFirst = false;
        const render = () => {
            const blocks = [
                {
                    type: 'stats',
                    items: [
                        { label: 'Tracks this session', value: String(titles.length) },
                        { label: 'Home layout', value: radarFirst ? 'Radar first' : 'Default' },
                    ],
                },
                {
                    type: 'actions',
                    items: [
                        {
                            id: 'toggle-layout',
                            label: radarFirst ? 'Restore Home layout' : 'Show radar first on Home',
                            variant: 'primary',
                        },
                        { id: 'clear', label: 'Clear log' },
                    ],
                },
                { type: 'divider' },
            ];
            if (titles.length === 0) {
                blocks.push({ type: 'text', text: 'Play something to start the log.', tone: 'secondary' });
            }
            else {
                blocks.push({
                    type: 'list',
                    items: titles.map((title, index) => ({ id: `t${index}`, title })),
                });
            }
            return ctx.pages.render(PAGE_ID, blocks);
        };
        const unsubscribers = [
            ctx.events.on('track.changed', (payload) => {
                const title = payload && typeof payload === 'object' && 'title' in payload
                    ? String(payload.title ?? '')
                    : '';
                if (!title)
                    return;
                titles.unshift(title.slice(0, 120));
                titles.length = Math.min(titles.length, MAX_ENTRIES);
                void render();
            }),
            ctx.events.on('ui.action', (payload) => {
                const action = payload;
                if (action.slot !== 'page' || action.pageId !== PAGE_ID)
                    return;
                if (action.id === 'clear')
                    titles.length = 0;
                if (action.id === 'toggle-layout') {
                    radarFirst = !radarFirst;
                    void (radarFirst
                        ? ctx.layout.set({ target: 'home', order: ['radar', 'for-you'] })
                        : ctx.layout.clear('home'));
                }
                void render();
            }),
            ctx.pages.onMount(PAGE_ID, () => void render()),
        ];
        void ctx.pages
            .register({ id: PAGE_ID, title: 'Listening log' })
            .then(() => ctx.navigation.register({ id: 'open-log', label: 'Listening log', pageId: PAGE_ID }))
            .then(render);
        return () => {
            for (const unsubscribe of unsubscribers)
                unsubscribe();
        };
    },
});
