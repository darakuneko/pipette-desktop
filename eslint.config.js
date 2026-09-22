import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    // Native `title` attributes on DOM elements render the OS tooltip, not
    // the app's styled bubble (src/renderer/components/ui/Tooltip.tsx) —
    // forbidden by standing project rule. `title` PROPS on custom
    // components (JSXIdentifier starting uppercase, e.g. `<PanelSection
    // title=...>`) are unaffected since they're section headings / modal
    // titles, not tooltips.
    files: ['src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.type="JSXIdentifier"][name.name=/^[a-z]/] > JSXAttribute[name.name="title"]',
          message: 'Native `title` attributes render the OS tooltip, not the app-styled bubble. Wrap the element with <Tooltip> from src/renderer/components/ui/Tooltip.tsx instead.'
        }
      ]
    }
  },
  // File-length caps, counted the same way `wc -l` counts (blank lines and
  // comments included): UI components (`src/**/*.tsx`) top out at
  // 500 lines, custom hooks (a `.ts` file — not `.tsx`, those are components
  // above — whose basename starts with `use` followed by an uppercase
  // letter or a hyphen, e.g. `useThing.ts` / `use-thing.ts`) top out at 600,
  // and every other `.ts` file (services/utils) tops out at 800. The hook
  // entry is listed after the general `.ts` entry so its more specific
  // `files` glob wins for hook basenames. Test files (`__tests__/`,
  // `*.test.ts(x)`), `.d.ts` files, and a short list of pure
  // data/declaration-listing files is exempt from all three caps.
  {
    files: ['src/**/*.tsx'],
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }]
    }
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 800, skipBlankLines: false, skipComments: false }]
    }
  },
  {
    files: ['src/**/use[A-Z]*.ts', 'src/**/use-*.ts'],
    rules: {
      'max-lines': ['error', { max: 600, skipBlankLines: false, skipComments: false }]
    }
  },
  {
    files: [
      'src/**/__tests__/**',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.d.ts',
      'src/renderer/data/keyboard-layouts.ts',
      'src/shared/keycodes/keycodes.ts',
      'src/shared/keycodes/keycodes-v5.ts',
      'src/shared/keycodes/keycodes-v6.ts',
      'src/shared/typing-benchmarks.ts',
      'src/renderer/typing-test/romaji-tables.ts',
      'src/preload/index.ts'
    ],
    rules: {
      'max-lines': 'off'
    }
  },
  {
    ignores: ['out/', 'dist/', 'node_modules/']
  }
]
