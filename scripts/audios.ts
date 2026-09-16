/**
 * Registra los audios de un despacho en la tabla `audios`.
 *
 *   node --env-file-if-exists=.env scripts/audios.ts <slug> [directorio]
 *
 * Sin esto el bot no tiene voz: el job diario refresca los `media_id` de lo que haya en la
 * tabla, y si la tabla está vacía no refresca nada. La subida a WhatsApp **no** ocurre aquí
 * —eso lo hace el job, o el primer turno que necesite el audio—; esto solo deja escrito qué
 * fichero corresponde a cada clave.
 *
 * Es administrativo y corre como `app_owner`, como el resto del alta de un despacho.
 *
 * Cada fichero se comprueba antes de registrarlo: un `.m4a` renombrado o un Ogg con Vorbis
 * llegan a WhatsApp como archivo adjunto en vez de nota de voz, sin dar error en ninguna
 * parte, y eso se descubre cuando un cliente lo comenta.
 */
import { readdir, open } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import pg from 'pg';
import { CLAVES_DE_AUDIO } from '../src/app/content.ts';
import { VENTANA, esOggOpus } from '../src/platform/ogg.ts';

interface Audio {
  clave: string;
  ruta: string;
}

async function leerCabecera(ruta: string): Promise<Uint8Array> {
  const fichero = await open(ruta, 'r');
  try {
    const buffer = Buffer.alloc(VENTANA);
    const { bytesRead } = await fichero.read(buffer, 0, VENTANA, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await fichero.close();
  }
}

async function recoger(directorio: string): Promise<Audio[]> {
  const ficheros = (await readdir(directorio)).filter((f) => extname(f) === '.ogg').sort();
  if (ficheros.length === 0) throw new Error(`No hay ningún .ogg en ${directorio}`);

  const audios: Audio[] = [];
  const problemas: string[] = [];

  for (const fichero of ficheros) {
    const clave = basename(fichero, '.ogg');
    const ruta = resolve(join(directorio, fichero));

    /**
     * La clave tiene que ser una de las que el guion pide. Un `bienvenidas.ogg` se
     * registraría igual de bien y no lo mandaría nadie nunca: el fallo sería un audio que
     * simplemente no suena, sin ningún error que lo delate.
     */
    if (!CLAVES_DE_AUDIO.includes(clave)) {
      problemas.push(`${fichero}: «${clave}» no es una clave de audio del guion`);
      continue;
    }

    const veredicto = esOggOpus(await leerCabecera(ruta));
    if (!veredicto.ok) {
      problemas.push(`${fichero}: ${veredicto.motivo}`);
      continue;
    }

    audios.push({ clave, ruta });
  }

  if (problemas.length > 0) {
    // Se aborta entero: registrar la mitad deja al despacho con unos audios que suenan y
    // otros que no, que es más difícil de diagnosticar que ninguno.
    throw new Error(
      `No se registró nada. Corrija esto y vuelva a intentarlo:\n  ${problemas.join('\n  ')}\n\n` +
        `Claves válidas: ${CLAVES_DE_AUDIO.join(', ')}\n` +
        'Conversión: ffmpeg -i entrada.m4a -c:a libopus -b:a 32k salida.ogg',
    );
  }

  return audios;
}

async function main(): Promise<void> {
  const [slug, directorio = 'audios'] = process.argv.slice(2);
  if (slug === undefined) throw new Error('Uso: node scripts/audios.ts <slug> [directorio]');

  const url = process.env.DATABASE_URL_OWNER;
  if (url === undefined) throw new Error('Falta DATABASE_URL_OWNER (rol app_owner)');

  const audios = await recoger(directorio);

  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    const { rows } = await cliente.query<{ id: string }>(
      'SELECT id FROM tenants WHERE slug = $1 AND activo',
      [slug],
    );
    const tenantId = rows[0]?.id;
    if (tenantId === undefined) throw new Error(`No hay despacho activo con slug «${slug}»`);

    // Con FORCE ROW LEVEL SECURITY el dueño también queda sujeto a la política: sin fijar
    // el tenant estas sentencias no tocarían ninguna fila y no avisarían de nada.
    await cliente.query('BEGIN');
    await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    for (const { clave, ruta } of audios) {
      /**
       * Si la ruta cambia, el `media_id` que había deja de corresponder a este fichero: se
       * borra para que el job lo vuelva a subir. Si no cambia, se respeta el que hay y no
       * se regala una subida.
       */
      await cliente.query(
        `INSERT INTO audios (tenant_id, clave, ruta) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, clave) DO UPDATE
            SET ruta = EXCLUDED.ruta,
                wa_media_id = CASE WHEN audios.ruta = EXCLUDED.ruta THEN audios.wa_media_id END,
                subido_at   = CASE WHEN audios.ruta = EXCLUDED.ruta THEN audios.subido_at END`,
        [tenantId, clave, ruta],
      );
    }
    await cliente.query('COMMIT');

    for (const { clave, ruta } of audios) process.stdout.write(`registrado ${clave} → ${ruta}\n`);

    const faltan = CLAVES_DE_AUDIO.filter((c) => !audios.some((a) => a.clave === c));
    if (faltan.length > 0) {
      // Avisar, no fallar: un despacho puede querer voz solo en la bienvenida.
      process.stdout.write(`\nSin grabar todavía: ${faltan.join(', ')}\n`);
    }
  } finally {
    await cliente.end();
  }
}

await main();
