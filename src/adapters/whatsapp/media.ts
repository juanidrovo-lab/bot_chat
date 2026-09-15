/**
 * Los `media_id` de WhatsApp caducan a los 30 días. Los audios del bot son fijos y se
 * suben una vez, así que sin un refresco periódico el bot deja de tener voz un mes después
 * del despliegue, en silencio y sin que nadie lo note hasta que un cliente llama.
 */
import { openAsBlob } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { GestorMedia, MediaDe } from '../../app/puertos/Media.ts';
import { DIAS_REFRESCO } from '../../app/refrescarMedia.ts';
import type { BaseDatos } from '../postgres/db.ts';
import { enTenant } from '../postgres/tenantContext.ts';
import { aInstante } from '../postgres/tipos.ts';

const MS_POR_DIA = 86_400_000;

/**
 * Pura, para poder probar el borde sin red ni base de datos.
 *
 * El job diario ya filtra por fecha en SQL; esto es la segunda línea, la que protege al
 * camino de envío: si un audio se pidió hace un minuto no se vuelve a subir.
 */
export function necesitaRefresco(
  waMediaId: string | null,
  subidoAt: Date | null,
  ahora: Date,
): boolean {
  if (waMediaId === null || subidoAt === null) return true;
  return ahora.getTime() - subidoAt.getTime() >= DIAS_REFRESCO * MS_POR_DIA;
}

export interface OpcionesMedia {
  db: BaseDatos;
  phoneNumberId: string;
  token: string;
  urlBase?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  ahora?: () => Date;
}

export class MediaDesconocidoError extends Error {
  constructor(motivo: string) {
    super(motivo);
    // El `name` no es cosmético: el mensaje se redacta antes de llegar al log —puede traer
    // los parámetros de una consulta— y esto es lo único que sobrevive para saber qué pasó.
    this.name = 'MediaDesconocidoError';
  }
}

export function crearGestorMedia(opciones: OpcionesMedia): GestorMedia {
  const {
    db,
    phoneNumberId,
    token,
    urlBase = 'https://graph.facebook.com',
    version = 'v23.0',
    fetchImpl = fetch,
    ahora = () => new Date(),
  } = opciones;

  async function subir(ruta: string): Promise<string> {
    const formulario = new FormData();
    formulario.set('messaging_product', 'whatsapp');
    formulario.set('type', 'audio/ogg');
    formulario.set('file', await openAsBlob(ruta, { type: 'audio/ogg' }), ruta.split('/').pop());

    const respuesta = await fetchImpl(`${urlBase}/${version}/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: formulario,
    });
    if (!respuesta.ok) {
      throw new Error(`No se pudo subir el audio: WhatsApp respondió ${respuesta.status}`);
    }
    const datos = (await respuesta.json()) as { id?: string };
    if (datos.id === undefined) throw new Error('La subida no devolvió un media_id');
    return datos.id;
  }

  return {
    async asegurarMediaFresco(tenantId, clave) {
      // Lectura en su propia transacción: la subida es una llamada de red y no puede
      // ocurrir con una transacción abierta reteniendo una conexión del pool.
      const { rows } = await enTenant(db, tenantId, (tx) =>
        // `subido_at` llega como string: en SQL crudo Drizzle apaga los analizadores de
        // node-postgres. Tipado como `Date` compilaría y reventaría en `.getTime()`.
        tx.execute<{ ruta: string; wa_media_id: string | null; subido_at: string | null }>(sql`
          SELECT ruta, wa_media_id, subido_at FROM audios
           WHERE tenant_id = ${tenantId}::uuid AND clave = ${clave}
        `),
      );
      const fila = rows[0];
      if (fila === undefined) throw new MediaDesconocidoError(`No hay audio con clave «${clave}»`);

      const subidoAt = fila.subido_at === null ? null : aInstante(fila.subido_at);
      const vigente = fila.wa_media_id;
      if (vigente !== null && !necesitaRefresco(vigente, subidoAt, ahora())) return vigente;

      const mediaId = await subir(fila.ruta);

      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE audios SET wa_media_id = ${mediaId}, subido_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND clave = ${clave}
        `),
      );
      return mediaId;
    },
  };
}

/**
 * Fábrica por despacho. Devuelve `null` si el despacho no tiene credenciales: un estudio a
 * medio configurar no puede hacer fallar el job diario de los demás.
 */
export function crearMediaDe(opciones: {
  db: BaseDatos;
  credencialesDe: (tenantId: string) => Promise<{ phoneNumberId: string; token: string } | null>;
}): MediaDe {
  return async (tenantId) => {
    const credenciales = await opciones.credencialesDe(tenantId);
    if (credenciales === null) return null;
    return crearGestorMedia({ db: opciones.db, ...credenciales });
  };
}
