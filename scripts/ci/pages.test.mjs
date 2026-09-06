import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const pages = ['site/index.html', 'site/en/index.html'];

for (const file of pages) {
  test(`${file}: navigation, documentation, assets and plugin downloads resolve`, () => {
    const html = readFileSync(new URL(file, root), 'utf8');
    assert.equal((html.match(/<h1\b/gu) ?? []).length, 1);
    assert.match(html, /class="skip-link" href="#main"/u);
    assert.doesNotMatch(html, /<script\b/iu);
    const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    const links = [...html.matchAll(/(?:href|src)="([^"]+)"/gu)].map((m) => m[1]);
    const plugins = links.filter((link) => link.endsWith('.yaqmc-plugin'));
    assert.equal(plugins.length, 9, 'retain all existing plugin examples');
    for (const link of links) {
      if (link.startsWith('#')) {
        assert.ok(ids.includes(link.slice(1)), `missing anchor ${link}`);
      } else if (link.includes('/blob/main/')) {
        assert.ok(existsSync(new URL(link.split('/blob/main/')[1], root)), link);
      } else if (!link.startsWith('https://')) {
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), link));
        const source = relative
          .replace(/^site\/assets\//u, 'assets/')
          .replace(/^site\/plugins\//u, 'examples/plugins/packages/');
        assert.ok(existsSync(new URL(source, root)), source);
      }
    }
    for (const platform of ['windows', 'linux', 'android']) {
      assert.ok(
        links.some((link) => link.includes(`/releases/download/v0.1.0/YAQMC-${platform}-`)),
      );
    }
    assert.match(html, /SmartScreen/u);
    assert.match(html, /SHA-256/u);
    assert.match(html, /Android 8\.0\+/u);
  });
}

test('both languages expose the same release assets and plugin examples', () => {
  const downloads = pages.map((file) =>
    [...readFileSync(new URL(file, root), 'utf8').matchAll(/href="([^"]+)"/gu)]
      .map((m) => m[1])
      .filter((href) => href.includes('/releases/download/') || href.endsWith('.yaqmc-plugin'))
      .map((href) => href.replace(/^\.\.\//u, ''))
      .sort(),
  );
  assert.deepEqual(downloads[0], downloads[1]);
});
