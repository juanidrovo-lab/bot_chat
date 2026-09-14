/**
 * Los `media_id` de WhatsApp caducan a los 30 días. Los audios del bot son fijos y se
 * suben una vez, así que sin un refresco periódico el bot deja de tener voz un mes después
 * del despliegue, en silencio y sin que nadie lo note hasta que un cliente llama.
 */
import { openAsBlob } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { BaseDatos } from '../postgres/db.ts';
import { enTenant } from '../postgres/tenantContext.ts';

/** Se refresca a los 25 y no a los 30: el margen cubre que el job diario falle unos días. */
export const DIAS_REFRESCO = 25;
const MS_POR_DIA = 86_400_000;

/** Pura, para poder probar el borde sin red ni base de datos. */
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

export class MediaDesconocidoError extends Error {}

export interface GestorMedia {
  /** Devuelve un `media_id` vigente para esa clave de audio, resubiendo si hace falta. */
  asegurarMediaFresco(tenantId: string, clave: string): Promise<string>;
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
        tx.execute<{ ruta: string; wa_media_id: string | null; subido_at: Date | null }>(sql`
          SELECT ruta, wa_media_id, subido_at FROM audios
           WHERE tenant_id = ${tenantId}::uuid AND clave = ${clave}
        `),
      );
      const fila = rows[0];
      if (fila === undefined) throw new MediaDesconocidoError(`No hay audio con clave «${clave}»`);

      if (!necesitaRefresco(fila.wa_media_id, fila.subido_at, ahora())) return fila.wa_media_id!;

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
