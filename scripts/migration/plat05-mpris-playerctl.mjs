/**
 * PLAT-05: maintainer MPRIS / playerctl smoke (LIVE VERIFY pending).
 *
 * Default is --dry-run: print the commands, do not talk to a live bus.
 * `--execute` runs them (Linux only) against bus `org.mpris.MediaPlayer2.yaqmc`.
 * Raise/Quit must go through MPRIS Root → core `host://command` → Electron.
 *
 * Does not start yaqmc-core. Does not claim playerctl/applet green.
 *
 * Run: node scripts/migration/plat05-mpris-playerctl.mjs
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MPRIS_BUS = 'org.mpris.MediaPlayer2.yaqmc';
export const PLAYERCTL_PLAYER = 'yaqmc';
export const LIVE_VERIFY_STATE = 'LIVE VERIFY pending';

export function playerctlCommands(player = PLAYERCTL_PLAYER) {
  const prefix = `playerctl -p ${player}`;
  return {
    status: `${prefix} status`,
    metadata: `${prefix} metadata`,
    play: `${prefix} play`,
    pause: `${prefix} pause`,
    next: `${prefix} next`,
    previous: `${prefix} previous`,
    position: `${prefix} position`,
  };
}

export function dbusRootCommand(member, bus = MPRIS_BUS) {
  return [
    'dbus-send',
    '--print-reply',
    `--dest=${bus}`,
    '/org/mpris/MediaPlayer2',
    `org.mpris.MediaPlayer2.${member}`,
  ].join(' ');
}

export function plat05Commands() {
  return {
    ...playerctlCommands(),
    raise: dbusRootCommand('Raise'),
    quit: dbusRootCommand('Quit'),
  };
}

export function parseFlags(argv = []) {
  return {
    execute: argv.includes('--execute'),
  };
}

export function plat05Report({
  argv = process.argv.slice(2),
  platform = process.platform,
  env = process.env,
} = {}) {
  const flags = parseFlags(argv);
  return {
    id: 'PLAT-05',
    bus: MPRIS_BUS,
    playerctlPlayer: PLAYERCTL_PLAYER,
    hostPlatform: platform,
    execute: flags.execute,
    canExecute: platform === 'linux',
    commands: plat05Commands(),
    hostCommand: {
      raise: { command: 'raise' },
      quit: { command: 'quit' },
    },
    Linux: {
      playerctl: { state: LIVE_VERIFY_STATE, checked: false },
      raiseQuit: { state: LIVE_VERIFY_STATE, checked: false },
      gnomeApplet: { state: LIVE_VERIFY_STATE, checked: false },
      kdeApplet: { state: LIVE_VERIFY_STATE, checked: false },
    },
    notes: [
      'LIVE VERIFY pending. Default is dry-run; --execute is Linux-only.',
      'Raise/Quit must emit host://command {command:"raise"|"quit"}; SMTC flyout is not claimed.',
      env.DISPLAY || env.WAYLAND_DISPLAY
        ? 'Session bus env is present on this process; still does not prove MPRIS.'
        : 'No DISPLAY/WAYLAND_DISPLAY on this process (typical for this Windows host).',
      'Do not start qm-api-rs. Provenance remains BLOCKED. 32 MiB protocol hard cap unchanged.',
    ],
  };
}

function runCommand(command) {
  const result = spawnSync(command, { shell: true, encoding: 'utf8' });
  return {
    command,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

export function executePlat05({ platform = process.platform } = {}) {
  if (platform !== 'linux') {
    return {
      attempted: false,
      skipped: true,
      reason: `--execute requires Linux (host is ${platform})`,
    };
  }
  const commands = plat05Commands();
  return {
    attempted: true,
    skipped: false,
    results: {
      status: runCommand(commands.status),
      metadata: runCommand(commands.metadata),
      raise: runCommand(commands.raise),
    },
  };
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const report = plat05Report();
  const payload = { ...report };
  if (report.execute) {
    payload.execute = executePlat05();
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
