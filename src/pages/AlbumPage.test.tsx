import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import i18n from '../i18n';
import { albums } from '../providers/fake/fixtures';
import { AlbumPage } from './AlbumPage';

describe('AlbumPage favorite projection', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    resetAccountRuntimeForTest();
    usePlayerStore.setState(initialPlayerState);
  });

  it('renders track favorite state from the canonical account projection', () => {
    const album = albums[0]!;
    const track = album.tracks[0]!;
    useAccountStore.setState({ favoriteByTrackId: { [track.id]: true } });

    render(<AlbumPage album={album} />);

    expect(
      screen.getByRole('button', { name: `Remove ${track.title} from Favorites` }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add album to favorites' }),
    ).not.toBeInTheDocument();
  });
});
