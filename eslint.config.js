import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import arquitectura from './eslint.arquitectura.js';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'drizzle/**'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended,
  ...arquitectura,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          // §4.3: `SET` a secas sobrevive la transacción y, con pool, se filtra a la
          // petición siguiente. El valor se fija con set_config(..., true).
          selector: "TemplateElement[value.raw=/\\bSET\\s+(LOCAL\\s+)?app\\.tenant_id\\b/i]",
          message: 'Fija el tenant con set_config(\'app.tenant_id\', $1, true) dentro de enTenant(), no con SET.',
        },
      ],
    },
  },
];
