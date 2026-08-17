import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

test('Vite production base is relative for app://; serve keeps / for 1420', () => {
  const source = readFileSync(path.join(repositoryRoot, 'vite.config.ts'), 'utf8');
  assert.match(source, /base:\s*command === 'build' \? '\.\/' : '\/'/);
  assert.match(source, /port:\s*1420/);
  assert.match(source, /host:\s*'127\.0\.0\.1'/);
});
