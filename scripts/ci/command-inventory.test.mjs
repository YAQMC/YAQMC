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

test('protocol registry names and owners match the inventory and capability origin classes', () => {
  const inventory = collectCommandInventory(repositoryRoot);
  const registry = readFileSync(
    path.join(repositoryRoot, 'crates/yaqmc-protocol/src/registry.rs'),
    'utf8',
  );
  const specs = [
    ...registry.matchAll(
      /spec\(\s*"([a-z][a-z0-9_]*)"\s*,\s*MethodOwner::(Core|Host)\s*,\s*OriginClass::(Main|Surfaces|Unlock)\s*,?\s*\)/g,
    ),
  ].map((match) => ({
    name: match[1],
    owner: match[2] === 'Host' ? 'Electron Main' : 'Core',
    origins: match[3],
  }));
  assert.deepEqual(
    specs.map((spec) => spec.name),
    inventory.rows.map((row) => row.name),
  );
  assert.deepEqual(
    specs.map((spec) => spec.owner),
    inventory.rows.map((row) => row.after),
  );

  function allows(relative) {
    return new Set(
      [
        ...readFileSync(path.join(repositoryRoot, relative), 'utf8').matchAll(
          /"allow-([a-z0-9-]+)"/g,
        ),
      ].map((match) => match[1].replaceAll('-', '_')),
    );
  }
  const surfaces = allows('src-tauri/permissions/lyrics-surface-application.toml');
  const unlock = allows('src-tauri/permissions/lyrics-surface-unlock-control.toml');
  for (const spec of specs) {
    const expected = unlock.has(spec.name)
      ? 'Unlock'
      : surfaces.has(spec.name)
        ? 'Surfaces'
        : 'Main';
    assert.equal(spec.origins, expected, spec.name);
  }
});
