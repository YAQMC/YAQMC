import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginStoreReleasesPage, PluginStoreSearchPage } from '@yaqmc/client';
import i18n from '../i18n';
import { PluginStore } from './PluginStore';

const plugins = vi.hoisted(() => ({
  storeSearch: vi.fn(),
  storeReleases: vi.fn(),
  prepareUpdate: vi.fn(),
  updateStatus: vi.fn(async () => []),
  updateInfo: vi.fn(),
  applyUpdate: vi.fn(),
  cancelUpdate: vi.fn(),
}));

vi.mock('../application/yaqmc-runtime', () => ({
  getHostBridge: () => ({ kind: 'android' }),
  getYaqmcClient: () => ({ plugins, on: vi.fn(() => () => undefined) }),
}));
vi.mock('../application/host-capabilities', () => ({
  hasHostCapability: (capability: string) => capability === 'plugins',
}));
vi.mock('../application/plugin-runtime', () => ({
  listPlugins: vi.fn(async () => []),
  choosePluginFile: vi.fn(),
}));

const repository = {
  id: 1,
  owner: 'YAQMC',
  repo: 'yaqmc-music-providers',
  fullName: 'YAQMC/yaqmc-music-providers',
  description: 'Spotify, NetEase and KuGou providers',
  htmlUrl: 'https://github.com/YAQMC/yaqmc-music-providers',
  ownerType: 'Organization' as const,
  ownerAvatarUrl: null,
  organizationOwned: true,
  stars: 2,
  license: 'MIT',
  topics: ['yaqmc-plugin'],
  archived: false,
  fork: false,
  updatedAt: '2026-11-01T00:00:00Z',
  pushedAt: null,
};

const page = (items = [repository]): PluginStoreSearchPage => ({
  query: 'topic:yaqmc-plugin',
  page: 1,
  totalCount: items.length,
  incompleteResults: false,
  hasMore: false,
  items,
  stale: false,
  fetchedAtMs: 1,
});

const releases = (assets: { id: number; name: string }[]): PluginStoreReleasesPage => ({
  owner: 'YAQMC',
  repo: 'yaqmc-music-providers',
  page: 1,
  hasMore: false,
  hiddenPrereleases: 0,
  stale: false,
  fetchedAtMs: 1,
  releases: [
    {
      id: 7,
      tagName: 'v0.3.0',
      name: '0.3.0',
      body: '<script>alert(1)</script> **notes**',
      publishedAt: '2026-11-02T00:00:00Z',
      prerelease: false,
      htmlUrl: '',
      otherAssetCount: 1,
      assets: assets.map((asset) => ({
        ...asset,
        size: 2048,
        downloadCount: 0,
        updatedAt: null,
        sha256: null,
      })),
    },
  ],
});

describe('PluginStore', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    for (const mock of Object.values(plugins)) mock.mockReset();
    plugins.updateStatus.mockResolvedValue([]);
    plugins.storeSearch.mockResolvedValue(page());
    plugins.storeReleases.mockResolvedValue(releases([{ id: 70, name: 'music.yaqmc-plugin' }]));
  });

  it('lists topic results with neutral ownership and package state without downloading', async () => {
    render(<PluginStore onShowInstalled={vi.fn()} />);
    expect(await screen.findByText('yaqmc-music-providers')).toBeInTheDocument();
    expect(screen.getByText('YAQMC organization')).toBeInTheDocument();
    expect(await screen.findByText('Package available')).toBeInTheDocument();
    expect(plugins.storeSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: '', filter: 'all', page: 1 }),
    );
    expect(plugins.prepareUpdate).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Search plugin name, author, or repository')).toBeVisible();
  });

  it('explains rate limits with GitHub reset time instead of showing an empty store', async () => {
    plugins.storeSearch.mockRejectedValue(new Error('store-rate-limited:1800000000000'));
    render(<PluginStore onShowInstalled={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub rate limit reached');
    expect(screen.queryByText('No plugin repositories were found.')).not.toBeInTheDocument();
  });

  it('ignores an older search that resolves after a newer one', async () => {
    let resolveOld: (value: PluginStoreSearchPage) => void = () => undefined;
    plugins.storeSearch
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce(page([{ ...repository, id: 2, repo: 'newer', fullName: 'a/newer' }]));
    render(<PluginStore onShowInstalled={vi.fn()} />);
    await waitFor(() => expect(plugins.storeSearch).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'newer' } });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(await screen.findByText('newer')).toBeInTheDocument();
    resolveOld(page());
    await waitFor(() => expect(screen.queryByText('yaqmc-music-providers')).toBeNull());
  });

  it('requires an explicit choice between several packages and installs through review', async () => {
    plugins.storeReleases.mockResolvedValue(
      releases([
        { id: 71, name: 'music-windows.yaqmc-plugin' },
        { id: 72, name: 'other-plugin.yaqmc-plugin' },
      ]),
    );
    plugins.prepareUpdate.mockResolvedValue({
      operationId: 'op',
      pluginId: null,
      phase: 'preparing',
      preview: null,
      downloadedBytes: 0,
      totalBytes: 2048,
      error: null,
      runtimeChanged: false,
    });
    render(<PluginStore onShowInstalled={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /install/i }));
    const dialog = await screen.findByRole('dialog', { name: repository.fullName });
    // Release notes are plain text: no markup is interpreted.
    expect(await within(dialog).findByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    const install = within(dialog).getByRole('button', { name: /download and review/i });
    expect(install).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: /other-plugin\.yaqmc-plugin/ }));
    fireEvent.click(install);
    await waitFor(() =>
      expect(plugins.prepareUpdate).toHaveBeenCalledWith({
        github: { owner: 'YAQMC', repo: 'yaqmc-music-providers', releaseId: 7, assetId: 72 },
      }),
    );
    expect(within(dialog).getByRole('button', { name: /download and review/i })).toBeDisabled();
  });
});
