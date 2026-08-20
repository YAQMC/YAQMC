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
      'target',
      'output/**',
      'release-electron/**',
      '.superpowers/**',
      '.playwright-cli/**',
      'playwright-report/**',
      'test-results/**',
      'blob-report/**',
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
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps', '@tauri-apps/*', '@tauri-apps/**'],
              message: 'Legacy host packages are forbidden; use HostBridge via YaqmcClient.',
            },
          ],
        },
      ],
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
  {
    files: ['scripts/migration/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        document: 'readonly',
        getComputedStyle: 'readonly',
        location: 'readonly',
      },
    },
  },
  {
    files: [
      'src/components/AddToPlaylistPicker.tsx',
      'src/components/SettingsUpdateSection.tsx',
      'src/components/SurfaceCapabilityBanner.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
);
