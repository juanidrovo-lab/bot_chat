/**
 * Da de alta —o actualiza— un despacho completo, en una sola transacción.
 *
 *   WA_TOKEN=... WA_APP_SECRET=... node --env-file-if-exists=.env scripts/despacho.ts <fichero.json>
 *
 * Antes esto eran cinco pasos de SQL a mano con cifrado manual, y es justo donde un error
 * deja credenciales mal cifradas sin que nadie se entere hasta el primer mensaje.
 *
 * **Los secretos no van en el fichero.** El token y el app secret se leen del entorno, como
 * el resto de secretos del proyecto; así el JSON de configuración se puede revisar, versionar
 * y mandar por correo sin repartir las llaves del despacho.
 *
 * **Se comprueba leyendo, no validando.** Después de escribir, el script vuelve a leer la
 * configuración **con los mismos adaptadores que usa el bot**: el catálogo de materias y el
 * horario semanal. Un tarifario mal formado no revienta al guardarlo —`jsonb` acepta
 * cualquier cosa—, deja al despacho sin materias y el fallo aparece a mitad de la primera
 * conversación. Comprobarlo con una copia del esquema no serviría: lo que importa es lo que
 * el bot ve.
 *
 * Es idempotente: volver a correrlo con el mismo slug actualiza.
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';
import { crearBaseDatos } from '../src/adapters/postgres/db.ts';
import { crearCatalogos } from '../src/adapters/postgres/catalogos.ts';
import { crearRepoCitas } from '../src/adapters/postgres/reservas.ts';
import { crearReloj } from '../src/adapters/reloj.ts';
import { POLITICA } from '../src/domain/agenda/politicas.ts';
import { cifrar } from '../src/platform/crypto.ts';

const Tramo = z.object({ desde: z.string(), hasta: z.string() });

const Configuracion = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'solo minúsculas, números y guiones: va en la URL del panel'),
  nombre: z.string().min(1),
  waPhoneNumberId: z.string().min(1),
  waWabaId: z.string().min(1),
  tarifario: z.record(
    z.string(),
    z.object({
      titulo: z.string().min(1),
      honorarioUsd: z.string().regex(/^\d+\.\d{2}$/, 'dos decimales, como "40.00"'),
      triaje: z
        .array(
          z.object({
            pregunta: z.string().min(1),
            opciones: z.array(z.object({ id: z.string().min(1), titulo: z.string().min(1) })).min(1),
          }),
        )
        .default([]),
    }),
  ),
  /** Clave: día de la semana, 0 = domingo. */
  horarios: z.record(z.string().regex(/^[0-6]$/), z.array(Tramo)),
  abogados: z
    .array(z.object({ nombre: z.string().min(1), materias: z.array(z.string().min(1)).min(1) }))
    .min(1),
  usuarios: z
    .array(
      z.object({
        email: z.email(),
        nombre: z.string().min(1),
        rol: z.enum(['abogado', 'secretaria']).default('abogado'),
        /** Nombre del abogado con el que se corresponde, si lo es. */
        abogado: z.string().optional(),
      }),
    )
    .default([]),
});

type Configuracion = z.infer<typeof Configuracion>;

function secreto(clave: string): string {
  const valor = process.env[clave];
  if (valor === undefined || valor === '') throw new Error(`Falta ${clave} en el entorno`);
  return valor;
}

async function escribir(cliente: pg.Client, config: Configuracion, claveHex: string): Promise<string> {
  await cliente.query('BEGIN');
  try {
    const { rows } = await cliente.query<{ id: string }>(
      `INSERT INTO tenants (slug, nombre, wa_phone_number_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE
          SET nombre = EXCLUDED.nombre,
              wa_phone_number_id = EXCLUDED.wa_phone_number_id,
              updated_at = now()
       RETURNING id`,
      [config.slug, config.nombre, config.waPhoneNumberId],
    );
    const tenantId = rows[0]!.id;

    /**
     * Con FORCE ROW LEVEL SECURITY el dueño de las tablas también queda sujeto a la
     * política: sin fijar el tenant, todo lo que viene después no tocaría ninguna fila y no
     * avisaría de nada.
     */
    await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    await cliente.query(
      `INSERT INTO tenant_config
         (tenant_id, wa_waba_id, wa_token_enc, wa_app_secret_enc, tarifario, horarios)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE
          SET wa_waba_id = EXCLUDED.wa_waba_id,
              wa_token_enc = EXCLUDED.wa_token_enc,
              wa_app_secret_enc = EXCLUDED.wa_app_secret_enc,
              tarifario = EXCLUDED.tarifario,
              horarios = EXCLUDED.horarios,
              updated_at = now()`,
      [
        tenantId,
        config.waWabaId,
        cifrar(secreto('WA_TOKEN'), claveHex),
        cifrar(secreto('WA_APP_SECRET'), claveHex),
        JSON.stringify(config.tarifario),
        JSON.stringify(config.horarios),
      ],
    );

    const idPorNombre = new Map<string, string>();
    for (const abogado of config.abogados) {
      /**
       * Los abogados no tienen clave natural, así que se casan por nombre. Es lo que
       * permite volver a correr el script sin duplicarlos; cambiar el nombre de uno crea
       * otro, y eso es correcto: son personas distintas mientras no se diga lo contrario.
       */
      const { rows: existentes } = await cliente.query<{ id: string }>(
        'SELECT id FROM abogados WHERE tenant_id = $1 AND nombre = $2',
        [tenantId, abogado.nombre],
      );

      const id = existentes[0]?.id;
      if (id === undefined) {
        const { rows: creado } = await cliente.query<{ id: string }>(
          `INSERT INTO abogados (tenant_id, nombre, materias) VALUES ($1, $2, $3) RETURNING id`,
          [tenantId, abogado.nombre, abogado.materias],
        );
        idPorNombre.set(abogado.nombre, creado[0]!.id);
      } else {
        await cliente.query(
          'UPDATE abogados SET materias = $3, activo = true, updated_at = now() WHERE tenant_id = $1 AND id = $2',
          [tenantId, id, abogado.materias],
        );
        idPorNombre.set(abogado.nombre, id);
      }
    }

    for (const usuario of config.usuarios) {
      const abogadoId = usuario.abogado === undefined ? null : idPorNombre.get(usuario.abogado);
      if (usuario.abogado !== undefined && abogadoId === undefined) {
        throw new Error(`El usuario ${usuario.email} apunta a un abogado que no existe: «${usuario.abogado}»`);
      }

      await cliente.query(
        `INSERT INTO usuarios (tenant_id, email, nombre, rol, abogado_id)
         VALUES ($1, $2, $3, $4::rol_panel, $5)
         ON CONFLICT (tenant_id, email) DO UPDATE
            SET nombre = EXCLUDED.nombre, rol = EXCLUDED.rol,
                abogado_id = EXCLUDED.abogado_id, activo = true, updated_at = now()`,
        [tenantId, usuario.email, usuario.nombre, usuario.rol, abogadoId ?? null],
      );
    }

    await cliente.query('COMMIT');
    return tenantId;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  }
}

