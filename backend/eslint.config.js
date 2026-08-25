// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Идемпотентность ломается между проверкой и записью. Плавающий промис —
      // ровно тот способ, которым `await` теряется незаметно.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'log'] }],
    },
  },
  {
    // `describe` и `it` из node:test возвращают промисы, которыми управляет
    // сам прогонщик. Правило про плавающие промисы держим там, где оно и нужно,
    // — в `src/`: именно потерянный `await` ломает идемпотентность.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
