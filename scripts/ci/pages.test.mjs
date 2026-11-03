import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const pages = ['site/index.html', 'site/en/index.html'];

for (const file of pages) {
  test(`${file}: navigation, documentation, assets and release downloads resolve`, () => {
    const html = readFileSync(new URL(file, root), 'utf8');
    assert.equal((html.match(/<h1\b/gu) ?? []).length, 1);
    assert.match(html, /class="skip-link" href="#download"/u);
    assert.match(html, /<iframe\b[^>]*class="stage"/u);
    assert.match(html, /https:\/\/discord\.gg\/HJbqa3Rdn9/u);
    const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    const links = [...html.matchAll(/(?:href|src)="([^"]+)"/gu)].map((m) => m[1]);
    for (const link of links) {
      if (link.startsWith('#')) {
        assert.ok(ids.includes(link.slice(1)), `missing anchor ${link}`);
      } else if (link.includes('/blob/main/')) {
        assert.ok(existsSync(new URL(link.split('/blob/main/')[1], root)), link);
      } else if (!link.startsWith('https://')) {
        const clean = link.split('?')[0];
        if (clean === 'demo/' || clean === '../demo/') {
          assert.ok(existsSync(new URL('src/development/website-demo.tsx', root)), link);
          continue;
        }
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
        const source = relative
          .replace(/^site\/assets\//u, 'assets/')
          .replace(/^site\/tokens\.css$/u, 'src/styles/tokens.css');
        assert.ok(existsSync(new URL(source, root)), source);
      }
    }
    for (const platform of ['windows', 'linux', 'android']) {
      assert.ok(
        links.some((link) => link.includes(`/releases/download/v0.1.0/YAQMC-${platform}-`)),
      );
    }
    assert.match(html, /SHA-256/u);
  });
}

test('both languages expose the same release download assets', () => {
  const downloads = pages.map((file) =>
    [...readFileSync(new URL(file, root), 'utf8').matchAll(/href="([^"]+)"/gu)]
      .map((m) => m[1])
      .filter((href) => href.includes('/releases/download/'))
      .map((href) => href.replace(/^\.\.\//u, ''))
      .sort(),
  );
  assert.deepEqual(downloads[0], downloads[1]);
});
