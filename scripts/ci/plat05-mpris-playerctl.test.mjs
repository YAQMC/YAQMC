import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';
import {
  LIVE_VERIFY_STATE,
  MPRIS_BUS,
  dbusRootCommand,
  executePlat05,
  parseFlags,
  plat05Commands,
  plat05Report,
  playerctlCommands,
} from '../migration/plat05-mpris-playerctl.mjs';

const SCRIPT = path.join(repositoryRoot, 'scripts', 'migration', 'plat05-mpris-playerctl.mjs');
const DOC = path.join(repositoryRoot, 'docs', 'migration', 'plat05-mpris.md');

test('defaults to dry-run playerctl + dbus Raise/Quit and does not invent green', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, 'PLAT-05');
  assert.equal(payload.bus, MPRIS_BUS);
  assert.equal(payload.execute, false);
  assert.equal(payload.commands.status, 'playerctl -p yaqmc status');
  assert.equal(payload.commands.raise, dbusRootCommand('Raise'));
  assert.equal(payload.commands.quit, dbusRootCommand('Quit'));
  assert.deepEqual(payload.hostCommand.raise, { command: 'raise' });
  assert.deepEqual(payload.hostCommand.quit, { command: 'quit' });
  for (const key of ['playerctl', 'raiseQuit', 'gnomeApplet', 'kdeApplet']) {
    assert.equal(payload.Linux[key].state, LIVE_VERIFY_STATE);
    assert.equal(payload.Linux[key].checked, false);
  }
  assert.doesNotMatch(result.stdout, /"checked":\s*true/);
  assert.match(result.stdout, /LIVE VERIFY pending/);
});

test('command helpers stay on the FACT MPRIS bus name', () => {
  assert.equal(playerctlCommands().pause, 'playerctl -p yaqmc pause');
  assert.equal(
    dbusRootCommand('Raise'),
    'dbus-send --print-reply --dest=org.mpris.MediaPlayer2.yaqmc /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Raise',
  );
  assert.equal(plat05Commands().next, 'playerctl -p yaqmc next');
  assert.equal(parseFlags(['--execute']).execute, true);
  assert.equal(parseFlags([]).execute, false);
});

test('--execute is skipped on non-Linux hosts', () => {
  const result = executePlat05({ platform: 'win32' });
  assert.equal(result.attempted, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /Linux/);

  const report = plat05Report({ platform: 'win32', argv: [] });
  assert.equal(report.canExecute, false);
  assert.equal(report.hostPlatform, 'win32');
});

test('checklist doc does not claim MPRIS green', () => {
  const doc = readFileSync(DOC, 'utf8');
  assert.match(doc, /LIVE VERIFY pending/);
  assert.match(doc, /PLAT-05 is not green/);
  assert.match(doc, /org\.mpris\.MediaPlayer2\.yaqmc/);
  assert.match(doc, /host:\/\/command/);
  assert.doesNotMatch(doc, /matrix is green/i);
});
