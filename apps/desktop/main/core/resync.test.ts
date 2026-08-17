import { describe, expect, it, vi } from 'vitest';
import { resyncAfterCoreRestart } from './resync';
import type { CoreClient } from './client';

describe('resyncAfterCoreRestart', () => {
  it('pauses playback then calls YaqmcClient.resync without playing', async () => {
    const invoked: string[] = [];
    const client = {
      invoke: vi.fn(async (method: string) => {
        invoked.push(method);
        if (method === 'player_snapshot') {
          return { playbackState: 'paused', isPlaying: false };
        }
        if (method === 'plugin_list') {
          return [];
        }
        return null;
      }),
    } as unknown as CoreClient;

    const pulled = await resyncAfterCoreRestart(client);
    expect(invoked[0]).toBe('player_pause');
    expect(invoked.slice(1).sort()).toEqual([
      'app_preferences_get',
      'lyrics_surface_projection',
      'player_lyrics',
      'player_snapshot',
      'plugin_list',
    ]);
    expect(pulled.snapshot).toMatchObject({ playbackState: 'paused', isPlaying: false });
    expect(invoked).not.toContain('player_play');
  });
});
