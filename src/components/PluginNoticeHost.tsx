import { useEffect, useState } from 'react';
import {
  pluginNotices,
  subscribePluginNotices,
  dismissPluginNotice,
  type PluginNotice,
} from '../application/plugin-notifications';

export function PluginNoticeHost() {
  const [items, setItems] = useState<readonly PluginNotice[]>(pluginNotices());
  useEffect(() => subscribePluginNotices(() => setItems([...pluginNotices()])), []);
  if (items.length === 0) return null;
  return (
    <div className="plugin-notice-host" role="status">
      {items.map((notice) => (
        <button
          key={notice.id}
          type="button"
          className={`plugin-notice plugin-notice--${notice.level}`}
          onClick={() => dismissPluginNotice(notice.id)}
        >
          <strong>{notice.pluginName ?? notice.pluginId}</strong>
          <span>{notice.message}</span>
        </button>
      ))}
    </div>
  );
}
