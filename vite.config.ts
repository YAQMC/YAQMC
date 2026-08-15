import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { configDefaults, defineConfig } from 'vitest/config';

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

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __YAQMC_BUILD_COMMIT__: JSON.stringify(currentCommit()),
    __YAQMC_RELEASE_CHANNEL__: JSON.stringify(process.env.YAQMC_RELEASE_CHANNEL ?? 'development'),
    __YAQMC_BUILD_TYPE__: JSON.stringify(command === 'serve' ? 'development' : 'release'),
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    exclude: [...configDefaults.exclude, 'output/**', '.superpowers/**', 'scripts/**'],
  },
}));
