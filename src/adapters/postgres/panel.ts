/**
 * Modelo de lectura del panel, en SQL crudo.
 *
 * Crudo y no Drizzle por lo de siempre: aquí hacen falta uniones con el abogado y el
 * contacto, filtros por rango de fechas y —en el deshacer— una condición temporal que tiene
 * que evaluarse con el reloj de la base y no con el del proceso. Por eso mismo toda columna
 * de fecha pasa por `aInstante`: en SQL crudo Drizzle apaga los analizadores y un
 * `timestamptz` llega como string.
 */
import { sql } from 'drizzle-orm';
import type {
  CitaDelDia,
  ContactoEncontrado,
  ConversacionEnBandeja,
  FichaContacto,
  RepoPanel,
} from '../../app/puertos/RepoPanel.ts';
import type { Auditoria } from '../../app/puertos/Auditoria.ts';
import type { BaseDatos } from './db.ts';
import { esViolacionUnica } from './reservas.ts';
import { enTenant } from './tenantContext.ts';
import { aInstante, aInstanteOpcional } from './tipos.ts';

export function crearAuditoria(db: BaseDatos): Auditoria {
  return {
    async registrar(evento) {
      await enTenant(db, evento.tenantId, (tx) =>
        tx.execute(sql`
          INSERT INTO eventos (tenant_id, actor, tipo, entidad, entidad_id, payload)
          VALUES (${evento.tenantId}::uuid, ${evento.actor}, ${evento.tipo},
                  ${evento.entidad ?? null}, ${evento.entidadId ?? null},
                  ${JSON.stringify(evento.payload ?? {})}::jsonb)
        `),
      );
    },
  };
}

