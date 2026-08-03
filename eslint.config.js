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
  {
    ignores: ['out/', 'dist/', 'node_modules/']
  }
]
