import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { format as formatWithPrettier, resolveConfig } from 'prettier';

const HOST_INJECTION = /^(?:tauri::)?(?:AppHandle|WebviewWindow|Window|State)\b/;
const COMMAND_DEFINITION =
  /#\[tauri::command\](?:\r?\n#\[[^\]]+\])*\r?\n(?:pub\s+)?(?:async\s+)?fn\s+([a-z][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*(?:->\s*([\s\S]*?))?\s*\{/g;

export const HOST_OWNED_METHODS = new Set([
  'system_integration_status',
  'system_shortcuts_set_enabled',
  'qqmusic_auth_oauth_start',
  'appearance_pick_background',
  'lyrics_surfaces_reconcile',
  'lyrics_surface_capabilities',
  'lyrics_surface_status',
  'lyrics_surfaces_unlock_all',
  'lyrics_surface_unlock',
  'lyrics_surface_close',
  'lyrics_surface_set_interaction',
  'lyrics_surface_reset_position',
  'lyrics_surface_show_settings',
  'diagnostics_reveal_bundle',
  'diagnostics_open_log_folder',
  'plugin_pick_package',
  'plugin_pick_directory',
]);

/** PROTO-02 baseline: these five were unreferenced by `src/` at inventory time. */
export const UNREFERENCED_METHODS = [
  'system_integration_status',
  'player_play',
  'player_pause',
  'lyrics_surface_status',
  'plugin_diagnostics',
];

/** Immutable PROTO-02 frontend checksum: 117 registered minus the five above. */
export const PROTO02_BASELINE_REFERENCED_COUNT = 112;

/**
 * Baseline-112 names that left `src/` string literals after P6 wrapped player/lyrics
 * calls in `YaqmcClient`. Still live protocol methods; not retired, renamed, or host-replaced.
 * Order matches `generate_handler!`.
 */
export const POST_BRIDGE_CLIENT_MAPPED_METHODS = [
  'player_snapshot',
  'player_hydrate_queue',
  'player_play_tracks',
  'player_play_from_queue',
  'player_play_queue_entry',
  'player_toggle',
  'player_next',
  'player_previous',
  'player_seek',
  'player_set_volume',
  'player_toggle_muted',
  'player_toggle_shuffle',
  'player_set_shuffle',
  'player_cycle_repeat',
  'player_set_repeat',
  'player_set_primary_playback_mode',
  'player_add_to_queue',
  'player_add_tracks_to_queue',
  'player_remove_from_queue',
  'player_remove_queue_entry',
  'player_reorder_queue_entry',
  'player_play_next_queue_entry',
  'player_lyrics',
  'lyrics_surface_projection',
];

export const DIALOG_SPLITS = [
  ['diagnostics_export_bundle', 'diagnostics_export_bundle_to'],
  ['appearance_pick_background', 'preferences_set_background_from'],
  ['plugin_pick_package', 'plugin_install_from'],
];

function read(repositoryRoot, relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolutePath));
    else files.push(absolutePath);
  }
  return files;
}

function collapseType(source) {
  return source.replace(/\s+/g, ' ').trim();
}

