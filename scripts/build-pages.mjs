import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repositoryRoot, 'dist', 'pages');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(repositoryRoot, 'site'), output, { recursive: true });
await mkdir(path.join(output, 'assets'), { recursive: true });
await cp(
  path.join(repositoryRoot, 'assets', 'yaqmc-logo.png'),
  path.join(output, 'assets', 'yaqmc-logo.png'),
);
const pluginPackages = path.join(repositoryRoot, 'examples', 'plugins', 'packages');
await mkdir(path.join(output, 'plugins'), { recursive: true });
await cp(pluginPackages, path.join(output, 'plugins'), { recursive: true });
await writeFile(path.join(output, '.nojekyll'), '', 'utf8');

process.stdout.write(`Built GitHub Pages artifact at ${path.relative(repositoryRoot, output)}\n`);
