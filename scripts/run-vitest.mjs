import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_WEB_STORAGE_DISABLE_FLAG = '--no-experimental-webstorage';

export function mergeNodeOptions(options = '') {
  const normalized = options.trim();
  if (new RegExp(`(?:^|\\s)${NODE_WEB_STORAGE_DISABLE_FLAG}(?:\\s|$)`).test(normalized)) {
    return normalized;
  }
  return normalized
    ? `${normalized} ${NODE_WEB_STORAGE_DISABLE_FLAG}`
    : NODE_WEB_STORAGE_DISABLE_FLAG;
}

export function runVitest(args, { env = process.env } = {}) {
  const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const child = spawn(process.execPath, [vitestCli, ...args], {
    env: { ...env, NODE_OPTIONS: mergeNodeOptions(env.NODE_OPTIONS) },
    stdio: 'inherit',
    shell: false,
  });

  return new Promise((resolveExit) => {
    child.once('error', (error) => {
      process.stderr.write(`${error}\n`);
      resolveExit(1);
    });
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

const invokedPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const exitCode = await runVitest(process.argv.slice(2));
  process.exitCode = exitCode;
}
