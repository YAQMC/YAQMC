import type { CoreError, WindowRole } from '@yaqmc/client';
import { readFileSync } from 'node:fs';

export type MethodOwner = 'core' | 'host';

export type MethodAclRow = {
  name: string;
  owner: MethodOwner;
  allowedOrigins: readonly string[];
};

export const PROTOCOL_ORIGIN_BY_ROLE: Record<WindowRole, string> = {
  main: 'main',
  'lyrics-desktop': 'lyrics-desktop',
  'lyrics-island': 'lyrics-island',
  'unlock-desktop': 'lyrics-desktop-unlock',
  'unlock-island': 'lyrics-island-unlock',
};

export function originToRole(origin: string): WindowRole | undefined {
  switch (origin) {
    case 'main':
      return 'main';
    case 'lyrics-desktop':
      return 'lyrics-desktop';
    case 'lyrics-island':
      return 'lyrics-island';
    case 'lyrics-desktop-unlock':
      return 'unlock-desktop';
    case 'lyrics-island-unlock':
      return 'unlock-island';
    default:
      return undefined;
  }
}

export function rendererRolesFor(origins: readonly string[]): WindowRole[] {
  const roles: WindowRole[] = [];
  for (const origin of origins) {
    const role = originToRole(origin);
    if (role) {
      roles.push(role);
    }
  }
  return roles;
}

export function methodAllowed(row: MethodAclRow | undefined, role: WindowRole): boolean {
  if (!row) {
    return false;
  }
  return rendererRolesFor(row.allowedOrigins).includes(role);
}

export function hostDenied(method: string, role: WindowRole): CoreError {
  return {
    code: 'host.denied',
    message: `${method} is not allowed from ${PROTOCOL_ORIGIN_BY_ROLE[role]}`,
    retryable: false,
  };
}

export function hostOwnedUnimplemented(method: string): CoreError {
  return {
    code: 'host.denied',
    message: `${method} is implemented by the host`,
    retryable: false,
  };
}

export function eventAllowed(role: WindowRole, channel: string): boolean {
  switch (role) {
    case 'main':
      return true;
    case 'lyrics-desktop':
    case 'lyrics-island':
      return (
        channel.startsWith('lyrics://') ||
        channel === 'player://snapshot' ||
        channel === 'preferences://changed'
      );
    case 'unlock-desktop':
    case 'unlock-island':
      return channel === 'lyrics://surface-closed';
  }
}

export function parseMethodAcl(value: unknown): MethodAclRow[] {
  if (!Array.isArray(value)) {
    throw new Error('method ACL must be an array');
  }
  return value.map((row, index) => {
    if (row === null || typeof row !== 'object') {
      throw new Error(`method ACL row ${index} is not an object`);
    }
    const name = (row as { name?: unknown }).name;
    const owner = (row as { owner?: unknown }).owner;
    const allowedOrigins = (row as { allowedOrigins?: unknown }).allowedOrigins;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`method ACL row ${index} is missing name`);
    }
    if (owner !== 'core' && owner !== 'host') {
      throw new Error(`method ACL row ${index} has invalid owner`);
    }
    if (
      !Array.isArray(allowedOrigins) ||
      allowedOrigins.some((origin) => typeof origin !== 'string')
    ) {
      throw new Error(`method ACL row ${index} has invalid allowedOrigins`);
    }
    return {
      name,
      owner,
      allowedOrigins: allowedOrigins as string[],
    };
  });
}

export function loadMethodAclFromFile(filePath: string): MethodAclRow[] {
  return parseMethodAcl(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
}
