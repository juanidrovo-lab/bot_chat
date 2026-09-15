/**
 * El panel contra Postgres de verdad.
 *
 * Tres cosas no se pueden probar con dobles y son justo las que importan: que las tablas
 * nuevas están bajo RLS —una credencial visible desde otro despacho es una llave, no una
 * fuga—, que el deshacer pierde limpiamente la carrera por el horario, y que el reto de
 * WebAuthn se consume de verdad.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearRepoAuth } from '../../src/adapters/postgres/auth.ts';
import { crearAuditoria, crearRepoPanel } from '../../src/adapters/postgres/panel.ts';
import { crearRepoExportacion } from '../../src/adapters/postgres/exportacion.ts';
import { crearRepoCitas } from '../../src/adapters/postgres/reservas.ts';
import { resolverPorSlug } from '../../src/adapters/postgres/tenants.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import {
  abrirApp,
  limpiar,
  mensajeCompleto,
  sembrarContacto,
  sembrarDespacho,
  sembrarUsuario,
  type Despacho,
} from './ayuda.ts';

const db = abrirApp();
const auth = crearRepoAuth(db);
const panel = crearRepoPanel(db);
const auditoria = crearAuditoria(db);
const exportacion = crearRepoExportacion(db);
const citas = crearRepoCitas(db);

const GRACIA_MS = 10_000;
let a: Despacho;
let b: Despacho;

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
  b = await sembrarDespacho('despacho-b');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

function enUnaHora(offsetHoras = 1): Date {
  const d = new Date(Date.now() + offsetHoras * 3600_000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

async function reservar(d: Despacho, contactoId: string, inicia: Date): Promise<string> {
  const cita = await citas.reservar({
    tenantId: d.tenantId,
    abogadoId: d.abogadoId,
    contactoId,
    materia: 'laboral',
    modalidad: 'presencial',
    iniciaAt: inicia,
    terminaAt: new Date(inicia.getTime() + 45 * 60_000),
    honorarioUsd: '40.00',
    consumeCupo: true,
  });
  return cita.id;
}

/**
 * Solo los efectos de la cancelación. La reserva deja además un `gcal.crear`, que no es
 * asunto del deshacer: ese trabajo ya sabe no hacer nada si la cita está cancelada.
 */
async function pendientes(d: Despacho, citaId: string): Promise<string[]> {
  const { rows } = await enTenant(db, d.tenantId, (tx) =>
    tx.execute<{ idempotency_key: string }>(sql`
      SELECT idempotency_key FROM outbox
       WHERE tenant_id = ${d.tenantId}::uuid
         AND idempotency_key IN (${'wa.cancelada:' + citaId}, ${'gcal.borrar:' + citaId})
       ORDER BY idempotency_key
    `),
  );
  return rows.map((r) => r.idempotency_key);
}

describe('resolverPorSlug', () => {
  it('resuelve sin tenant fijado, como el webhook con el phone_number_id', async () => {
    expect((await resolverPorSlug(db, 'despacho-a'))?.id).toBe(a.tenantId);
    expect(await resolverPorSlug(db, 'no-existe')).toBeNull();
  });
});

