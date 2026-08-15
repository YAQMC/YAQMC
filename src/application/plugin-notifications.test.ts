import { describe, expect, it } from 'vitest';
import { clearPluginNotices, pluginNotices, pushPluginNotice } from './plugin-notifications';

describe('plugin notifications', () => {
  it('rate-limits notices from the same plugin', () => {
    clearPluginNotices();
    pushPluginNotice({ pluginId: 'a', pluginName: 'A', level: 'info', message: 'one' });
    pushPluginNotice({ pluginId: 'a', pluginName: 'A', level: 'info', message: 'two' });
    expect(pluginNotices()).toHaveLength(1);
    expect(pluginNotices()[0]?.message).toBe('one');
    clearPluginNotices();
  });
});
