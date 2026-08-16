import ts from 'typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const plugins = [
  {
    id: 'script-now-playing',
    source: 'examples/plugins/script-now-playing/src/main.ts',
    out: 'examples/plugins/script-now-playing/dist/main.js',
  },
  {
    id: 'script-actions',
    source: 'examples/plugins/script-actions/src/main.ts',
    out: 'examples/plugins/script-actions/dist/main.js',
  },
  {
    id: 'script-network',
    source: 'examples/plugins/script-network/src/main.ts',
    out: 'examples/plugins/script-network/dist/main.js',
  },
];

function stripImports(source) {
  return source
    .replace(/import\s+type[\s\S]*?from\s+['"][^'"]+['"];?\s*/g, '')
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*/g, '')
    .replace(/export default definePlugin/g, 'definePlugin');
}

for (const plugin of plugins) {
  const sourcePath = path.join(root, plugin.source);
  const source = await readFile(sourcePath, 'utf8');
  const result = ts.transpileModule(stripImports(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      strict: true,
    },
    fileName: sourcePath,
  });
  if (result.diagnostics?.length) {
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(`${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}\n`);
    }
  }
  const outPath = path.join(root, plugin.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `'use strict';\n${result.outputText}`, 'utf8');
  process.stdout.write(`built ${plugin.id} -> ${plugin.out}\n`);
}

const studioOut = path.join(root, 'examples/plugins/studio/dist/main.js');
await mkdir(path.dirname(studioOut), { recursive: true });
await writeFile(
  studioOut,
  await readFile(path.join(root, 'examples/plugins/script-now-playing/dist/main.js')),
);
process.stdout.write('copied script-now-playing into studio/dist/main.js\n');
