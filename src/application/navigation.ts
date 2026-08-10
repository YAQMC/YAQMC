import type { EntityId } from '../domain/music';

export type AppRoute =
  | { page: 'home' }
  | { page: 'search'; query?: string }
  | { page: 'explore' }
  | { page: 'library' }
  | { page: 'settings' }
  | { page: 'album'; id: EntityId }
  | { page: 'playlist'; id: EntityId };

export function isPrimaryRoute(route: AppRoute, page: AppRoute['page']): boolean {
  return route.page === page;
}
