/**
 * El panel contra Postgres de verdad.
 *
 * Tres cosas no se pueden probar con dobles y son justo las que importan: que las tablas
 * nuevas están bajo RLS —una credencial visible desde otro despacho es una llave, no una
 * fuga—, que el deshacer pierde limpiamente la carrera por el horario, y que el reto de
 * WebAuthn se consume de verdad.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearRepoAuth } from '../../src/adapters/postgres/auth.ts';
import { crearAuditoria, crearRepoPanel } from '../../src/adapters/postgres/panel.ts';
import { crearRepoExportacion } from '../../src/adapters/postgres/exportacion.ts';
import { crearContenidoDe } from '../../src/adapters/postgres/contenido.ts';
import { crearRepoCalendarios } from '../../src/adapters/postgres/calendarios.ts';
import { cifrar } from '../../src/platform/crypto.ts';
import { crearRepoCitas } from '../../src/adapters/postgres/reservas.ts';
import { resolverPorSlug } from '../../src/adapters/postgres/tenants.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import {
  abrirApp,
  limpiar,
  mensajeCompleto,
  sembrarContacto,
  sembrarDespacho,
  sembrarInvitacion,
  sembrarUsuario,
  configurarTarifario,
  urlOwner,
  CLAVE_HEX,
  TARIFARIO,
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

  /**
   * `citas.materia` guarda la clave del tarifario —«laboral»—, que es lo que el bot necesita
   * para casarla con el abogado. El panel lo lee una persona: enseñar el identificador en
   * minúscula es enseñarle la tripa de la base de datos.
   */
  it('la materia se enseña con el título del tarifario, no con su identificador', async () => {
    const inicia = enUnaHora(3);
    const citaId = await reservar(a, a.contactoId, inicia);

    const [cita] = await panel.citasEntre(
      a.tenantId,
      inicia.getTime() - 60_000,
      inicia.getTime() + 60_000,
    );
    expect(cita!.materia).toBe('Laboral');

    const ficha = await panel.ficha(a.tenantId, a.contactoId);
    expect(ficha!.citas.find((c) => c.id === citaId)!.materia).toBe('Laboral');
  });

  it('una materia que ya no está en el tarifario cae de vuelta a su identificador', async () => {
    const inicia = enUnaHora(4);
    // Si no, quitar una materia del tarifario dejaría la columna en blanco y la cita,
    // que sigue en pie, parecería no tener asunto.
    const sinLaboral: Record<string, unknown> = { ...TARIFARIO };
    delete sinLaboral['laboral'];
    await configurarTarifario(a.tenantId, sinLaboral);
    await reservar(a, a.contactoId, inicia);

    const [cita] = await panel.citasEntre(
      a.tenantId,
      inicia.getTime() - 60_000,
      inicia.getTime() + 60_000,
    );
    expect(cita!.materia).toBe('laboral');
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

describe('invitaciones de alta', () => {
  const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

  it('resuelve al usuario por el hash del testigo', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await sembrarInvitacion(a.tenantId, usuarioId, 'testigo-en-mano');

    const usuario = await auth.usuarioPorInvitacion(a.tenantId, hash('testigo-en-mano'));

    expect(usuario?.id).toBe(usuarioId);
  });

  it('una caducada no vale, y la caducidad la juzga la base', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await sembrarInvitacion(a.tenantId, usuarioId, 'vieja', new Date(Date.now() - 1000));

    expect(await auth.usuarioPorInvitacion(a.tenantId, hash('vieja'))).toBeNull();
  });

  it('la de un despacho no sirve en otro', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await sembrarInvitacion(a.tenantId, usuarioId, 'compartida');

    expect(await auth.usuarioPorInvitacion(b.tenantId, hash('compartida'))).toBeNull();
  });

  it('un usuario de baja no puede darse de alta aunque tenga invitación viva', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await sembrarInvitacion(a.tenantId, usuarioId, 'de-baja');
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        UPDATE usuarios SET activo = false
         WHERE tenant_id = ${a.tenantId}::uuid AND id = ${usuarioId}::uuid
      `),
    );

    expect(await auth.usuarioPorInvitacion(a.tenantId, hash('de-baja'))).toBeNull();
  });

  it('consumirla la deja inservible: es de un solo uso', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await sembrarInvitacion(a.tenantId, usuarioId, 'una-vez');

    await auth.consumirInvitacion(a.tenantId, usuarioId);

    expect(await auth.usuarioPorInvitacion(a.tenantId, hash('una-vez'))).toBeNull();
  });
});

describe('buscador', () => {
  it('encuentra por nombre y por número, y no cruza despachos', async () => {
    const otro = await sembrarContacto(db, b.tenantId, '593998888888');
    await enTenant(db, b.tenantId, (tx) =>
      tx.execute(sql`
        UPDATE contactos SET nombre = 'Contacto Prueba'
         WHERE tenant_id = ${b.tenantId}::uuid AND id = ${otro}::uuid
      `),
    );

    const porNombre = await panel.buscarContactos(a.tenantId, 'Prueba', 10);
    const porNumero = await panel.buscarContactos(a.tenantId, '99000', 10);

    expect(porNombre.map((c) => c.id)).toEqual([a.contactoId]);
    expect(porNumero.map((c) => c.id)).toEqual([a.contactoId]);
    // El del otro despacho se llama igual y no aparece: lo tapa la RLS.
    expect(porNombre).toHaveLength(1);
  });

  it('trae la próxima cita vigente, no una pasada ni una cancelada', async () => {
    const futura = enUnaHora(20);
    await reservar(a, a.contactoId, futura);

    const [encontrado] = await panel.buscarContactos(a.tenantId, 'Prueba', 10);

    expect(encontrado!.proximaCitaAt?.getTime()).toBe(futura.getTime());
  });

  it('los comodines de LIKE van escapados', async () => {
    // Un contacto que se llame «100%» no puede convertir la búsqueda en «todo».
    const resultados = await panel.buscarContactos(a.tenantId, '%', 10);

    expect(resultados).toEqual([]);
  });

  it('respeta el límite', async () => {
    for (const n of ['1', '2', '3']) await sembrarContacto(db, a.tenantId, `59399000000${n}`);

    expect(await panel.buscarContactos(a.tenantId, '5939', 2)).toHaveLength(2);
  });
});

describe('marcarAsistencia', () => {
  it('marca atendida una cita que ya empezó', async () => {
    const citaId = await reservar(a, a.contactoId, new Date(Date.now() - 3600_000));

    expect(await panel.marcarAsistencia(a.tenantId, citaId, true)).toBe(true);
    expect(await estadoDe(a, citaId)).toBe('atendida');
  });

  it('marca ausente, que es la mitad que sostiene la tasa de ausencias', async () => {
    const citaId = await reservar(a, a.contactoId, new Date(Date.now() - 3600_000));

    expect(await panel.marcarAsistencia(a.tenantId, citaId, false)).toBe(true);
    expect(await estadoDe(a, citaId)).toBe('ausente');
  });

  it('no deja marcar una cita que todavía no empezó', async () => {
    const citaId = await reservar(a, a.contactoId, enUnaHora(30));

    // Decir que alguien faltó a una cita de mañana no significa nada, y sería un clic de
    // más muy fácil de dar.
    expect(await panel.marcarAsistencia(a.tenantId, citaId, false)).toBe(false);
    expect(await estadoDe(a, citaId)).toBe('reservada');
  });

  it('marcar dos veces no es un error, pero solo cuenta la primera', async () => {
    const citaId = await reservar(a, a.contactoId, new Date(Date.now() - 3600_000));

    await panel.marcarAsistencia(a.tenantId, citaId, true);

    expect(await panel.marcarAsistencia(a.tenantId, citaId, false)).toBe(false);
    expect(await estadoDe(a, citaId)).toBe('atendida');
  });

  it('una cita cancelada no se puede marcar como atendida', async () => {
    const citaId = await reservar(a, a.contactoId, new Date(Date.now() - 3600_000));
    await panel.cancelarConGracia(a.tenantId, citaId, 0);

    expect(await panel.marcarAsistencia(a.tenantId, citaId, true)).toBe(false);
  });
});

async function estadoDe(d: Despacho, citaId: string): Promise<string> {
  const { rows } = await enTenant(db, d.tenantId, (tx) =>
    tx.execute<{ estado: string }>(sql`
      SELECT estado FROM citas WHERE tenant_id = ${d.tenantId}::uuid AND id = ${citaId}::uuid
    `),
  );
  return rows[0]!.estado;
}

describe('contenido por despacho', () => {
  const contenidoDeDespacho = crearContenidoDe(db);

  async function configurar(d: Despacho, textos: object, flowDatos: object | null): Promise<void> {
    const cliente = new pg.Client({ connectionString: urlOwner() });
    await cliente.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [d.tenantId]);
      await cliente.query(
        'UPDATE tenant_config SET textos = $2::jsonb, flow_datos = $3::jsonb WHERE tenant_id = $1',
        [d.tenantId, JSON.stringify(textos), flowDatos === null ? null : JSON.stringify(flowDatos)],
      );
      await cliente.query('COMMIT');
    } finally {
      await cliente.end();
    }
  }

  it('un despacho que reescribe UN texto conserva todos los demás', async () => {
    // Es el caso que fallaba: en Zod 4 un `record` con clave enum es exhaustivo, así que
    // validar contra las treinta y tantas claves descartaba el único texto reescrito.
    await configurar(a, { bienvenida: 'Le atiende el Estudio Vélez.' }, null);

    const contenido = await contenidoDeDespacho(a.tenantId);

    expect(contenido.textos.bienvenida).toBe('Le atiende el Estudio Vélez.');
    expect(contenido.textos.derivada).toBeDefined();
    expect(contenido.textos.derivada.length).toBeGreaterThan(0);
  });

  it('una clave mal escrita no se lleva por delante a las buenas', async () => {
    const avisos: object[] = [];
    const leer = crearContenidoDe(db, { warn: (datos) => avisos.push(datos) });
    await configurar(a, { bienvenida: 'Hola.', bienbenida: 'Con falta.' }, null);

    const contenido = await leer(a.tenantId);

    expect(contenido.textos.bienvenida).toBe('Hola.');
    // Y se avisa: si no, el estudio se queda esperando un texto que nunca aparece.
    expect(avisos).toHaveLength(1);
  });

  it('el Flow de datos sale de la configuración del despacho', async () => {
    await configurar(a, {}, { flowId: '123', cta: 'Completar datos' });

    expect((await contenidoDeDespacho(a.tenantId)).flowDatos).toEqual({
      flowId: '123',
      cta: 'Completar datos',
    });
  });

  it('sin Flow configurado no se inventa uno', async () => {
    await configurar(a, {}, null);

    // Es lo que hace que la conversación se derive antes de pedir datos en vez de quedarse
    // esperando una respuesta de formulario que no va a llegar.
    expect((await contenidoDeDespacho(a.tenantId)).flowDatos).toBeUndefined();
  });

  it('un Flow a medio configurar se ignora: peor sería mandar un id vacío', async () => {
    await configurar(a, {}, { flowId: '', cta: 'Completar' });

    expect((await contenidoDeDespacho(a.tenantId)).flowDatos).toBeUndefined();
  });

  it('el contenido de un despacho no se cuela en el de otro', async () => {
    await configurar(a, { bienvenida: 'Soy el A.' }, null);
    await configurar(b, { bienvenida: 'Soy el B.' }, null);

    expect((await contenidoDeDespacho(a.tenantId)).textos.bienvenida).toBe('Soy el A.');
    expect((await contenidoDeDespacho(b.tenantId)).textos.bienvenida).toBe('Soy el B.');
  });
});

describe('calendarios de Google', () => {
  const calendarios = crearRepoCalendarios(db);

  it('lista los abogados del despacho y dice quién no ha conectado', async () => {
    const lista = await calendarios.listar(a.tenantId);

    expect(lista).toHaveLength(1);
    expect(lista[0]!.calendarId).toBeNull();
  });

  it('un abogado de otro despacho no existe para este', async () => {
    expect(await calendarios.abogado(b.tenantId, a.abogadoId)).toBeNull();
  });

  it('el state es de un solo uso y dice a qué abogado pertenece', async () => {
    await calendarios.guardarState(
      a.tenantId,
      'state-1',
      a.abogadoId,
      new Date(Date.now() + 60_000),
    );

    expect(await calendarios.consumirState(a.tenantId, 'state-1')).toEqual({
      abogadoId: a.abogadoId,
    });
    // En dos sentencias, la ventana intermedia permitiría responder dos veces al mismo.
    expect(await calendarios.consumirState(a.tenantId, 'state-1')).toBeNull();
  });

  it('un state caducado no vale, y la caducidad la juzga la base', async () => {
    await calendarios.guardarState(a.tenantId, 'viejo', a.abogadoId, new Date(Date.now() - 1000));

    expect(await calendarios.consumirState(a.tenantId, 'viejo')).toBeNull();
  });

  it('el state de un despacho no se consume desde otro', async () => {
    await calendarios.guardarState(a.tenantId, 'suyo', a.abogadoId, new Date(Date.now() + 60_000));

    expect(await calendarios.consumirState(b.tenantId, 'suyo')).toBeNull();
    expect(await calendarios.consumirState(a.tenantId, 'suyo')).not.toBeNull();
  });

  it('guardar deja el calendario visible y el token no en claro', async () => {
    await calendarios.guardarCalendario(
      a.tenantId,
      a.abogadoId,
      'abogada@estudio.ec',
      cifrar('el-refresh-token', CLAVE_HEX),
    );

    const lista = await calendarios.listar(a.tenantId);
    expect(lista[0]!.calendarId).toBe('abogada@estudio.ec');

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ gcal_refresh_token_enc: string }>(sql`
        SELECT gcal_refresh_token_enc FROM abogados
         WHERE tenant_id = ${a.tenantId}::uuid AND id = ${a.abogadoId}::uuid
      `),
    );
    expect(rows[0]!.gcal_refresh_token_enc).not.toContain('el-refresh-token');
  });

  it('desconectar borra las dos mitades: media credencial no sirve', async () => {
    await calendarios.guardarCalendario(a.tenantId, a.abogadoId, 'x@y.ec', 'cifrado');

    await calendarios.olvidarCalendario(a.tenantId, a.abogadoId);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ gcal_calendar_id: string | null; gcal_refresh_token_enc: string | null }>(sql`
        SELECT gcal_calendar_id, gcal_refresh_token_enc FROM abogados
         WHERE tenant_id = ${a.tenantId}::uuid AND id = ${a.abogadoId}::uuid
      `),
    );
    expect(rows[0]).toEqual({ gcal_calendar_id: null, gcal_refresh_token_enc: null });
  });
});
