import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Flat config. `eslint-config-prettier` comes last so it switches off the stylistic
// rules Prettier already owns — ESLint judges the code, Prettier judges the layout.
export default tseslint.config(
  { ignores: ['dist/'] },
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
