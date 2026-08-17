import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  UNREFERENCED_METHODS,
  collectCommandInventory,
  commandInventoryMarkdown,
} from './command-inventory.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

test('PROTO-02 inventory covers 117 registered methods and the frontend checksum', () => {
  const inventory = collectCommandInventory(repositoryRoot);

  assert.equal(inventory.registeredCount, 117);
  assert.equal(inventory.definitionCount, 117);
  assert.equal(inventory.referencedCount, 112);
  assert.deepEqual(inventory.unreferenced, UNREFERENCED_METHODS);
  assert.equal(inventory.attributes.textual, 118);
  assert.equal(inventory.attributes.definitions, 117);
  assert.equal(inventory.attributes.testStringInCommands, true);
  assert.equal(inventory.rows.length, 117);
  assert.equal(new Set(inventory.rows.map((row) => row.name)).size, 117);
});

test('every inventory row records protocol params, result, owner, and notes', () => {
  const inventory = collectCommandInventory(repositoryRoot);
  for (const row of inventory.rows) {
    assert.ok(row.name, 'method name');
    assert.ok(Array.isArray(row.params), `${row.name} params`);
    assert.ok(row.result, `${row.name} result`);
    assert.match(row.after, /^(Core|Electron Main)$/);
    assert.match(row.rendererRef, /^(yes|no)$/);
    if (row.rendererRef === 'no') {
      assert.match(row.notes, /Keep/);
    }
  }

  const play = inventory.rows.find((row) => row.name === 'player_play');
  assert.deepEqual(play.params, []);
  assert.equal(play.result, 'PlayerSnapshot');
  assert.equal(play.after, 'Core');

  const shortcuts = inventory.rows.find((row) => row.name === 'system_shortcuts_set_enabled');
  assert.deepEqual(shortcuts.params, ['enabled: bool']);
  assert.equal(shortcuts.result, 'DesktopIntegrationStatus');
  assert.equal(shortcuts.after, 'Electron Main');
});

test('committed command inventory is generated from the live handler scan', () => {
  const committed = readFileSync(
    path.join(repositoryRoot, 'docs/migration/command-inventory.md'),
    'utf8',
  );
  assert.equal(committed, commandInventoryMarkdown(repositoryRoot));
});
