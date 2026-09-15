/**
 * Corre un comando con un Postgres detrás.
 *
 * Dos caminos, y el mismo aprovisionamiento en los dos:
 *
 *  - **Base ya disponible** (`DATABASE_URL` en el entorno): se usa tal cual. Es lo que hace
 *    CI con su servicio de Postgres, y lo que permite correr los tests contra un clúster
 *    local sin Docker.
 *  - **Sin base**: se levanta la de `compose.test.yml`, se aprovisiona y se tira al acabar.
 *
 * En ambos se aplican las migraciones antes de ejecutar nada: un test contra un esquema
 * viejo falla por el motivo equivocado.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const COMPOSE = ['compose', '-f', 'compose.test.yml', '-p', 'providencia-test'];
const HOST = '127.0.0.1:55432';
const BASE = 'providencia_test';

const urls = (clave) => `postgres://${clave}:test@${HOST}/${BASE}`;

function correr(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const hijo = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    hijo.on('exit', (codigo) =>
      codigo === 0 ? resolve() : reject(new Error(`${cmd} salió con ${codigo}`)),
    );
    hijo.on('error', reject);
  });
}

async function esperarSano() {
  for (let intento = 0; intento < 60; intento++) {
    const salida = await new Promise((resolve) => {
      const hijo = spawn('docker', [...COMPOSE, 'ps', '--format', '{{.Health}}'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let texto = '';
      hijo.stdout.on('data', (d) => (texto += d));
      hijo.on('exit', () => resolve(texto.trim()));
    });
    if (salida.includes('healthy')) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Postgres de test no llegó a estado healthy');
}

const propia = process.env.DATABASE_URL === undefined;

const entorno = propia
  ? {
      DATABASE_URL: urls('app_user'),
      DATABASE_URL_OWNER: urls('app_owner'),
      DATABASE_URL_DUMP: urls('app_dump'),
    }
  : {
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_OWNER: process.env.DATABASE_URL_OWNER,
      DATABASE_URL_DUMP: process.env.DATABASE_URL_DUMP,
    };

for (const [clave, valor] of Object.entries(entorno)) {
  if (valor === undefined) {
    process.stderr.write(`Falta ${clave}: defínelo o deja DATABASE_URL sin definir para usar compose.\n`);
    process.exit(1);
  }
}

let codigoSalida = 0;
try {
  if (propia) {
    await correr('docker', [...COMPOSE, 'up', '-d', '--wait=false']);
    await esperarSano();
    await correr('node', ['scripts/aprovisionar.ts'], {
      DATABASE_URL_SUPERUSER: `postgres://postgres:test@${HOST}/${BASE}`,
      APP_OWNER_PASSWORD: 'test',
      APP_USER_PASSWORD: 'test',
      APP_DUMP_PASSWORD: 'test',
    });
  }

  await correr('node', ['scripts/migrar.ts'], entorno);
  await correr('npx', process.argv.slice(2), entorno);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  codigoSalida = 1;
} finally {
  if (propia) await correr('docker', [...COMPOSE, 'down', '-v']).catch(() => {});
}
process.exit(codigoSalida);
