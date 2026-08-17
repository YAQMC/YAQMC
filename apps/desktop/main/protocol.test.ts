import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_CSP,
  APP_HOST,
  APP_SCHEME,
  appIndexUrl,
  mimeFor,
  resolveAppFile,
  serveAppUrl,
} from './protocol';

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'yaqmc-app-protocol-'));
}

describe('app:// protocol', () => {
  it('maps FACT Tauri asset/ipc schemes without loosening img-src', () => {
    expect(APP_CSP).toContain("default-src 'self'");
    expect(APP_CSP).toContain('img-src ');
    expect(APP_CSP).toContain('app:');
    expect(APP_CSP).toContain('https://y.gtimg.cn');
    expect(APP_CSP).toContain('https://qpic.y.qq.com');
    expect(APP_CSP).toContain("worker-src 'self' blob:");
    expect(APP_CSP).toContain('connect-src app: http://127.0.0.1:19532');
    expect(APP_CSP).not.toContain('asset:');
    expect(APP_CSP).not.toContain('ipc:');
    expect(APP_CSP).not.toContain('asset.localhost');
    expect(APP_CSP).not.toContain('ipc.localhost');
    expect(APP_CSP).not.toMatch(/(?:^|[; ])https:(?:;|$)/);
    expect(APP_CSP).not.toContain('unsafe-eval');
  });

  it('resolves index.html under the app host and rejects traversal', () => {
    const root = tempRoot();
    writeFileSync(path.join(root, 'index.html'), '<p>ok</p>');
    expect(resolveAppFile(root, `app://${APP_HOST}/index.html`)).toBe(
      path.join(root, 'index.html'),
    );
    expect(resolveAppFile(root, `app://${APP_HOST}/`)).toBe(path.join(root, 'index.html'));
    expect(resolveAppFile(root, appIndexUrl())).toBe(path.join(root, 'index.html'));
    expect(resolveAppFile(root, `app://${APP_HOST}/%2e%2e%2fsecret.html`)).toBeUndefined();
    expect(resolveAppFile(root, `app://${APP_HOST}/..\\secret.html`)).toBeUndefined();
    expect(resolveAppFile(root, 'https://example.test/index.html')).toBeUndefined();
    expect(APP_SCHEME).toBe('app');
  });

  it('serves files with a CSP response header', async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'assets'));
    writeFileSync(path.join(root, 'index.html'), '<p>ok</p>');
    writeFileSync(path.join(root, 'assets', 'app.js'), 'window.yaqmc');
    const html = await serveAppUrl(root, appIndexUrl('?provider=fake'));
    expect(html.status).toBe(200);
    expect(html.headers['Content-Security-Policy']).toBe(APP_CSP);
    expect(html.headers['Content-Type']).toBe(mimeFor('index.html'));
    expect(html.body.toString('utf8')).toBe('<p>ok</p>');
    const script = await serveAppUrl(root, `app://${APP_HOST}/assets/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    const missing = await serveAppUrl(root, `app://${APP_HOST}/missing.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers['Content-Security-Policy']).toBe(APP_CSP);
  });
});
