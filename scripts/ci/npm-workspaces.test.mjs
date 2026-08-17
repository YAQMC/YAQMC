import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

test('root package.json declares npm workspaces for packages and apps', () => {
  const pkg = readJson('package.json');
  assert.deepEqual(pkg.workspaces, ['packages/*', 'apps/*']);
});

test('root tsconfig references the @yaqmc/client project', () => {
  const tsconfig = readJson('tsconfig.json');
  assert.ok(
    tsconfig.references.some((reference) => reference.path === './packages/yaqmc-client'),
    'tsconfig.json must reference ./packages/yaqmc-client',
  );
});

test('@yaqmc/client is a composite workspace package', () => {
  const pkg = readJson('packages/yaqmc-client/package.json');
  assert.equal(pkg.name, '@yaqmc/client');
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.build, 'tsc -b');
  const tsconfig = readJson('packages/yaqmc-client/tsconfig.json');
  assert.equal(tsconfig.compilerOptions.composite, true);
  assert.equal(tsconfig.compilerOptions.strict, true);
});
