import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSongBadge } from '@yaqmc/client';
import { PluginSongBadges } from '../components/PluginSongBadges';
import {
  clearPluginSongBadges,
  pluginSongBadgeLabel,
  replacePluginSongBadges,
  songBadgesForProvider,
} from './plugin-song-badges';

const language = vi.hoisted(() => ({ language: 'zh-CN' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: language }) }));

const badge: ActiveSongBadge = {
  pluginId: 'example.plugin',
  pluginName: 'Example plugin',
  id: 'catalog',
  providerIds: ['example.catalog'],
  label: 'Example',
  color: '#123456',
  labels: { 'zh-CN': '示例', en: 'Example catalog' },
};
const direct = { providerId: 'example.catalog', profileId: 'default', trackId: 'one' };

afterEach(() => {
  cleanup();
  clearPluginSongBadges();
  language.language = 'zh-CN';
});

describe('plugin-defined song badges', () => {
  it('uses original catalog identity for federated songs and does not guess unknown sources', () => {
    expect(songBadgesForProvider(direct)).toEqual([]);
    replacePluginSongBadges([badge]);
    expect(songBadgesForProvider(direct)).toEqual([badge]);
    expect(
      songBadgesForProvider({
        ...direct,
        providerId: 'example.federation',
        originProviderId: direct.providerId,
      }),
    ).toEqual([badge]);
    expect(songBadgesForProvider({ ...direct, originProviderId: 'unknown' })).toEqual([]);
    expect(songBadgesForProvider({ ...direct, providerId: 'example.federation' })).toEqual([]);
    expect(songBadgesForProvider()).toEqual([]);
  });

  it('updates mounted badges on plugin removal and locale changes', () => {
    replacePluginSongBadges([badge]);
    const { rerender, container } = render(<PluginSongBadges song={{ provider: direct }} />);
    expect(screen.getByText('示例').getAttribute('title')).toBe('Example plugin: 示例');
    language.language = 'en-GB';
    rerender(<PluginSongBadges song={{ provider: direct }} />);
    expect(screen.getByText('Example catalog')).toBeTruthy();
    expect(pluginSongBadgeLabel(badge, 'ZH-cn')).toBe('示例');
    expect(pluginSongBadgeLabel(badge, 'fr-FR')).toBe('Example');
    act(() => clearPluginSongBadges(badge.pluginId));
    expect(container.textContent).toBe('');
  });

  it('treats labels as text and rejects arbitrary CSS or unbounded declarations', () => {
    replacePluginSongBadges([
      { ...badge, id: 'html', label: '<img src=x onerror=alert(1)>', labels: undefined },
      { ...badge, id: 'css', color: 'url(https://example.test/track)' },
      { ...badge, id: 'long', label: 'x'.repeat(49) },
      { ...badge, id: 'control', label: 'line\nbreak' },
      { ...badge, id: 'providers', providerIds: Array(17).fill('example.catalog') },
    ]);
    const { container } = render(<PluginSongBadges song={{ provider: direct }} />);
    expect(container.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.plugin-song-badge')?.getAttribute('style')).toContain(
      '#123456',
    );
  });

  it('bounds display, deduplicates rules, and clears only the requested plugin', () => {
    replacePluginSongBadges([
      badge,
      badge,
      ...Array.from({ length: 140 }, (_, index) => ({
        ...badge,
        pluginId: 'another.plugin',
        id: `badge-${index}`,
      })),
    ]);
    expect(songBadgesForProvider(direct)).toHaveLength(4);
    expect(
      new Set(songBadgesForProvider(direct).map((item) => `${item.pluginId}/${item.id}`)).size,
    ).toBe(4);
    clearPluginSongBadges('another.plugin');
    expect(songBadgesForProvider(direct)).toEqual([badge]);
    clearPluginSongBadges();
    expect(songBadgesForProvider(direct)).toEqual([]);
  });
});