function splitParams(paramList) {
  const params = [];
  let current = '';
  let depth = 0;
  for (const character of paramList) {
    if (character === '<' || character === '(') depth += 1;
    else if (character === '>' || character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      if (current.trim()) params.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

function protocolParams(paramList) {
  return splitParams(paramList)
    .map((parameter) => {
      const separator = parameter.indexOf(':');
      if (separator < 0) return null;
      const name = parameter.slice(0, separator).trim();
      const type = collapseType(parameter.slice(separator + 1));
      if (!name || HOST_INJECTION.test(type)) return null;
      return `${name}: ${type}`;
    })
    .filter(Boolean);
}

function protocolResult(returnType) {
  const collapsed = collapseType(returnType || '()');
  const wrapped = /^CommandResult<\s*([\s\S]*)\s*>$/.exec(collapsed);
  return wrapped ? collapseType(wrapped[1]) : collapsed;
}

function parseCommandFile(repositoryRoot, relativePath) {
  const source = read(repositoryRoot, relativePath);
  const commands = [];
  for (const match of source.matchAll(COMMAND_DEFINITION)) {
    const name = match[1];
    const index = match.index ?? 0;
    const line = source.slice(0, index).split(/\r?\n/).length;
    commands.push({
      name,
      declaration: `${relativePath.replaceAll('\\', '/')}:${line}`,
      params: protocolParams(match[2]),
      result: protocolResult(match[3]),
    });
  }
  return commands;
}

export function collectRegisteredCommands(repositoryRoot) {
  const registrationSource = read(repositoryRoot, 'src-tauri/src/lib.rs');
  const handlerBlock = /\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/.exec(
    registrationSource,
  )?.[1];
  if (!handlerBlock) {
    throw new Error('generate_handler registration block is missing');
  }
  return [...handlerBlock.matchAll(/(?:^|\s)(?:[a-z_]+::)*commands::([a-z][a-z0-9_]*)\s*,/g)].map(
    (match) => {
      const name = match[1];
      const index = match.index ?? 0;
      const prefix = registrationSource.slice(0, registrationSource.indexOf(handlerBlock) + index);
      return {
        name,
        registration: `src-tauri/src/lib.rs:${prefix.split(/\r?\n/).length}`,
      };
    },
  );
}

export function collectCommandDefinitions(repositoryRoot) {
  return [
    ...parseCommandFile(repositoryRoot, 'src-tauri/src/commands.rs'),
    ...parseCommandFile(repositoryRoot, 'src-tauri/src/plugin/commands.rs'),
  ];
}

export function collectTauriCommandAttributeCount(repositoryRoot) {
  const commands = read(repositoryRoot, 'src-tauri/src/commands.rs');
  const plugin = read(repositoryRoot, 'src-tauri/src/plugin/commands.rs');
  return {
    textual:
      (commands.match(/#\[tauri::command\]/g) ?? []).length +
      (plugin.match(/#\[tauri::command\]/g) ?? []).length,
    definitions: collectCommandDefinitions(repositoryRoot).length,
    testStringInCommands:
      commands.includes('.split_once("\\n#[tauri::command]")') ||
      commands.includes('.split_once("\n#[tauri::command]")'),
  };
}

function collectQuotedSnakeNames(directory, { skipTests = true } = {}) {
  const names = new Set();
  for (const file of walk(directory)) {
    const relative = path.relative(directory, file).replaceAll('\\', '/');
    if (!/\.tsx?$/.test(relative)) continue;
    if (skipTests && /\.test\.tsx?$/.test(relative)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/'([a-z][a-z0-9_]*)'/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

/** Live `src/` quote scan. This is the post-bridge usage graph, not the PROTO-02 baseline. */
export function collectFrontendCommandReferences(repositoryRoot) {
  return collectQuotedSnakeNames(path.join(repositoryRoot, 'src'));
}

/** Protocol names `YaqmcClient` still invokes. Not the full `TAURI_METHOD_NAMES` list. */
export function collectClientCommandReferences(repositoryRoot) {
  const source = read(repositoryRoot, 'packages/yaqmc-client/src/client.ts');
  return new Set(
    [...source.matchAll(/this\.invoke\('([a-z][a-z0-9_]*)'/g)].map((match) => match[1]),
  );
}

export function classifyFrontendUsage({
  registeredNames,
  baselineUnreferenced = UNREFERENCED_METHODS,
  clientMapped = POST_BRIDGE_CLIENT_MAPPED_METHODS,
  directRefs,
  clientRefs,
}) {
  const unreferenced = new Set(baselineUnreferenced);
  const classifiedClient = new Set(clientMapped);
  const baselineReferenced = registeredNames.filter((name) => !unreferenced.has(name));
  const missingFromDirect = baselineReferenced.filter((name) => !directRefs.has(name));
  const unexpectedDirectGap = missingFromDirect.filter((name) => !classifiedClient.has(name));
  const staleClientMapped = clientMapped.filter((name) => !missingFromDirect.includes(name));
  const unmapped = missingFromDirect.filter((name) => !clientRefs.has(name));
  const clientMappedMissingFromClient = clientMapped.filter((name) => !clientRefs.has(name));
  return {
    baselineReferencedCount: baselineReferenced.length,
    directReferencedCount: baselineReferenced.length - missingFromDirect.length,
    missingFromDirect,
    unexpectedDirectGap,
    staleClientMapped,
    unmapped,
    clientMappedMissingFromClient,
  };
}

export function assertBridgeUsageComplete(usage) {
  const problems = [];
  if (usage.baselineReferencedCount !== PROTO02_BASELINE_REFERENCED_COUNT) {
    problems.push(
      `baseline referenced ${usage.baselineReferencedCount}, expected ${PROTO02_BASELINE_REFERENCED_COUNT}`,
    );
  }
  if (usage.unmapped.length > 0) {
    problems.push(`unmapped baseline methods: ${usage.unmapped.join(', ')}`);
  }
  if (usage.unexpectedDirectGap.length > 0) {
    problems.push(
      `src gap not classified as client-mapped: ${usage.unexpectedDirectGap.join(', ')}`,
    );
  }
  if (usage.staleClientMapped.length > 0) {
    problems.push(
      `client-mapped class still quoted in src/: ${usage.staleClientMapped.join(', ')}`,
    );
  }
  if (usage.clientMappedMissingFromClient.length > 0) {
    problems.push(
      `client-mapped class missing from yaqmc-client: ${usage.clientMappedMissingFromClient.join(', ')}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`frontend usage graph incomplete: ${problems.join('; ')}`);
  }
}

function notesFor(name, referenced) {
  const notes = [];
  if (!referenced) {
    notes.push(
      'Keep; renderer source strings do not invoke it. Host/tray/plugin/local-API callers remain valid.',
    );
  }
  const split = DIALOG_SPLITS.find(([current]) => current === name);
  if (split) {
    notes.push(`Approved P13 split: host picks path, Core IO becomes \`${split[1]}\`.`);
  }
  return notes.join(' ');
}

export function collectCommandInventory(repositoryRoot) {
  const registered = collectRegisteredCommands(repositoryRoot);
  const definitions = new Map(
    collectCommandDefinitions(repositoryRoot).map((command) => [command.name, command]),
  );
  const directFrontend = collectFrontendCommandReferences(repositoryRoot);
  const clientRefs = collectClientCommandReferences(repositoryRoot);
  const attributes = collectTauriCommandAttributeCount(repositoryRoot);
  const usage = classifyFrontendUsage({
    registeredNames: registered.map((entry) => entry.name),
    directRefs: directFrontend,
    clientRefs,
  });
  assertBridgeUsageComplete(usage);

  const rows = registered.map((entry, index) => {
    const definition = definitions.get(entry.name);
    if (!definition) {
      throw new Error(`registered command has no #[tauri::command] definition: ${entry.name}`);
    }
    const referenced = !UNREFERENCED_METHODS.includes(entry.name);
    return {
      index: index + 1,
      name: entry.name,
      declaration: definition.declaration.replace(/^src-tauri\/src\//, ''),
      registration: entry.registration.replace(/^src-tauri\/src\//, ''),
      params: definition.params,
      result: definition.result,
      rendererRef: referenced ? 'yes' : 'no',
      after: HOST_OWNED_METHODS.has(entry.name) ? 'Electron Main' : 'Core',
      notes: notesFor(entry.name, referenced),
    };
  });

  const unreferenced = rows.filter((row) => row.rendererRef === 'no').map((row) => row.name);
  return {
    rows,
    unreferenced,
    attributes,
    usage,
    registeredCount: registered.length,
    definitionCount: definitions.size,
    referencedCount: rows.filter((row) => row.rendererRef === 'yes').length,
    directReferencedCount: usage.directReferencedCount,
  };
}

function escapeCell(value) {
  return value.replaceAll('|', '\\|');
}

export function renderCommandInventory(inventory) {
  const header = `# Command inventory

This is the authoritative P2 inventory of the 117 commands registered by \`tauri::generate_handler!\`.

## Generation contract

The inventory is generated mechanically from the handler block in \`src-tauri/src/lib.rs\`, joined to each
\`#[tauri::command] pub fn\` declaration in \`src-tauri/src/commands.rs\` or \`src-tauri/src/plugin/commands.rs\`.
\`Params\` omits Tauri injection arguments (\`AppHandle\`, \`State\`, \`WebviewWindow\`, \`Window\`). \`Result\` unwraps
\`CommandResult<T>\` to the serde payload type \`T\`. \`Renderer ref\` is the immutable PROTO-02 frontend checksum
(112 yes / 5 no), not the live \`src/\` quote scan. After P6, player/lyrics calls moved behind \`YaqmcClient\`;
those names still exist in \`packages/yaqmc-client\` and the 117-method registry.

- Handler entries: ${inventory.registeredCount}; unique handler names: ${inventory.registeredCount}.
- Function attributes: ${inventory.definitionCount} unique command functions. Textual \`#[tauri::command]\` matches:
  ${inventory.attributes.textual}. The extra match is the test string in \`src-tauri/src/commands.rs\`, not a command
  definition, and is not registered.
- Renderer refs: ${inventory.referencedCount} yes, ${inventory.unreferenced.length} no — ${inventory.unreferenced
    .map((name) => `\`${name}\``)
    .join(', ')}.
- Post-bridge usage: live \`src/\` still quotes ${PROTO02_BASELINE_REFERENCED_COUNT - POST_BRIDGE_CLIENT_MAPPED_METHODS.length} of the 112. The other ${POST_BRIDGE_CLIENT_MAPPED_METHODS.length} are client-mapped, not retired: ${POST_BRIDGE_CLIENT_MAPPED_METHODS.map(
    (name) => `\`${name}\``,
  ).join(', ')}.
- \`After\` is the planned v1 owner. Electron Main entries retain the public method during coexistence; the three
  dialog paths are the approved future split described below.

| # | Method | Params | Result | Current declaration / registration | Renderer ref | After | Notes |
|---:|---|---|---|---|---|---|---|
`;

  const rows = inventory.rows
    .map((row) => {
      const params = row.params.length === 0 ? '—' : `\`${row.params.join(', ')}\``;
      return `| ${row.index} | \`${row.name}\` | ${escapeCell(params)} | \`${escapeCell(row.result)}\` | \`${row.declaration}\`; \`${row.registration}\` | ${row.rendererRef} | ${row.after} | ${escapeCell(row.notes || '—')} |`;
    })
    .join('\n');

  const footer = `

## Planned host and dialog disposition

Electron Main owns the listed platform integration, shortcut, OAuth-window, diagnostic file-manager, picker, and lyrics-surface methods. Core retains all stateful provider, player, preferences, local API, diagnostics, and plugin operations. Main must derive the renderer origin from \`webContents.id\`; renderer-supplied origin is never trusted, and Core repeats method-ACL checks before dispatch.

The three approved dialog splits are \`diagnostics_export_bundle\` → \`diagnostics_export_bundle_to\`, \`appearance_pick_background\` → \`preferences_set_background_from\`, and \`plugin_pick_package\` → \`plugin_install_from\`. Main selects the path; Core performs IO. Existing public dialog methods remain only through the planned P13 retirement.

The five renderer-unreferenced methods stay in the v1 registry. \`player_play\` and \`player_pause\` remain Core playback methods; \`plugin_diagnostics\` remains a Core plugin method; \`system_integration_status\` and \`lyrics_surface_status\` remain Electron Main host methods. They are not retired because host-side callers and the 117-name identity contract still require them.

The 24 post-bridge client-mapped methods remain Core protocol names on \`YaqmcClient.player.*\`. They are not host-owned replacements, dialog splits, or retirements.

The 118th textual \`#[tauri::command]\` occurrence is a test string inside \`every_account_command_uses_the_main_window_guard_contract\`, not an unregistered command function, and must not be added to the protocol registry.
`;

  return `${header}${rows}${footer}`;
}

export async function commandInventoryMarkdown(repositoryRoot) {
  const filepath = path.join(repositoryRoot, 'docs/migration/command-inventory.md');
  const config = await resolveConfig(filepath);
  return formatWithPrettier(renderCommandInventory(collectCommandInventory(repositoryRoot)), {
    ...config,
    filepath,
    parser: 'markdown',
  });
}
