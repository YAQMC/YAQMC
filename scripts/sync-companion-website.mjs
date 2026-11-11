import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[2] ?? path.join(root, '../yaqmc.github.io'));
if (output === root || output.startsWith(root + path.sep))
  throw new Error('Website checkout must be outside the client checkout');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(
  path.join(output, 'UPSTREAM.json'),
  JSON.stringify({ repository: 'YAQMC/YAQMC', revision }, null, 2) + '\n',
);
process.stdout.write('Website renderer pinned to ' + revision + '\n');