describe('RLS de las tablas del panel', () => {
  it('las credenciales de un despacho son invisibles desde otro', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await auth.guardarCredencial(
      a.tenantId,
      usuarioId,
      { credencialId: 'cred-a', clavePublica: 'k', contador: 0, transportes: ['internal'] },
      'llave del portátil',
    );

    expect(await auth.credencialesDelDespacho(a.tenantId)).toHaveLength(1);
    // Es la diferencia entre ver un dato ajeno y tener la llave de la casa ajena.
    expect(await auth.credencialesDelDespacho(b.tenantId)).toEqual([]);
  });

  it('una sesión de otro despacho no resuelve aunque se acierte el hash', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await auth.crearSesion(a.tenantId, usuarioId, 'hash-comun', new Date(Date.now() + 3600_000));

    expect(await auth.sesionPorHash(a.tenantId, 'hash-comun')).not.toBeNull();
    expect(await auth.sesionPorHash(b.tenantId, 'hash-comun')).toBeNull();
  });

  it('la aplicación no puede dar de alta usuarios: es una tarea administrativa', async () => {
    const error = await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO usuarios (tenant_id, email, nombre)
        VALUES (${a.tenantId}::uuid, 'intruso@a.ec', 'Intruso')
      `),
    ).catch((e: unknown) => e);

    expect(mensajeCompleto(error)).toContain('permission denied');
  });
});

describe('sesiones', () => {
  it('una sesión caducada no resuelve', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await auth.crearSesion(a.tenantId, usuarioId, 'hash-viejo', new Date(Date.now() - 1000));

    // La caducidad se compara con el reloj de la base, no con el del proceso.
    expect(await auth.sesionPorHash(a.tenantId, 'hash-viejo')).toBeNull();
  });

  it('un usuario dado de baja no entra aunque su sesión siga viva', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await auth.crearSesion(a.tenantId, usuarioId, 'hash-vivo', new Date(Date.now() + 3600_000));

    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        UPDATE usuarios SET activo = false
         WHERE tenant_id = ${a.tenantId}::uuid AND id = ${usuarioId}::uuid
      `),
    );

    // Dar de baja a alguien no puede exigir además acordarse de borrarle las sesiones.
    expect(await auth.sesionPorHash(a.tenantId, 'hash-vivo')).toBeNull();
  });

  it('purgar borra lo vencido y deja lo vivo', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await auth.crearSesion(a.tenantId, usuarioId, 'viva', new Date(Date.now() + 3600_000));
    await auth.crearSesion(a.tenantId, usuarioId, 'muerta', new Date(Date.now() - 1000));
    await auth.guardarReto(a.tenantId, 'reto-viejo', 'acceso', null, new Date(Date.now() - 1000));

    expect(await auth.purgar(a.tenantId)).toEqual({ retos: 1, sesiones: 1 });
    expect(await auth.sesionPorHash(a.tenantId, 'viva')).not.toBeNull();
  });
});

describe('retos', () => {
  it('se consumen una sola vez', async () => {
    await auth.guardarReto(a.tenantId, 'reto-1', 'acceso', null, new Date(Date.now() + 60_000));

    expect(await auth.consumirReto(a.tenantId, 'reto-1', 'acceso')).toMatchObject({ valido: true });
    // Leer y borrar en la misma sentencia es lo que cierra la ventana para repetir una
    // respuesta capturada.
    expect(await auth.consumirReto(a.tenantId, 'reto-1', 'acceso')).toMatchObject({ valido: false });
  });

  it('uno vencido no vale, y la caducidad la juzga la base', async () => {
    await auth.guardarReto(a.tenantId, 'reto-2', 'acceso', null, new Date(Date.now() - 1000));

    expect(await auth.consumirReto(a.tenantId, 'reto-2', 'acceso')).toMatchObject({ valido: false });
  });

  it('un reto de registro no sirve para acceder', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await auth.guardarReto(a.tenantId, 'reto-3', 'registro', usuarioId, new Date(Date.now() + 60_000));

    expect(await auth.consumirReto(a.tenantId, 'reto-3', 'acceso')).toMatchObject({ valido: false });
  });
});