/**
 * Relee lo que se acaba de guardar con los mismos adaptadores que usa el bot.
 *
 * Es la única comprobación que vale: `jsonb` acepta cualquier cosa, y un tarifario mal
 * formado no falla al guardarse — deja al despacho sin materias y aparece a mitad de la
 * primera conversación.
 */
async function comprobar(url: string, tenantId: string, config: Configuracion): Promise<void> {
  const db = crearBaseDatos(url);
  try {
    const reloj = crearReloj();
    const repoCitas = crearRepoCitas(db);
    const catalogos = crearCatalogos({ db, repo: repoCitas, reloj, politica: POLITICA });

    /**
     * `contactoId` con el uuid nulo: el catálogo de materias no lo mira —solo el de horas,
     * para el cupo mensual— y aquí no hay ningún contacto al que preguntarle por su agenda.
     */
    const materias = await catalogos.opciones('materias', {
      tenantId,
      contactoId: '00000000-0000-0000-0000-000000000000',
      contexto: {},
    });
    const esperadas = Object.keys(config.tarifario).length;
    if (materias.length !== esperadas) {
      throw new Error(
        `El bot solo ve ${materias.length} de las ${esperadas} materias del tarifario. ` +
          'Revise que cada una tenga `titulo` y `honorarioUsd` con dos decimales.',
      );
    }

    const horario = await repoCitas.horarioSemanal(tenantId);
    const diasConHueco = Object.values(horario).filter((tramos) => tramos.length > 0).length;
    if (diasConHueco === 0) {
      throw new Error(
        'El bot no ve ningún horario. Las horas van como "09:00" y el día es 0=domingo … 6=sábado.',
      );
    }

    process.stdout.write(`materias visibles: ${materias.map((m) => m.id).join(', ')}\n`);
    process.stdout.write(`días con horario: ${diasConHueco}\n`);
  } finally {
    await db.cerrar();
  }
}

async function main(): Promise<void> {
  const [fichero] = process.argv.slice(2);
  if (fichero === undefined) throw new Error('Uso: node scripts/despacho.ts <fichero.json>');

  const url = process.env.DATABASE_URL_OWNER;
  if (url === undefined) throw new Error('Falta DATABASE_URL_OWNER (rol app_owner)');
  const claveHex = secreto('CLAVE_CIFRADO_HEX');

  const config = Configuracion.parse(JSON.parse(await readFile(fichero, 'utf8')));

  // Las materias de cada abogado tienen que existir en el tarifario: si no, ese abogado no
  // aparece nunca como disponible y la agenda se queda corta sin decir por qué.
  const materias = new Set(Object.keys(config.tarifario));
  for (const abogado of config.abogados) {
    const desconocidas = abogado.materias.filter((m) => !materias.has(m));
    if (desconocidas.length > 0) {
      throw new Error(
        `${abogado.nombre} atiende materias que no están en el tarifario: ${desconocidas.join(', ')}`,
      );
    }
  }

  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  let tenantId: string;
  try {
    tenantId = await escribir(cliente, config, claveHex);
  } finally {
    await cliente.end();
  }

  process.stdout.write(`despacho «${config.slug}» listo (${tenantId})\n`);

  const urlApp = process.env.DATABASE_URL;
  if (urlApp === undefined) {
    process.stdout.write('sin DATABASE_URL: no se comprobó qué ve el bot\n');
    return;
  }
  await comprobar(urlApp, tenantId, config);

  process.stdout.write('\nSiguiente: registrar los audios y acuñar las invitaciones del panel.\n');
}

await main();
