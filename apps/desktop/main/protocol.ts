import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'yaqmc';

/**
 * SEC-01 CSP port. FACT source: `src-tauri/tauri.conf.json` `app.security.csp`:
 *
 *   default-src 'self';
 *   img-src 'self' data: asset: http://asset.localhost https://y.gtimg.cn
 *     https://qpic.y.qq.com https://q.qlogo.cn https://thirdwx.qlogo.cn
 *     https://thirdqq.qlogo.cn https://y.qq.com;
 *   style-src 'self' 'unsafe-inline';
 *   font-src 'self';
 *   connect-src ipc: http://ipc.localhost;
 *   worker-src 'self' blob:
 *
 * Directive mapping (do not loosen):
 * - default-src 'self' — unchanged. 'self' is app://yaqmc after the privileged scheme.
 * - img-src — drop `asset:` and `http://asset.localhost`, add `app:`. Keep `data:` and
 *   the six QQ image hosts. Reject §28.3's `https:` wildcard.
 * - style-src 'self' 'unsafe-inline' — unchanged.
 * - font-src 'self' — unchanged. FACT has no extra font CDNs.
 * - connect-src — `ipc:` → `app:`; `http://ipc.localhost` → `http://127.0.0.1:19532`
 *   (local API). No extra `ws:` here (dev HMR is `!app.isPackaged`, later).
 * - worker-src 'self' blob: — unchanged (plugin blob workers).
 * - script-src — absent in FACT, so default-src applies. No 'unsafe-inline'/'unsafe-eval'.
 * - media-src — absent in FACT; §28.3 would add it. Playback is native (rodio), so omit.
 * - object-src / frame-src / base-uri — absent in FACT; do not add.
 *
 * Delivered as a protocol-handler response header (not a meta tag) so workers inherit it.
 */
export const APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data: app: https://y.gtimg.cn https://qpic.y.qq.com https://q.qlogo.cn https://thirdwx.qlogo.cn https://thirdqq.qlogo.cn https://y.qq.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  'connect-src app: http://127.0.0.1:19532',
  "worker-src 'self' blob:",
].join('; ');

const MIME_BY_EXT: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export type ServedAppResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export function appOrigin(): string {
  return `${APP_SCHEME}://${APP_HOST}`;
}

export function appIndexUrl(search = ''): string {
  return `${appOrigin()}/index.html${search}`;
}

export function mimeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function resolveAppFile(root: string, requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${APP_SCHEME}:`) {
    return undefined;
  }
  let relative = decodeURIComponent(url.pathname);
  if (relative === '' || relative === '/') {
    relative = '/index.html';
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, `.${relative}`);
  const rel = path.relative(resolvedRoot, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return candidate;
}

export async function serveAppUrl(root: string, requestUrl: string): Promise<ServedAppResponse> {
  const filePath = resolveAppFile(root, requestUrl);
  if (!filePath) {
    return appResponse(404, Buffer.from('Not found', 'utf8'), 'text/plain; charset=utf-8');
  }
  try {
    const info = await stat(filePath);
    const target = info.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const body = await readFile(target);
    return appResponse(200, body, mimeFor(target));
  } catch {
    return appResponse(404, Buffer.from('Not found', 'utf8'), 'text/plain; charset=utf-8');
  }
}

export function appResponse(status: number, body: Buffer, contentType: string): ServedAppResponse {
  return {
    status,
    body,
    headers: {
      'Content-Type': contentType,
      'Content-Security-Policy': APP_CSP,
      'X-Content-Type-Options': 'nosniff',
    },
  };
}
