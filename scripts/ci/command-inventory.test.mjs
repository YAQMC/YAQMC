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
const PROTOCOL_ONLY_METHODS = [
  'core_ping',
  'platform_attach',
  'core_shutdown_prepare',
  'auth_oauth_prepare',
  'auth_oauth_complete',
  'auth_oauth_cancel',
];

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
    specs.map((spec) => spec.name).filter((name) => !PROTOCOL_ONLY_METHODS.includes(name)),
    inventory.rows.map((row) => row.name),
  );
  assert.deepEqual(
    specs.filter((spec) => !PROTOCOL_ONLY_METHODS.includes(spec.name)).map((spec) => spec.owner),
    inventory.rows.map((row) => row.after),
  );
  assert.deepEqual(
    specs.filter((spec) => PROTOCOL_ONLY_METHODS.includes(spec.name)).map((spec) => spec.name),
    PROTOCOL_ONLY_METHODS,
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

test('CLIENT-02 TypeScript method names match the inventory plus protocol-only methods', () => {
  const inventory = collectCommandInventory(repositoryRoot);
  const source = readFileSync(
    path.join(repositoryRoot, 'packages/yaqmc-client/src/protocol/methods.ts'),
    'utf8',
  );
  const block = (name) => {
    const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
    assert.ok(match, name);
    return [...match[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((entry) => entry[1]);
  };
  const tauri = block('TAURI_METHOD_NAMES');
  const protocolOnly = block('PROTOCOL_ONLY_METHODS');
  assert.deepEqual(
    tauri,
    inventory.rows.map((row) => row.name),
  );
  assert.deepEqual(protocolOnly, PROTOCOL_ONLY_METHODS);
});
