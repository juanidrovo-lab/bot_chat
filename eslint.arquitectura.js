/**
 * La regla de dependencias entre anillos, como build que falla.
 *
 * Vive en su propio archivo para que `npm run lint:arch` sea una comprobación que se
 * puede leer de un vistazo y que corre en CI por separado: si un cambio necesita saltarse
 * esto, el diseño está mal y hay que hablarlo, no añadir un `eslint-disable`.
 *
 *   domain    → solo domain. Ni app, ni adapters, ni platform, ni ningún paquete externo.
 *   app       → domain y app. Depende de puertos, nunca de adaptadores.
 *   adapters  → todo. Es el anillo de fuera.
 *   platform  → solo platform. Es una hoja: nadie de dominio la importa.
 */
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'drizzle/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['src/**/*.ts'],
      'boundaries/elements': [
        { type: 'domain', pattern: 'src/domain/**/*' },
        { type: 'app', pattern: 'src/app/**/*' },
        { type: 'adapters', pattern: 'src/adapters/**/*' },
        { type: 'platform', pattern: 'src/platform/**/*' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          message: '${file.type} no puede importar de ${dependency.type}: las flechas apuntan hacia adentro.',
          rules: [
            { from: 'domain', allow: ['domain'] },
            { from: 'app', allow: ['app', 'domain'] },
            { from: 'adapters', allow: ['adapters', 'app', 'domain', 'platform'] },
            { from: 'platform', allow: ['platform'] },
          ],
        },
      ],
      'boundaries/external': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              from: ['domain'],
              disallow: ['*'],
              message: 'domain es puro: nada de node_modules, y ningún paquete que toque red, disco o base de datos.',
            },
          ],
        },
      ],
    },
  },
];
