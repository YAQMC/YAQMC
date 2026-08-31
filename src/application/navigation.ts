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
  | { page: 'statistics' }
  | { page: 'song'; id: EntityId; providerId?: string }
  | { page: 'artist'; id: EntityId; providerId?: string }
  | { page: 'album'; id: EntityId; providerId?: string }
  | { page: 'playlist'; id: EntityId; providerId?: string }
  | { page: 'area'; encArea: string; title: string; providerId?: string };

export type ProviderCatalogRoute = Extract<
  AppRoute,
  { page: 'song' | 'artist' | 'album' | 'playlist' | 'area' }
>;

export function isProviderCatalogRoute(route: AppRoute): route is ProviderCatalogRoute {
  return ['song', 'artist', 'album', 'playlist', 'area'].includes(route.page);
}

export function scopeCatalogRoute(route: AppRoute, providerId: string): AppRoute {
  if (!isProviderCatalogRoute(route) || route.providerId) return route;
  return { ...route, providerId };
}

export function isPrimaryRoute(route: AppRoute, page: AppRoute['page']): boolean {
  return route.page === page;
}
