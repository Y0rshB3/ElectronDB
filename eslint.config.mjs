import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'release/**', 'tests/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    languageOptions: { globals: { ...globals.browser }, parserOptions: { parser: tseslint.parser } }
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/shared/**/*.ts',
      'tests/**/*.ts',
      '*.ts',
      '*.mjs'
    ],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off'
    }
  },
  prettier
)
