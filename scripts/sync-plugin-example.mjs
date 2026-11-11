import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const starterRoot = path.join(repositoryRoot, 'examples/plugins/starter');
const check = process.argv.includes('--check');
const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0 && !process.argv[outIndex + 1]) throw new Error('--out requires a directory');
const externalRoot = path.resolve(
  outIndex >= 0
    ? process.argv[outIndex + 1]
    : path.join(repositoryRoot, '..', 'YAQMC-plugin-example'),
);
const normalize = (value) => value.replaceAll('\r\n', '\n');
const read = async (file) => normalize(await readFile(path.join(repositoryRoot, file), 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (file) =>
  access(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
const generated = new Map();
const formatting = {
  ...(await resolveConfig(path.join(repositoryRoot, 'package.json'))),
  endOfLine: 'lf',
};

const sdk = await read('sdk/plugin/src/index.ts');
generated.set('api/sdk.ts', sdk);
generated.set(
  'api/globals.d.ts',
  "import type { PluginDefinition } from './sdk';\ndeclare global { function definePlugin(definition: PluginDefinition): PluginDefinition; }\n",
);
generated.set('api/YAQMC-LICENSE', await read('LICENSE'));
generated.set('api/wit/yaqmc-provider.wit', await read('wit/yaqmc-provider/yaqmc-provider.wit'));
const documents = [];
for (const directory of ['docs', 'docs/zh-CN']) {
  for (const entry of await readdir(path.join(repositoryRoot, directory), {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      entry.name.endsWith('.md') &&
      (entry.name.startsWith('plugin-') || entry.name === 'provider-component-api.md')
    )
      documents.push(`${directory}/${entry.name}`);
  }
}
documents.sort();
const mapped = new Map(documents.map((file) => [file, `api/${file}`]));
mapped.set('sdk/plugin/src/index.ts', 'api/sdk.ts');
// Keep copied documentation links navigable; references outside the offline bundle link to source.
for (const file of documents) {
  const destination = mapped.get(file);
  const content = (await read(file)).replace(/\]\(([^\s)]+)\)/g, (match, target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return match;
    const [relative, anchor = ''] = target.split('#');
    const source = path.posix.normalize(path.posix.join(path.posix.dirname(file), relative));
    const local = mapped.get(source);
    const link = local
      ? path.posix.relative(path.posix.dirname(destination), local)
      : `https://github.com/YAQMC/YAQMC/blob/main/${source.split('/').map(encodeURIComponent).join('/')}`;
    return `](${link}${anchor ? `#${anchor}` : ''})`;
  });
  generated.set(destination, content);
}

const contracts = [
  'sdk/plugin/src/index.ts',
  'wit/yaqmc-provider/yaqmc-provider.wit',
  'src/application/plugin-runtime.ts',
  'src/application/plugin-pages.ts',
  'src/application/plugin-ui.ts',
  'src/application/plugin-song-badges.ts',
  'crates/yaqmc-core/src/plugin/bridge.rs',
  'crates/yaqmc-core/src/plugin/permissions.rs',
  'crates/yaqmc-core/src/plugin/manifest.rs',
  'crates/yaqmc-core/src/plugin/component_host.rs',
  'packages/yaqmc-client/src/bridge.ts',
];
const sources = {};
for (const file of [...contracts, ...documents]) sources[file] = hash(await read(file));
generated.set('api/contract.json', `${JSON.stringify({ schemaVersion: 1, sources }, null, 2)}\n`);
generated.set(
  'API.md',
  [
    '# YAQMC 插件 API 参考',
    '',
    '由 YAQMC 的 SDK 与公共文档生成。请在仓库执行 `npm run plugin:example:sync` 更新。',
    '',
    '| 接口 | 权限 |',
    '| --- | --- |',
    '| `ctx.track.get/read` | `track.read` |',
    '| `ctx.lyrics.get/read` | `lyrics.read` |',
    '| `ctx.player.get/read` | `player.read` |',
    '| `ctx.player.play/pause/toggle/next/previous/seek` | `player.control` |',
    '| `ctx.theme.get` | `theme.read` |',
    '| `ctx.storage.get/set`, `ctx.settings.get/set` | `plugin.storage` |',
    '| `ctx.ui.lyrics.register/unregister` | `ui.lyrics`（API v4） |',
    '| `ctx.ui.contextMenu.track.register` | `ui.contextMenu` |',
    '| `ctx.ui.playerBar.register`, `ctx.ui.sidebar.register`, `ctx.ui.notify` | 对应的同名 UI 权限 |',
    '| `ctx.pages.*`, `ctx.navigation.*`, `ctx.layout.*` | `ui.pages`、`ui.navigation`、`ui.layout`（API v4） |',
    '| `ctx.scenes.*` | `scene.register` |',
    '| `ctx.network.request` | `network:https://精确域名` |',
    '| `ctx.events.on`, `ctx.log.info/warn/error` | 事件数据按权限过滤；日志不需额外权限 |',
    '',
    'API v1/v2/v4 是 Worker 脚本，API v3 是独立的 Wasm Provider Component；两种包形状与权限不能混用。',
    '脚本使用 `definePlugin({ activate(ctx) { … } })`。`activate` 可返回清理函数；宿主停用时自动清理 UI。',
    '窗口动作必须声明到歌词按钮上，宿主仅在用户点击时执行。没有原始窗口、DOM、文件、进程或账号凭据接口。',
    '',
    '- [插件开发](api/docs/zh-CN/plugin-development.md)',
    '- [歌词工具栏](api/docs/zh-CN/plugin-lyrics-api.md)',
    '- [页面、导航与布局](api/docs/zh-CN/plugin-pages-api.md)',
    '- [清单与版本](api/docs/zh-CN/plugin-manifest.md)',
    '- [Provider Component](api/docs/zh-CN/provider-component-api.md)',
    '- [安全边界](api/docs/zh-CN/plugin-security.md)',
    '',
    '以下类型直接来自 `sdk/plugin/src/index.ts`，包含完整参数、返回值与事件类型：',
    '',
    '```ts',
    sdk.trimEnd(),
    '```',
    '',
  ].join('\n'),
);

const stale = [];
for (const [file, raw] of generated) {
  const content = /\.(md|ts|json)$/.test(file)
    ? await format(raw, { ...formatting, filepath: file })
    : raw;
  generated.set(file, content);
  const destination = path.join(starterRoot, file);
  const current = (await exists(destination))
    ? normalize(await readFile(destination, 'utf8'))
    : null;
  if (current === content) continue;
  if (check) stale.push(file);
  else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}
if (stale.length)
  throw new Error(
    `Plugin API example is stale (${stale.join(', ')}). Run npm run plugin:example:sync and commit the generated files.`,
  );
if (check) {
  process.stdout.write(`Plugin example API is synchronized (${generated.size} generated files).\n`);
} else {
  process.stdout.write(`Synchronized plugin example API (${generated.size} generated files).\n`);
  const marker = path.join(externalRoot, '.yaqmc-example.json');
  if (process.argv.includes('--export') || (await exists(marker))) await exportExample();
}

async function exportExample() {
  const actualRepository = await realpath(repositoryRoot);
  const actualParent = await realpath(path.dirname(externalRoot));
  const actualTarget = (await exists(externalRoot))
    ? await realpath(externalRoot)
    : path.join(actualParent, path.basename(externalRoot));
  const relative = path.relative(actualRepository, actualTarget);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw new Error('Export the standalone example outside the YAQMC repository');
  const expectedMarker = 'YAQMC plugin example v1';
  let previous = { files: {} };
  if (await exists(path.join(actualTarget, '.yaqmc-example.json'))) {
    previous = JSON.parse(await readFile(path.join(actualTarget, '.yaqmc-example.json'), 'utf8'));
    if (previous.kind !== expectedMarker) throw new Error('Unrecognized example export marker');
  }
  const files = new Map(generated);
  await mkdir(actualTarget, { recursive: true });
  for (const file of [
    'manifest.json',
    'main.js',
    'package.json',
    'jsconfig.json',
    'pack.mjs',
    'README.md',
    'LICENSE',
  ])
    files.set(file, normalize(await readFile(path.join(starterRoot, file), 'utf8')));
  const updates = [];
  const nextHashes = { ...previous.files };
  for (const [file, content] of files) {
    const destination = path.join(actualTarget, file);
    // Resolve existing ancestors to reject symlinks escaping the requested output directory.
    let ancestor = destination;
    while (!(await exists(ancestor))) ancestor = path.dirname(ancestor);
    const resolvedAncestor = await realpath(ancestor);
    const relativeAncestor = path.relative(actualTarget, resolvedAncestor);
    if (
      relativeAncestor === '..' ||
      relativeAncestor.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeAncestor)
    )
      throw new Error(`Export path escapes the example directory: ${file}`);
    const current = (await exists(destination))
      ? normalize(await readFile(destination, 'utf8'))
      : null;
    if (current !== null && current !== content && hash(current) !== previous.files[file]) {
      // User plugin code belongs to the user. Still refresh the unmodified API docs.
      if (file === 'main.js' || file === 'manifest.json') {
        process.stdout.write(`Preserved edited plugin file: ${destination}\n`);
        continue;
      }
      throw new Error(`Example export conflicts with an edited file: ${destination}`);
    }
    updates.push([destination, content]);
    nextHashes[file] = hash(content);
  }
  for (const [destination, content] of updates) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  await writeFile(
    path.join(actualTarget, '.yaqmc-example.json'),
    `${JSON.stringify({ kind: expectedMarker, files: nextHashes }, null, 2)}\n`,
  );
  process.stdout.write(`Exported standalone example to ${actualTarget}\n`);
}
