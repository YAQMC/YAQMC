import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';

const githubRoot = path.join(repositoryRoot, '.github');

function workflowFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return workflowFiles(absolute);
    }
    return /\.ya?ml$/u.test(entry.name) ? [absolute] : [];
  });
}

test('all external GitHub Actions use immutable full commit SHAs', () => {
  const externalRefs = [];
  for (const file of workflowFiles(githubRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\buses:\s*([^\s#]+)/gu)) {
      const reference = match[1];
      if (!reference || reference.startsWith('./')) {
        continue;
      }
      externalRefs.push({ file: path.relative(repositoryRoot, file), reference });
      assert.match(
        reference,
        /^[^@]+@[0-9a-f]{40}$/u,
        `${path.relative(repositoryRoot, file)} contains mutable action ${reference}`,
      );
    }
  }
  assert.ok(externalRefs.length > 0);
});

test('Dependabot tracks immutable GitHub Actions pins', () => {
  const source = readFileSync(path.join(githubRoot, 'dependabot.yml'), 'utf8');
  assert.match(source, /package-ecosystem:\s*github-actions/u);
  assert.match(source, /interval:\s*weekly/u);
});
