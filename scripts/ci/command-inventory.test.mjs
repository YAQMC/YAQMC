import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  DIALOG_SPLITS,
  POST_BRIDGE_CLIENT_MAPPED_METHODS,
  PROTO02_BASELINE_REFERENCED_COUNT,
  UNREFERENCED_METHODS,
  assertBridgeUsageComplete,
  classifyFrontendUsage,
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
  'app_settings_get',
  'app_settings_set',
  'app_settings_remove',
  'diagnostics_export_bundle_to',
  'preferences_set_background_from',
  'plugin_install_from',
];

test('PROTO-02 inventory covers 117 registered methods and the frontend checksum', () => {
  const inventory = collectCommandInventory(repositoryRoot);

  assert.equal(inventory.registeredCount, 117);
  assert.equal(inventory.definitionCount, 117);
  assert.equal(inventory.referencedCount, PROTO02_BASELINE_REFERENCED_COUNT);
  assert.equal(inventory.referencedCount, 112);
  assert.deepEqual(inventory.unreferenced, UNREFERENCED_METHODS);
  assert.equal(inventory.attributes.textual, 118);
  assert.equal(inventory.attributes.definitions, 117);
  assert.equal(inventory.attributes.testStringInCommands, true);
  assert.equal(inventory.rows.length, 117);
  assert.equal(new Set(inventory.rows.map((row) => row.name)).size, 117);
});

test('post-bridge src quotes are classified through YaqmcClient instead of shrinking 112', () => {
  const inventory = collectCommandInventory(repositoryRoot);
  const { usage } = inventory;

  assert.equal(usage.baselineReferencedCount, 112);
  assert.equal(
    usage.directReferencedCount,
    PROTO02_BASELINE_REFERENCED_COUNT - POST_BRIDGE_CLIENT_MAPPED_METHODS.length,
  );
  assert.deepEqual(usage.missingFromDirect, [...POST_BRIDGE_CLIENT_MAPPED_METHODS]);
  assert.deepEqual(usage.unmapped, []);
  assert.deepEqual(usage.unexpectedDirectGap, []);
  assert.deepEqual(usage.staleClientMapped, []);
  assert.deepEqual(usage.clientMappedMissingFromClient, []);
  assert.notEqual(usage.directReferencedCount, 112);
  assertBridgeUsageComplete(usage);

  for (const name of POST_BRIDGE_CLIENT_MAPPED_METHODS) {
    const row = inventory.rows.find((entry) => entry.name === name);
    assert.equal(row.rendererRef, 'yes', name);
    assert.equal(row.after, 'Core', name);
  }
});

test('a genuinely unmapped baseline method still fails the gate', () => {
  const usage = classifyFrontendUsage({
    registeredNames: ['qqmusic_home', 'player_seek', 'player_toggle'],
    baselineUnreferenced: [],
    clientMapped: ['player_toggle'],
    directRefs: new Set(['qqmusic_home']),
    clientRefs: new Set(['qqmusic_home', 'player_toggle']),
  });
  assert.equal(usage.baselineReferencedCount, 3);
  assert.deepEqual(usage.unmapped, ['player_seek']);
  assert.deepEqual(usage.unexpectedDirectGap, ['player_seek']);
  assert.throws(() => assertBridgeUsageComplete(usage), /unmapped baseline methods: player_seek/);
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

test('committed command inventory is generated from the live handler scan', async () => {
  const committed = readFileSync(
    path.join(repositoryRoot, 'docs/migration/command-inventory.md'),
    'utf8',
  );
  const generated = await commandInventoryMarkdown(repositoryRoot);
  assert.equal(committed, generated);
});

test('protocol registry names and owners match the inventory and capability origin classes', () => {
  const inventory = collectCommandInventory(repositoryRoot);
  const registry = readFileSync(
    path.join(repositoryRoot, 'crates/yaqmc-protocol/src/registry.rs'),
    'utf8',
  );
  const framing = readFileSync(
    path.join(repositoryRoot, 'crates/yaqmc-protocol/src/framing.rs'),
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
  assert.equal(specs.length, 129);

  assert.match(framing, /FRAME_HARD_CAP_BYTES: u32 = 32 \* 1024 \* 1024/);
  assert.match(framing, /DEFAULT_METHOD_PAYLOAD_BYTES: u32 = 1024 \* 1024/);
  assert.match(registry, /PLUGIN_READ_ASSET_RESPONSE_CAP: u32 = 6 \* 1024 \* 1024/);
  assert.match(registry, /request_cap: DEFAULT_METHOD_PAYLOAD_BYTES/);
  assert.match(registry, /if const_eq\(name, "plugin_read_asset"\)/);
  assert.match(registry, /PLUGIN_READ_ASSET_RESPONSE_CAP/);
  assert.match(
    registry,
    /if const_starts_with\(name, "player_"\) \|\| const_eq\(name, "core_ping"\)/,
  );
  assert.match(registry, /TimeoutClass::Control/);
  assert.match(registry, /TimeoutClass::Long/);
  assert.match(registry, /TimeoutClass::Standard/);
  assert.match(registry, /plugin_install_unpacked/);
  assert.match(registry, /diagnostics_export_bundle_to/);
  assert.doesNotMatch(registry, /FRAME_HARD_CAP_BYTES \+ 1/);
  assert.match(registry, /length <= FRAME_HARD_CAP_BYTES/);

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

test('dialog-split Core IO methods are registered as protocol-only Core methods', () => {
  for (const [, next] of DIALOG_SPLITS) {
    assert.ok(PROTOCOL_ONLY_METHODS.includes(next), next);
  }
});
