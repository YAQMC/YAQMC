import type { AccountPlaylistSummary, EntityId } from '../domain/music';

export type AppRoute =
  | { page: 'home' }
  | { page: 'search'; query?: string }
  | { page: 'explore' }
  | { page: 'favorites' }
  | { page: 'account-playlists' }
  | { page: 'account-playlist'; playlist: AccountPlaylistSummary }
  | { page: 'account-recent' }
  | { page: 'settings' }
  | { page: 'album'; id: EntityId }
  | { page: 'playlist'; id: EntityId }
  | { page: 'area'; encArea: string; title: string };

export function isPrimaryRoute(route: AppRoute, page: AppRoute['page']): boolean {
  return route.page === page;
}