export function crearRepoPanel(db: BaseDatos): RepoPanel {
  return {
    async citasEntre(tenantId, desdeMs, hastaMs) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT c.id, c.inicia_at, c.termina_at, c.estado, c.materia, c.modalidad,
                 c.honorario_usd, c.abogado_id, a.nombre AS abogado_nombre,
                 c.contacto_id, ct.nombre AS contacto_nombre, ct.wa_id AS contacto_wa_id
            FROM citas c
            JOIN abogados a  ON a.tenant_id  = c.tenant_id AND a.id  = c.abogado_id
            JOIN contactos ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contacto_id
           WHERE c.tenant_id = ${tenantId}::uuid
             AND c.inicia_at >= ${new Date(desdeMs)} AND c.inicia_at < ${new Date(hastaMs)}
             AND c.estado <> 'cancelada'
           ORDER BY c.inicia_at
        `),
      );

      return rows.map<CitaDelDia>((r) => {
        const iniciaAt = aInstante(r['inicia_at']);
        return {
          id: String(r['id']),
          iniciaAt,
          terminaAt: aInstante(r['termina_at']),
          estado: String(r['estado']),
          materia: String(r['materia']),
          modalidad: String(r['modalidad']),
          honorarioUsd: String(r['honorario_usd']),
          abogadoId: String(r['abogado_id']),
          abogadoNombre: String(r['abogado_nombre']),
          contactoId: String(r['contacto_id']),
          contactoNombre: r['contacto_nombre'] === null ? null : String(r['contacto_nombre']),
          contactoWaId: String(r['contacto_wa_id']),
        };
      });
    },

    async bandeja(tenantId, limite) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT cv.id, cv.estado, cv.derivada_motivo, cv.derivada_at, cv.ultimo_inbound_at,
                 cv.contacto_id, ct.nombre AS contacto_nombre, ct.wa_id AS contacto_wa_id
            FROM conversaciones cv
            JOIN contactos ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contacto_id
           WHERE cv.tenant_id = ${tenantId}::uuid
             AND cv.derivada_at IS NOT NULL AND cv.cerrada_at IS NULL
           ORDER BY cv.derivada_at
           LIMIT ${limite}
        `),
      );

      return rows.map<ConversacionEnBandeja>((r) => ({
        id: String(r['id']),
        contactoId: String(r['contacto_id']),
        contactoNombre: r['contacto_nombre'] === null ? null : String(r['contacto_nombre']),
        contactoWaId: String(r['contacto_wa_id']),
        estado: String(r['estado']),
        motivo: String(r['derivada_motivo']),
        derivadaAt: aInstante(r['derivada_at']),
        ultimoInboundAt: aInstante(r['ultimo_inbound_at']),
      }));
    },

    async buscarContactos(tenantId, texto, limite) {
      /**
       * `ILIKE` con comodines a los dos lados no usa índice, y da igual: son los contactos
       * de **un** despacho, la RLS ya recorta a esa partición lógica, y el límite corta.
       * Un índice trigram aquí sería optimizar una tabla de miles de filas para tres
       * usuarios que teclean.
       *
       * Los comodines de LIKE se escapan: un contacto que se llame «100%» no puede
       * convertir la búsqueda en «todo».
       */
      const patron = `%${texto.replace(/([\\%_])/g, '\\$1')}%`;

      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT c.id, c.nombre, c.wa_id,
                 (SELECT min(t.inicia_at) FROM citas t
                   WHERE t.tenant_id = c.tenant_id AND t.contacto_id = c.id
                     AND t.estado IN ('reservada', 'confirmada')
                     AND t.inicia_at >= now()) AS proxima_cita_at
            FROM contactos c
           WHERE c.tenant_id = ${tenantId}::uuid
             AND (c.nombre ILIKE ${patron} OR c.wa_id ILIKE ${patron})
           ORDER BY c.nombre NULLS LAST, c.wa_id
           LIMIT ${limite}
        `),
      );

      return rows.map<ContactoEncontrado>((r) => ({
        id: String(r['id']),
        nombre: r['nombre'] === null ? null : String(r['nombre']),
        waId: String(r['wa_id']),
        proximaCitaAt: aInstanteOpcional(r['proxima_cita_at']),
      }));
    },

    async ficha(tenantId, contactoId) {
      return enTenant(db, tenantId, async (tx) => {
        const { rows } = await tx.execute<Record<string, unknown>>(sql`
          SELECT id, wa_id, nombre, email, cedula, consent_at, consent_revocado_at, bloqueado
            FROM contactos
           WHERE tenant_id = ${tenantId}::uuid AND id = ${contactoId}::uuid
        `);
        const fila = rows[0];
        if (fila === undefined) return null;

        const citas = await tx.execute<Record<string, unknown>>(sql`
          SELECT id, inicia_at, estado, materia FROM citas
           WHERE tenant_id = ${tenantId}::uuid AND contacto_id = ${contactoId}::uuid
           ORDER BY inicia_at DESC
           LIMIT 10
        `);

        return {
          id: String(fila['id']),
          waId: String(fila['wa_id']),
          nombre: fila['nombre'] === null ? null : String(fila['nombre']),
          email: fila['email'] === null ? null : String(fila['email']),
          cedula: fila['cedula'] === null ? null : String(fila['cedula']),
          consentAt: aInstanteOpcional(fila['consent_at']),
          consentRevocadoAt: aInstanteOpcional(fila['consent_revocado_at']),
          bloqueado: fila['bloqueado'] === true,
          citas: citas.rows.map((r) => ({
            id: String(r['id']),
            iniciaAt: aInstante(r['inicia_at']),
            estado: String(r['estado']),
            materia: String(r['materia']),
          })),
        } satisfies FichaContacto;
      });
    },

    async marcarAsistencia(tenantId, citaId, vino) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ id: string }>(sql`
          UPDATE citas
             SET estado = ${vino ? 'atendida' : 'ausente'}::cita_estado, updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${citaId}::uuid
             AND estado IN ('reservada', 'confirmada')
             -- Solo citas que ya empezaron: marcar ausente a quien viene mañana no
             -- significa nada, y el reloj que manda es el de la base.
             AND inicia_at <= now()
          RETURNING id
        `),
      );
      return rows.length > 0;
    },

    async cambiarBloqueo(tenantId, contactoId, bloqueado) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ bloqueado: boolean }>(sql`
          UPDATE contactos SET bloqueado = ${bloqueado}, updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${contactoId}::uuid
          RETURNING bloqueado
        `),
      );
      return rows[0]?.bloqueado === true;
    },

    async cerrarConversacion(tenantId, conversacionId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ id: string }>(sql`
          UPDATE conversaciones SET cerrada_at = now(), updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${conversacionId}::uuid
             AND cerrada_at IS NULL
          RETURNING id
        `),
      );
      return rows.length > 0;
    },

    async cancelarConGracia(tenantId, citaId, graciaMs) {
      return enTenant(db, tenantId, async (tx) => {
        const { rows } = await tx.execute<{ id: string; gcal_event_id: string | null }>(sql`
          UPDATE citas
             SET estado = 'cancelada', cancelada_at = now(),
                 cancelada_por = 'estudio'::cancelada_por, updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${citaId}::uuid
             AND estado IN ('reservada', 'confirmada')
          RETURNING id, gcal_event_id
        `);
        const fila = rows[0];
        if (fila === undefined) return false;

        /**
         * Los efectos van en la misma transacción, como todos, pero con
         * `proximo_intento_at` en el futuro: el relay no los reclama hasta que venza el
         * plazo de gracia, y el deshacer los borra antes de que eso pase. Es lo mismo que
         * hace el backoff, usado aquí para esperar a una persona en vez de a Google.
         */
        const cuando = sql`now() + make_interval(secs => ${graciaMs / 1000})`;

        await tx.execute(sql`
          INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key, proximo_intento_at)
          VALUES (${tenantId}::uuid, 'wa.cancelada',
                  ${JSON.stringify({ citaId })}::jsonb, ${'wa.cancelada:' + citaId}, ${cuando})
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        `);

        if (fila.gcal_event_id !== null) {
          await tx.execute(sql`
            INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key, proximo_intento_at)
            VALUES (${tenantId}::uuid, 'gcal.borrar',
                    ${JSON.stringify({ citaId, gcalEventId: fila.gcal_event_id })}::jsonb,
                    ${'gcal.borrar:' + citaId}, ${cuando})
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
          `);
        }
        return true;
      });
    },

    async deshacerCancelacion(tenantId, citaId, graciaMs) {
      const claves = [`wa.cancelada:${citaId}`, `gcal.borrar:${citaId}`];

      return enTenant(db, tenantId, async (tx) => {
        /**
         * Primero los efectos. Si alguno ya se reclamó —`intentos > 0`— el aviso salió
         * hacia el teléfono del contacto, y deshacer la cita sin poder deshacer el aviso
         * sería peor que no deshacer nada.
         */
        const { rows: efectos } = await tx.execute<{ intentos: number }>(sql`
          SELECT intentos FROM outbox
           WHERE tenant_id = ${tenantId}::uuid
             AND idempotency_key = ANY(${sql.param(claves)}::text[])
        `);
        if (efectos.some((e) => Number(e.intentos) > 0)) return 'plazo';

        /**
         * El UPDATE va en su propio punto de guardado. La exclusión de horarios la sigue
         * imponiendo `citas_slot_unico` y no una consulta previa —que bajo READ COMMITTED
         * no excluiría nada—, pero una violación aborta la transacción entera: el savepoint
         * la acota a esta sentencia y deja la transacción viva para responder.
         */
        let restaurada = false;
        try {
          await tx.transaction(async (punto) => {
            // La ventana se mide con el reloj de la base: ni el del navegador que pide
            // deshacer ni el del proceso tienen por qué coincidir con él.
            const { rows } = await punto.execute<{ id: string }>(sql`
              UPDATE citas
                 SET estado = (CASE WHEN confirmada_at IS NULL THEN 'reservada' ELSE 'confirmada' END)::cita_estado,
                     cancelada_at = NULL, cancelada_por = NULL, updated_at = now()
               WHERE tenant_id = ${tenantId}::uuid AND id = ${citaId}::uuid
                 AND estado = 'cancelada'
                 AND cancelada_at > now() - make_interval(secs => ${graciaMs / 1000})
              RETURNING id
            `);
            restaurada = rows.length > 0;
          });
        } catch (error) {
          // Otro se llevó el horario durante esos diez segundos, o el contacto ya tiene
          // otra cita activa. No es un fallo del sistema: es una carrera que se perdió.
          if (
            esViolacionUnica(error, 'citas_slot_unico') ||
            esViolacionUnica(error, 'citas_una_activa_por_contacto')
          ) {
            return 'ocupado';
          }
          throw error;
        }

        if (!restaurada) return 'plazo';

        // Solo las que siguen sin reclamar: la condición de arriba ya lo comprobó, pero
        // entre aquella lectura y esta el relay no ha podido tocarlas porque el plazo no
        // ha vencido. Repetirlo aquí cuesta nada y no depende de ese razonamiento.
        await tx.execute(sql`
          DELETE FROM outbox
           WHERE tenant_id = ${tenantId}::uuid
             AND idempotency_key = ANY(${sql.param(claves)}::text[])
             AND publicado_at IS NULL AND intentos = 0
        `);

        return 'restaurada';
      });
    },
  };
}
