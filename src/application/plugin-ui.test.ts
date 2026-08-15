import { describe, expect, it } from 'vitest';
import {
  clearPluginUi,
  pluginPlayerBarActions,
  pluginSidebarActions,
  pluginTrackActions,
  registerPluginPlayerBarAction,
  registerPluginSidebarAction,
  registerPluginTrackAction,
} from './plugin-ui';

describe('plugin UI registrations', () => {
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