describe('cancelar con gracia y deshacer', () => {
  it('aplaza los efectos: el relay no los ve hasta que vence el plazo', async () => {
    const inicia = enUnaHora();
    const citaId = await reservar(a, a.contactoId, inicia);

    expect(await panel.cancelarConGracia(a.tenantId, citaId, GRACIA_MS)).toBe(true);
    expect(await pendientes(a, citaId)).toEqual(['wa.cancelada:' + citaId]);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ futuro: boolean }>(sql`
        SELECT proximo_intento_at > now() AS futuro FROM outbox
         WHERE tenant_id = ${a.tenantId}::uuid AND idempotency_key = ${'wa.cancelada:' + citaId}
      `),
    );
    expect(rows[0]!.futuro).toBe(true);
  });

  it('deshacer restaura la cita y borra los avisos que no salieron', async () => {
    const inicia = enUnaHora();
    const citaId = await reservar(a, a.contactoId, inicia);
    await panel.cancelarConGracia(a.tenantId, citaId, GRACIA_MS);

    expect(await panel.deshacerCancelacion(a.tenantId, citaId, GRACIA_MS)).toBe('restaurada');
    expect(await pendientes(a, citaId)).toEqual([]);

    const vivas = await panel.citasEntre(
      a.tenantId,
      inicia.getTime() - 60_000,
      inicia.getTime() + 60_000,
    );
    expect(vivas.map((c) => c.id)).toEqual([citaId]);
  });

  it('si otro se llevó el horario, deshacer dice «ocupado» en vez de reventar', async () => {
    const inicia = enUnaHora(2);
    const citaId = await reservar(a, a.contactoId, inicia);
    await panel.cancelarConGracia(a.tenantId, citaId, GRACIA_MS);

    // Diez segundos dan de sobra para que otro contacto tome el hueco liberado.
    const otro = await sembrarContacto(db, a.tenantId, '593991111111');
    await reservar(a, otro, inicia);

    expect(await panel.deshacerCancelacion(a.tenantId, citaId, GRACIA_MS)).toBe('ocupado');
  });

  it('fuera del plazo ya no se deshace', async () => {
    const citaId = await reservar(a, a.contactoId, enUnaHora(3));
    await panel.cancelarConGracia(a.tenantId, citaId, GRACIA_MS);

    // Plazo cero: la ventana ya venció en el momento de preguntar.
    expect(await panel.deshacerCancelacion(a.tenantId, citaId, 0)).toBe('plazo');
  });

  it('deshacer dos veces no restaura dos veces', async () => {
    const citaId = await reservar(a, a.contactoId, enUnaHora(4));
    await panel.cancelarConGracia(a.tenantId, citaId, GRACIA_MS);

    expect(await panel.deshacerCancelacion(a.tenantId, citaId, GRACIA_MS)).toBe('restaurada');
    expect(await panel.deshacerCancelacion(a.tenantId, citaId, GRACIA_MS)).toBe('plazo');
  });
});

describe('auditoría y exportación', () => {
  it('el evento se guarda bajo la RLS del despacho al que pertenece el dato', async () => {
    await auditoria.registrar({
      tenantId: a.tenantId,
      actor: 'usuario:u-1',
      tipo: 'contacto.visto',
      entidad: 'contacto',
      entidadId: a.contactoId,
    });

    const { rows } = await enTenant(db, b.tenantId, (tx) =>
      tx.execute(sql`SELECT 1 FROM eventos WHERE tenant_id = ${b.tenantId}::uuid`),
    );
    expect(rows).toHaveLength(0);
  });

  it('el expediente trae lo del contacto y solo lo del contacto', async () => {
    const inicia = enUnaHora(5);
    await reservar(a, a.contactoId, inicia);
    const otro = await sembrarContacto(db, a.tenantId, '593992222222');
    await reservar(a, otro, enUnaHora(6));

    const expediente = await exportacion.expedienteDe(a.tenantId, a.contactoId);

    expect(expediente).not.toBeNull();
    expect(expediente!.citas).toHaveLength(1);
    expect(expediente!.contacto.waId).toBe('593990000000');
    // Fechas como texto ISO: el destinatario del export es un archivo, no este proceso.
    expect(expediente!.citas[0]!.iniciaAt).toBe(inicia.toISOString());
  });

  it('un contacto de otro despacho no existe para este', async () => {
    expect(await exportacion.expedienteDe(b.tenantId, a.contactoId)).toBeNull();
  });
});
