import { sql } from 'drizzle-orm';
import type { RepoBloqueos } from '../../app/puertos/RepoBloqueos.ts';
import type { CredencialesCalendario } from '../google/calendario.ts';
import { descifrar } from '../../platform/crypto.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';

export function crearRepoBloqueos(db: BaseDatos): RepoBloqueos {
  return {
    async conCalendario(tenantId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ id: string; gcal_calendar_id: string }>(sql`
          SELECT id, gcal_calendar_id FROM abogados
           WHERE tenant_id = ${tenantId}::uuid AND activo
             AND gcal_calendar_id IS NOT NULL AND gcal_refresh_token_enc IS NOT NULL
           ORDER BY id
        `),
      );
      return rows.map((r) => ({ id: r.id, calendarId: r.gcal_calendar_id }));
    },

    async reemplazarDeGoogle(tenantId, abogadoId, desdeMs, hastaMs, ocupados) {
      return enTenant(db, tenantId, async (tx) => {
        /**
         * Sustituir, no acumular. `freeBusy` devuelve franjas sin identificador propio, así
         * que la única sincronización correcta es reemplazar la ventana entera: lo que
         * Google ya no reporta como ocupado tiene que dejar de bloquear la agenda.
         *
         * Solo toca `origen = 'gcal'`: un bloqueo que el estudio puso a mano no lo pisa una
         * sincronización automática.
         */
        await tx.execute(sql`
          DELETE FROM bloqueos
           WHERE tenant_id = ${tenantId}::uuid AND abogado_id = ${abogadoId}::uuid
             AND origen = 'gcal'
             AND inicia_at < ${new Date(hastaMs)} AND termina_at > ${new Date(desdeMs)}
        `);

        let insertados = 0;
        for (const franja of ocupados) {
          // Identificador determinista: dos franjas idénticas en la misma respuesta no
          // producen dos filas.
          const externo = `${franja.inicioMs}-${franja.finMs}`;
          const { rowCount } = await tx.execute(sql`
            INSERT INTO bloqueos (tenant_id, abogado_id, inicia_at, termina_at, origen, external_id)
            VALUES (${tenantId}::uuid, ${abogadoId}::uuid,
                    ${new Date(franja.inicioMs)}, ${new Date(franja.finMs)}, 'gcal', ${externo})
            ON CONFLICT (tenant_id, abogado_id, origen, external_id) WHERE external_id IS NOT NULL
            DO NOTHING
          `);
          insertados += rowCount ?? 0;
        }
        return insertados;
      });
    },
  };
}

/** Lee y descifra las credenciales de Google de un abogado. */
export function crearCredencialesDe(db: BaseDatos, claveHex: string) {
  return async (tenantId: string, abogadoId: string): Promise<CredencialesCalendario | null> => {
    const { rows } = await enTenant(db, tenantId, (tx) =>
      tx.execute<{ gcal_calendar_id: string | null; gcal_refresh_token_enc: string | null }>(sql`
        SELECT gcal_calendar_id, gcal_refresh_token_enc FROM abogados
         WHERE tenant_id = ${tenantId}::uuid AND id = ${abogadoId}::uuid
      `),
    );
    const fila = rows[0];
    const calendarId = fila?.gcal_calendar_id;
    const tokenCifrado = fila?.gcal_refresh_token_enc;
    // Un abogado a medio configurar no tiene calendario: no es un error, es que todavía no
    // completó el OAuth.
    if (calendarId === null || calendarId === undefined) return null;
    if (tokenCifrado === null || tokenCifrado === undefined) return null;

    return { calendarId, refreshToken: descifrar(tokenCifrado, claveHex) };
  };
}
