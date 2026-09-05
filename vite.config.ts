import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

function currentCommit(): string {
  const environmentCommit = process.env.GITHUB_SHA ?? process.env.VITE_GIT_COMMIT;
  if (environmentCommit) return environmentCommit;
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function developmentEntryPlugin(command: string): Plugin {
  return {
    name: 'yaqmc-development-entry',
    transformIndexHtml(html: string) {
      return command === 'serve'
        ? html.replace('/src/main.tsx', '/src/development/main.tsx')
        : html;
    },
  };
}

function releasePublicAssetsPlugin(command: string): Plugin {
  const assets = ['favicon.svg', 'yaqmc-logo.png', 'artwork/preset-preview.svg'];
  return {
    name: 'yaqmc-release-public-assets',
    generateBundle() {
      if (command !== 'build') return;
      for (const fileName of assets) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: readFileSync(path.join(repositoryRoot, 'public', fileName)),
        });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [developmentEntryPlugin(command), releasePublicAssetsPlugin(command), react()],
  publicDir: command === 'serve' ? 'public' : false,
  // Serve from `/` in development; package relative assets for the app:// protocol.
  base: command === 'build' ? './' : '/',
  define: {
    __YAQMC_BUILD_COMMIT__: JSON.stringify(currentCommit()),
    __YAQMC_RELEASE_CHANNEL__: JSON.stringify(process.env.YAQMC_RELEASE_CHANNEL ?? 'development'),
    __YAQMC_BUILD_TYPE__: JSON.stringify(command === 'serve' ? 'development' : 'release'),
    __YAQMC_QA_BUILD__: JSON.stringify(command === 'serve' || process.env.YAQMC_QA_BUILD === '1'),
    __YAQMC_TARGET_PLATFORM__: JSON.stringify(
      process.env.YAQMC_TARGET_PLATFORM === 'android' ? 'android' : 'desktop',
    ),
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      // Native build outputs can be locked while Cargo/Gradle replaces them on Windows.
      ignored: [
        /(?:^|[/\\])(?:target|\.gradle)(?:[/\\]|$)/,
        /[/\\]apps[/\\]android[/\\]android[/\\](?:app[/\\])?build(?:[/\\]|$)/,
      ],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    exclude: [
      ...configDefaults.exclude,
      '.worktrees/**',
      'worktrees/**',
      'output/**',
      '.superpowers/**',
      'scripts/**',
      'packages/**/dist/**',
      'apps/**',
      'e2e/**',
      'playwright.config.ts',
      'playwright.electron.config.ts',
    ],
  },
}));
