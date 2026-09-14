/**
 * Levanta el Postgres de `compose.test.yml`, aplica las migraciones y corre el comando
 * que reciba. Al terminar, tira el contenedor pase lo que pase.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const COMPOSE = ['compose', '-f', 'compose.test.yml', '-p', 'providencia-test'];
const URL_OWNER = 'postgres://app_owner:test@127.0.0.1:55432/providencia_test';
const URL_APP = 'postgres://app_user:test@127.0.0.1:55432/providencia_test';
const URL_DUMP = 'postgres://app_dump:test@127.0.0.1:55432/providencia_test';

function correr(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const hijo = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    hijo.on('exit', (codigo) => (codigo === 0 ? resolve() : reject(new Error(`${cmd} salió con ${codigo}`))));
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

let codigoSalida = 0;
try {
  await correr('docker', [...COMPOSE, 'up', '-d', '--wait=false']);
  await esperarSano();
  await correr('node', ['--experimental-strip-types', 'scripts/migrar.ts'], {
    DATABASE_URL_OWNER: URL_OWNER,
  });
  await correr('npx', process.argv.slice(2), {
    DATABASE_URL: URL_APP,
    DATABASE_URL_OWNER: URL_OWNER,
    DATABASE_URL_DUMP: URL_DUMP,
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  codigoSalida = 1;
} finally {
  await correr('docker', [...COMPOSE, 'down', '-v']).catch(() => {});
}
process.exit(codigoSalida);
