import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The classic fetch-on-mount pattern (setLoading(true) at the top of an
      // effect / a load() callback invoked from useEffect) is used throughout
      // the data hooks. react-hooks v6 flags every such synchronous setState;
      // keep it visible as a warning instead of failing the build.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
