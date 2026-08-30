import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from './account-runtime';
import { useMusicProvider, useMusicProviderSelection } from './provider-context';
import { MusicProviderRoot } from './provider-root';
import type { MusicProvider } from '../providers/music-provider';
import { fakeMusicProvider } from '../providers/fake/fake-music-provider';

function provider(id: string, displayName: string): MusicProvider {
  return Object.assign(Object.create(fakeMusicProvider) as MusicProvider, { id, displayName });
}

function Probe() {
  const active = useMusicProvider();
  const selection = useMusicProviderSelection();
  return (
    <div>
      <output data-testid="active-provider">{`${active.id}:${active.displayName}`}</output>
      <output data-testid="provider-options">
        {selection.providers
          .map((candidate) => `${candidate.id}:${candidate.available ? 'on' : 'off'}`)
          .join(',')}
      </output>
      <button type="button" onClick={() => selection.selectProvider('provider.b')}>
        Select B
      </button>
    </div>
  );
}

describe('MusicProviderRoot', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAccountRuntimeForTest();
  });

  it('switches between available providers and persists the active provider ID', async () => {
    const a = provider('provider.a', 'Provider A');
    const b = provider('provider.b', 'Provider B');
    render(
      <MusicProviderRoot providers={[a, b]} initialProviderId="provider.a">
        <Probe />
      </MusicProviderRoot>,
    );

    expect(screen.getByTestId('active-provider')).toHaveTextContent('provider.a:Provider A');
    fireEvent.click(screen.getByRole('button', { name: 'Select B' }));
    await waitFor(() =>
      expect(screen.getByTestId('active-provider')).toHaveTextContent('provider.b:Provider B'),
    );
    expect(window.localStorage.getItem('yaqmc.active-provider.v1')).toBe('provider.b');
  });

  it('falls back when the active provider disappears and keeps tombstones non-selectable', async () => {
    const a = provider('provider.a', 'Provider A');
    const b = provider('provider.b', 'Provider B');
    const view = render(
      <MusicProviderRoot providers={[a, b]} initialProviderId="provider.b">
        <Probe />
      </MusicProviderRoot>,
    );
    expect(screen.getByTestId('active-provider')).toHaveTextContent('provider.b:Provider B');

    view.rerender(
      <MusicProviderRoot
        providers={[a]}
        providerOptions={[
          { id: 'provider.a', displayName: 'Provider A', available: true },
          { id: 'provider.b', displayName: 'Provider B', available: false },
        ]}
      >
        <Probe />
      </MusicProviderRoot>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('active-provider')).toHaveTextContent('provider.a:Provider A'),
    );
    expect(screen.getByTestId('provider-options')).toHaveTextContent(
      'provider.a:on,provider.b:off',
    );
    useAccountStore.setState({
      snapshot: {
        state: 'authenticated',
        profile: { avatarUrl: null, nickname: 'Provider B user', maskedIdentity: '***' },
        entitlement: {
          tier: 'free',
          membership: 'inactive',
          expiresAtMs: null,
          permittedQualities: ['standard'],
          observedMaximumQuality: 'standard',
          restrictions: [],
        },
        revision: 7,
        capabilities: {
          qrLogin: false,
          favoriteRead: false,
          favoriteWrite: false,
          playlistRead: false,
          playlistWrite: false,
          recentHistoryRead: false,
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select B' }));
    expect(screen.getByTestId('active-provider')).toHaveTextContent('provider.a:Provider A');
    expect(useAccountStore.getState().snapshot.state).toBe('authenticated');
  });

  it('clears account projections when switching provider instances', async () => {
    const a = provider('provider.a', 'Provider A');
    const b = provider('provider.b', 'Provider B');
    render(
      <MusicProviderRoot providers={[a, b]} initialProviderId="provider.a">
        <Probe />
      </MusicProviderRoot>,
    );
    useAccountStore.setState({
      snapshot: {
        state: 'authenticated',
        profile: { avatarUrl: null, nickname: 'Provider A user', maskedIdentity: '***' },
        entitlement: {
          tier: 'free',
          membership: 'inactive',
          expiresAtMs: null,
          permittedQualities: ['standard'],
          observedMaximumQuality: 'standard',
          restrictions: [],
        },
        revision: 9,
        capabilities: {
          qrLogin: false,
          favoriteRead: false,
          favoriteWrite: false,
          playlistRead: false,
          playlistWrite: false,
          recentHistoryRead: false,
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select B' }));
    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('guest'));
    expect(useAccountStore.getState().snapshot.profile).toBeNull();
  });
});
