import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      'src-tauri/target',
      'src-tauri/target-bench-*/**',
      'target',
      'src-tauri/gen',
      'output/**',
      '.superpowers/**',
      '.playwright-cli/**',
      'examples/plugins/**',
      'sdk/plugin/**',
      'tests/fixtures/**',
      'packages/*/dist',
      'apps/*/dist',
      'apps/*/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  reactRefresh.configs.vite,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/application/tauri-host-bridge.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/plugin-opener',
              message:
                'Use HostBridge.shell.openExternal via YaqmcClient instead of @tauri-apps/plugin-opener.',
            },
          ],
          patterns: [
            {
              group: ['@tauri-apps', '@tauri-apps/*', '@tauri-apps/**'],
              message:
                'Import @tauri-apps only from src/application/tauri-host-bridge.ts until P13.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/tauri-host-bridge.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['apps/desktop/**/*.ts'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['apps/desktop/harness/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        location: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs}', 'apps/desktop/scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
