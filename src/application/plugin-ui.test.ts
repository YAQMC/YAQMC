import { describe, expect, it } from 'vitest';
import {
  clearPluginUi,
  pluginPlayerBarActions,
  pluginSidebarActions,
  pluginTrackActions,
  registerPluginPlayerBarAction,
  registerPluginSidebarAction,
  registerPluginTrackAction,
  registerPluginLyricsAction,
  pluginLyricsActions,
  validatePluginLyricsPayload,
} from './plugin-ui';

describe('plugin UI registrations', () => {
  it('rejects malformed lyrics actions and bounds registrations per plugin', () => {
    clearPluginUi();
    for (const payload of [
      null,
      { id: '../bad', label: 'Bad' },
      { id: 'ok', label: ' ' },
      { id: 'ok', label: 'Bad', windowAction: 'shell.open' },
      { id: 'ok', label: 'Bad', pluginId: 'spoof' },
    ])
      expect(validatePluginLyricsPayload('ui.lyrics.register', payload)).toBe(
        'invalid-lyrics-action',
      );
    for (let index = 0; index < 4; index++)
      registerPluginLyricsAction({
        pluginId: 'dev.test',
        pluginName: 'Test',
        id: String(index),
        label: 'Action',
      });
    expect(() =>
      registerPluginLyricsAction({
        pluginId: 'dev.test',
        pluginName: 'Test',
        id: '5',
        label: 'Extra',
      }),
    ).toThrow('lyrics-action-limit');
    registerPluginLyricsAction({
      pluginId: 'dev.test',
      pluginName: 'Test',
      id: '0',
      label: 'Updated',
    });
    expect(pluginLyricsActions()).toHaveLength(4);
    clearPluginUi('dev.test');
    expect(pluginLyricsActions()).toHaveLength(0);
  });
  it('clears contributions on disable and does not duplicate on re-register', () => {
    clearPluginUi();
    registerPluginTrackAction({
      pluginId: 'dev.example',
      pluginName: 'Example',
      id: 'copy',
      label: 'Copy',
    });
    registerPluginTrackAction({
      pluginId: 'dev.example',
      pluginName: 'Example',
      id: 'copy',
      label: 'Copy title',
    });
    registerPluginPlayerBarAction({
      pluginId: 'dev.example',
      pluginName: 'Example',
      id: 'bar',
      label: 'Bar',
    });
    registerPluginSidebarAction({
      pluginId: 'dev.example',
      pluginName: 'Example',
      id: 'side',
      label: 'Side',
    });
    expect(pluginTrackActions()).toHaveLength(1);
    expect(pluginTrackActions()[0]?.label).toBe('Copy title');
    expect(pluginPlayerBarActions()).toHaveLength(1);
    expect(pluginSidebarActions()).toHaveLength(1);
    clearPluginUi('dev.example');
    expect(pluginTrackActions()).toHaveLength(0);
    expect(pluginPlayerBarActions()).toHaveLength(0);
    expect(pluginSidebarActions()).toHaveLength(0);
    registerPluginTrackAction({
      pluginId: 'dev.example',
      pluginName: 'Example',
      id: 'copy',
      label: 'Copy',
    });
    expect(pluginTrackActions()).toHaveLength(1);
    clearPluginUi();
  });
});
