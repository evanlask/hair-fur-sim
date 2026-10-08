import { defineConfig } from 'vite-plus';

const ignorePatterns = ['dist/**', 'public/**'];

export default defineConfig({
  root: 'src',
  publicDir: '../public',
  cacheDir: '../node_modules/.vite',
  base: './',

  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
  },

  fmt: {
    ignorePatterns,
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    printWidth: 110,
    tabWidth: 2,
    sortImports: true,
    sortPackageJson: { sortScripts: true },
  },

  lint: {
    ignorePatterns,
    env: {
      browser: true,
      es2024: true,
    },
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
  },

  test: {
    include: ['**/*.test.ts'],
  },

  staged: {
    '*': 'vp check --fix',
  },
});
