import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { WindowRole } from '@yaqmc/client';
import {
  hostDenied,
  loadMethodAclFromFile,
  methodAllowed,
  originToRole,
  type MethodAclRow,
} from './channels';
import { IpcRouter } from './router';

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/yaqmc-client/fixtures',
);

const methods = loadMethodAclFromFile(path.join(fixturesRoot, 'methods.json'));

const SURFACE_ORIGINS = [
  'lyrics-desktop',
  'lyrics-island',
  'lyrics-desktop-unlock',
  'lyrics-island-unlock',
] as const;

const REQUIRED_ACCOUNT_METHODS = [
  'qqmusic_auth_start',
  'qqmusic_auth_oauth_start',
  'qqmusic_auth_heartbeat',
  'qqmusic_auth_cancel',
  'qqmusic_auth_refresh',
  'auth_oauth_prepare',
  'auth_oauth_complete',
  'auth_oauth_cancel',
  'qqmusic_sign_out',
  'qqmusic_account_snapshot',
  'qqmusic_account_playlists',
  'qqmusic_account_playlist_tracks',
  'qqmusic_account_recently_played',
] as const;

function isMainOnlyAccountMethod(row: MethodAclRow): boolean {
  const { name } = row;
  return (
    name.startsWith('qqmusic_auth_') ||
    name.startsWith('auth_oauth_') ||
    name === 'qqmusic_sign_out' ||
    name.startsWith('qqmusic_account_')
  );
}

function surfaceRoles(): WindowRole[] {
  return SURFACE_ORIGINS.map((origin) => {
    const role = originToRole(origin);
    if (!role) {
      throw new Error(`missing WindowRole for origin ${origin}`);
    }
    return role;
  });
}

const accountRows = methods.filter(isMainOnlyAccountMethod);

describe('ACCT-04 auth ACL negatives from surfaces', () => {
  it('locks Main-only account methods to host+main origins', () => {
    const presentRequired = REQUIRED_ACCOUNT_METHODS.filter((name) =>
      methods.some((row) => row.name === name),
    );
    expect(presentRequired.length).toBeGreaterThan(0);
    expect(accountRows.map((row) => row.name)).toEqual(expect.arrayContaining([...presentRequired]));

    for (const row of accountRows) {
      expect(row.allowedOrigins.every((origin) => origin === 'host' || origin === 'main')).toBe(
        true,
      );
      for (const role of surfaceRoles()) {
        expect(methodAllowed(row, role)).toBe(false);
      }
    }
  });

  it('returns host.denied from lyric surface and unlock origins without calling Core', async () => {
    expect(accountRows.length).toBeGreaterThan(0);

    for (const origin of SURFACE_ORIGINS) {
      const role = originToRole(origin);
      expect(role).toBeDefined();
      const invoke = vi.fn(async () => ({ leaked: true }));
      const hostHandlers = Object.fromEntries(
        accountRows.map((row) => [row.name, vi.fn(async () => ({ leaked: true }))]),
      );
      const router = new IpcRouter({
        methods,
        client: { invoke },
        hostHandlers,
      });
      router.registerWindow(1, role!);

      for (const row of accountRows) {
        await expect(router.invoke(1, { method: row.name })).resolves.toEqual({
          ok: false,
          error: hostDenied(row.name, role!),
        });
        expect(hostHandlers[row.name]).not.toHaveBeenCalled();
      }
      expect(invoke).not.toHaveBeenCalled();
    }
  });
});
