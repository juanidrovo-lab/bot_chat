/**
 * Usuarios, passkeys, retos y sesiones del panel.
 *
 * Todo bajo RLS como el resto: una credencial visible desde otro despacho no sería una fuga
 * de datos, sería una llave.
 */
import { sql } from 'drizzle-orm';
import type { CredencialGuardada } from '../../app/puertos/Passkeys.ts';
import type { RepoAuth, SesionPanel, UsuarioPanel } from '../../app/puertos/RepoAuth.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';

function aUsuario(r: Record<string, unknown>): UsuarioPanel {
  return {
    id: String(r['id']),
    email: String(r['email']),
    nombre: String(r['nombre']),
    rol: r['rol'] === 'secretaria' ? 'secretaria' : 'abogado',
    abogadoId: r['abogado_id'] === null ? null : String(r['abogado_id']),
    activo: r['activo'] === true,
  };
}

function aCredencial(r: Record<string, unknown>): CredencialGuardada & { usuarioId: string } {
  return {
    usuarioId: String(r['usuario_id']),
    credencialId: String(r['credencial_id']),
    clavePublica: String(r['clave_publica']),
    // `bigint` llega como string en SQL crudo, igual que `numeric` y `timestamptz`.
    contador: Number(r['contador']),
    transportes: (r['transportes'] as string[] | null) ?? [],
  };
}

export function crearRepoAuth(db: BaseDatos): RepoAuth {
  return {
    async usuarioPorInvitacion(tenantId, tokenHash) {
      // La caducidad la juzga el reloj de la base, no el del proceso.
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT id, email, nombre, rol, abogado_id, activo FROM usuarios
           WHERE tenant_id = ${tenantId}::uuid AND invitacion_hash = ${tokenHash}
             AND invitacion_expira_at > now() AND activo
        `),
      );
      const fila = rows[0];
      return fila === undefined ? null : aUsuario(fila);
    },

    async consumirInvitacion(tenantId, usuarioId) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE usuarios
             SET invitacion_hash = NULL, invitacion_expira_at = NULL, updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${usuarioId}::uuid
        `),
      );
    },

    async credencialesDe(tenantId, usuarioId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT usuario_id, credencial_id, clave_publica, contador, transportes
            FROM credenciales
           WHERE tenant_id = ${tenantId}::uuid AND usuario_id = ${usuarioId}::uuid
           ORDER BY created_at
        `),
      );
      return rows.map(aCredencial);
    },

    async credencialesDelDespacho(tenantId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT c.usuario_id, c.credencial_id, c.clave_publica, c.contador, c.transportes
            FROM credenciales c
            JOIN usuarios u ON u.tenant_id = c.tenant_id AND u.id = c.usuario_id
           WHERE c.tenant_id = ${tenantId}::uuid AND u.activo
           ORDER BY c.created_at
        `),
      );
      return rows.map(aCredencial);
    },

    async usuariosDelDespacho(tenantId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT id, email, nombre, rol, abogado_id, activo
            FROM usuarios
           WHERE tenant_id = ${tenantId}::uuid AND activo
           ORDER BY nombre
        `),
      );
      return rows.map(aUsuario);
    },

    async guardarReto(tenantId, reto, proposito, usuarioId, expiraAt) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          INSERT INTO retos (tenant_id, reto, proposito, usuario_id, expira_at)
          VALUES (${tenantId}::uuid, ${reto}, ${proposito}::proposito_reto,
                  ${usuarioId}::uuid, ${expiraAt})
        `),
      );
    },

    async consumirReto(tenantId, reto, proposito) {
      /**
       * Leer y borrar en la MISMA sentencia. Hacerlo en dos deja abierta la ventana que
       * permite responder dos veces al mismo reto, que es justo lo que el reto existe para
       * impedir. La caducidad también se evalúa aquí, con el reloj de la base.
       */
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ usuario_id: string | null }>(sql`
          DELETE FROM retos
           WHERE tenant_id = ${tenantId}::uuid AND reto = ${reto}
             AND proposito = ${proposito}::proposito_reto AND expira_at > now()
          RETURNING usuario_id
        `),
      );
      const fila = rows[0];
      if (fila === undefined) return { valido: false, usuarioId: null };
      return { valido: true, usuarioId: fila.usuario_id };
    },

    async guardarCredencial(tenantId, usuarioId, credencial, apodo) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          INSERT INTO credenciales
            (tenant_id, usuario_id, credencial_id, clave_publica, contador, transportes, apodo)
          VALUES (${tenantId}::uuid, ${usuarioId}::uuid, ${credencial.credencialId},
                  ${credencial.clavePublica}, ${credencial.contador},
                  ${sql.param([...credencial.transportes])}::text[], ${apodo})
        `),
      );
    },

    async anotarUso(tenantId, credencialId, contador) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE credenciales SET contador = ${contador}, ultimo_uso_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND credencial_id = ${credencialId}
        `),
      );
    },

    async crearSesion(tenantId, usuarioId, tokenHash, expiraAt) {
      return enTenant(db, tenantId, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO sesiones (tenant_id, usuario_id, token_hash, expira_at)
          VALUES (${tenantId}::uuid, ${usuarioId}::uuid, ${tokenHash}, ${expiraAt})
          RETURNING id
        `);
        await tx.execute(sql`
          UPDATE usuarios SET ultimo_acceso_at = now(), updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${usuarioId}::uuid
        `);
        return rows[0]!.id;
      });
    },

    async sesionPorHash(tenantId, tokenHash) {
      /**
       * La caducidad se compara en SQL. Hacerlo en JavaScript metería la deriva entre el
       * reloj del proceso y el de la base justo en la comprobación que decide si alguien
       * sigue dentro del panel.
       */
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          UPDATE sesiones s SET ultimo_uso_at = now()
            FROM usuarios u
           WHERE s.tenant_id = ${tenantId}::uuid AND s.token_hash = ${tokenHash}
             AND s.expira_at > now()
             AND u.tenant_id = s.tenant_id AND u.id = s.usuario_id AND u.activo
          RETURNING s.id AS sesion_id, u.id, u.email, u.nombre, u.rol, u.abogado_id, u.activo
        `),
      );
      const fila = rows[0];
      if (fila === undefined) return null;

      return {
        id: String(fila['sesion_id']),
        tenantId,
        usuario: aUsuario(fila),
      } satisfies SesionPanel;
    },

    async cerrarSesion(tenantId, tokenHash) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          DELETE FROM sesiones
           WHERE tenant_id = ${tenantId}::uuid AND token_hash = ${tokenHash}
        `),
      );
    },

    async purgar(tenantId) {
      return enTenant(db, tenantId, async (tx) => {
        const retos = await tx.execute(sql`
          DELETE FROM retos WHERE tenant_id = ${tenantId}::uuid AND expira_at <= now()
        `);
        const sesiones = await tx.execute(sql`
          DELETE FROM sesiones WHERE tenant_id = ${tenantId}::uuid AND expira_at <= now()
        `);
        return { retos: retos.rowCount ?? 0, sesiones: sesiones.rowCount ?? 0 };
      });
    },
  };
}
