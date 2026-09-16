import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { crearProcesarMensajeEntrante } from '../../src/app/procesarMensajeEntrante.ts';
import { FLOW_VERSION } from '../../src/domain/conversacion/version.ts';
import { abrirApp, limpiar, sembrarContacto, sembrarDespacho, type Despacho } from './ayuda.ts';
import {
  clasificadorFijo,
  dependencias,
  gestorMediaFalso,
  mensajeriaFalsa,
  type Envio,
} from './dobles.ts';
import type { MediaDe } from '../../src/app/puertos/Media.ts';
import { VERSION_CONSENTIMIENTO, contenidoDe } from '../../src/app/content.ts';
import type { DependenciasProcesar } from '../../src/app/procesarMensajeEntrante.ts';
import { crearRepoPanel } from '../../src/adapters/postgres/panel.ts';

const db = abrirApp();
let a: Despacho;

/** Martes 20 de octubre de 2026, 08:00 local. Fijo para que los horarios sean estables. */
const AHORA_MS = Date.UTC(2026, 9, 20, 13, 0, 0);

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

async function abrirConversacion(contactoId: string): Promise<string> {
  return enTenant(db, a.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversaciones (tenant_id, contacto_id, estado, flow_version, expira_at)
      VALUES (${a.tenantId}::uuid, ${contactoId}::uuid, 'INICIO', ${FLOW_VERSION},
              now() + interval '24 hours')
      RETURNING id
    `);
    return rows[0]!.id;
  });
}

/**
 * Conduce una conversación como lo haría el webhook: guarda el mensaje entrante y corre el
 * trabajador. Devuelve lo que el bot respondió en ese turno.
 */
function conversacionDe(
  conversacionId: string,
  contactoId: string,
  waId: string,
  mediaDe?: MediaDe,
  /** Para probar un despacho a medio configurar: sin Flow de datos, por ejemplo. */
  ajustes: Partial<DependenciasProcesar> = {},
) {
  const correo = mensajeriaFalsa();
  const procesar = crearProcesarMensajeEntrante({
    ...dependencias(db, correo.puerto, clasificadorFijo(null), AHORA_MS, mediaDe),
    ...ajustes,
  });
  let n = 0;

  async function enviar(payload: object): Promise<Envio[]> {
    n++;
    const waMessageId = `wamid.${conversacionId.slice(0, 8)}.${n}`;
    const desde = correo.envios.length;
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO mensajes (tenant_id, conversacion_id, wa_message_id, direccion, tipo, payload)
        VALUES (${a.tenantId}::uuid, ${conversacionId}::uuid, ${waMessageId}, 'entrante', 'text',
                ${JSON.stringify({ from: waId, id: waMessageId, timestamp: '1757000000', ...payload })}::jsonb)
      `),
    );
    await procesar({ tenantId: a.tenantId, conversacionId, contactoId, waMessageId });
    return correo.envios.slice(desde);
  }

  return {
    correo,
    texto: (body: string) => enviar({ type: 'text', text: { body } }),
    opcion: (id: string) =>
      enviar({
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id, title: id } },
      }),
    formulario: (respuesta: object) =>
      enviar({
        type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify(respuesta) } },
      }),
  };
}

const ultimaLista = (envios: Envio[]) => envios.find((e) => e.tipo === 'lista');
const ultimosBotones = (envios: Envio[]) => envios.find((e) => e.tipo === 'botones');

describe('flujo completo · de un «hola» a una cita reservada', () => {
  it('recorre el guion entero y deja la cita en la base', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    await chat.texto('buenas tardes');
    await chat.opcion('acepto');
    await chat.opcion('laboral');
    await chat.opcion('despido');
    await chat.opcion('agendar');

    const dias = ultimaLista(await chat.opcion('presencial'));
    expect(dias, 'el bot debería ofrecer días').toBeDefined();
    expect(dias!.opciones.length).toBeGreaterThan(0);

    const horas = ultimaLista(await chat.opcion(dias!.opciones[0]!));
    expect(horas, 'el bot debería ofrecer horas').toBeDefined();
    expect(horas!.opciones.length).toBeGreaterThan(0);
    const slotId = horas!.opciones[0]!;

    await chat.opcion(slotId);
    const confirmacion = ultimosBotones(
      await chat.formulario({ nombre: 'Ana Pérez', correo: 'ana@ejemplo.ec' }),
    );
    expect(confirmacion?.opciones).toEqual(['confirmar', 'cambiar']);

    const cierre = await chat.opcion('confirmar');
    expect(cierre.map((e) => e.cuerpo).join(' ')).toContain('Su cita quedó');

    // La cita existe de verdad, con su abogado, su honorario y su modalidad.
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string; materia: string; modalidad: string; honorario_usd: string; abogado_id: string }>(
        sql`SELECT estado, materia, modalidad, honorario_usd, abogado_id FROM citas`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      estado: 'reservada',
      materia: 'laboral',
      modalidad: 'presencial',
      honorario_usd: '40.00',
      abogado_id: a.abogadoId,
    });

    // Y los datos del formulario quedaron en el contacto.
    const contacto = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ nombre: string; email: string }>(
        sql`SELECT nombre, email FROM contactos WHERE id = ${a.contactoId}::uuid`,
      ),
    );
    expect(contacto.rows[0]).toMatchObject({ nombre: 'Ana Pérez', email: 'ana@ejemplo.ec' });

    // La conversación quedó cerrada: el mensaje siguiente abrirá otra.
    const conv = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string; cerrada: boolean }>(
        sql`SELECT estado, cerrada_at IS NOT NULL AS cerrada FROM conversaciones WHERE id = ${conversacionId}::uuid`,
      ),
    );
    expect(conv.rows[0]).toMatchObject({ estado: 'CITA_OK', cerrada: true });
  });

  it('el efecto externo quedó escrito en la outbox, no ejecutado', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    await chat.texto('hola');
    await chat.opcion('acepto');
    await chat.opcion('laboral');
    await chat.opcion('despido');
    await chat.opcion('agendar');
    const dias = ultimaLista(await chat.opcion('presencial'));
    const horas = ultimaLista(await chat.opcion(dias!.opciones[0]!));
    await chat.opcion(horas!.opciones[0]!);
    await chat.formulario({ nombre: 'Ana Pérez' });
    await chat.opcion('confirmar');

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ tipo: string; publicado_at: Date | null }>(sql`SELECT tipo, publicado_at FROM outbox`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tipo).toBe('gcal.crear');
    expect(rows[0]!.publicado_at).toBeNull();
  });
});

describe('flujo completo · cuando el horario se ocupa por el camino', () => {
  it('avisa y vuelve a preguntar la hora, sin dejar la conversación rota', async () => {
    const otroContacto = await sembrarContacto(db, a.tenantId, '593988888888');
    const conversacionUno = await abrirConversacion(a.contactoId);
    const conversacionDos = await abrirConversacion(otroContacto);

    const uno = conversacionDe(conversacionUno, a.contactoId, '593990000000');
    const dos = conversacionDe(conversacionDos, otroContacto, '593988888888');

    async function hastaElegirHora(chat: ReturnType<typeof conversacionDe>) {
      await chat.texto('hola');
      await chat.opcion('acepto');
      await chat.opcion('laboral');
      await chat.opcion('despido');
      await chat.opcion('agendar');
      const dias = ultimaLista(await chat.opcion('presencial'));
      return ultimaLista(await chat.opcion(dias!.opciones[0]!));
    }

    // Los dos llegan a la misma lista de horarios y eligen el mismo.
    const horasUno = await hastaElegirHora(uno);
    const horasDos = await hastaElegirHora(dos);
    const slotId = horasUno!.opciones[0]!;
    expect(horasDos!.opciones).toContain(slotId);

    await uno.opcion(slotId);
    await uno.formulario({ nombre: 'Ana Pérez' });
    await uno.opcion('confirmar');

    await dos.opcion(slotId);
    await dos.formulario({ nombre: 'Luis Mora' });
    const respuesta = await dos.opcion('confirmar');

    // El segundo recibe el aviso y una lista nueva, no un error.
    const cuerpos = respuesta.map((e) => e.cuerpo).join(' ');
    expect(cuerpos).toContain('se acaba de ocupar');
    const nuevasHoras = ultimaLista(respuesta);
    expect(nuevasHoras).toBeDefined();
    expect(nuevasHoras!.opciones).not.toContain(slotId);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM citas WHERE estado <> 'cancelada'`),
    );
    expect(rows[0]!.n).toBe('1');
  });
});

describe('notas de voz', () => {
  it('canjea la clave por un media_id: mandar la clave es un rechazo seguro de Meta', async () => {
    const { mediaDe, pedidos } = gestorMediaFalso();
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000', mediaDe);

    const envios = await chat.texto('buenas tardes');

    const audio = envios.find((e) => e.tipo === 'audio');
    expect(audio, 'la bienvenida debería llevar su nota de voz').toBeDefined();
    // Lo que va en el mensaje es el identificador que devolvió WhatsApp al subir el
    // fichero, no el nombre que le damos nosotros.
    expect(pedidos).toEqual(['bienvenida']);
    expect(audio!.cuerpo).toBe('media-de-bienvenida');
  });

  it('si el audio falla, el turno sigue: el texto ya salió', async () => {
    const { mediaDe } = gestorMediaFalso(new Error('WhatsApp respondió 500'));
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000', mediaDe);

    const envios = await chat.texto('buenas tardes');

    // Quedarse sin voz es mucho menos grave que dejar al usuario sin respuesta.
    expect(envios.some((e) => e.tipo === 'texto')).toBe(true);
    expect(envios.some((e) => e.tipo === 'audio')).toBe(false);
  });

  it('un despacho sin credenciales de media contesta igual, solo que sin voz', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    const envios = await chat.texto('buenas tardes');

    expect(envios.some((e) => e.tipo === 'texto')).toBe(true);
    expect(envios.some((e) => e.tipo === 'audio')).toBe(false);
  });
});

describe('despacho sin Flow de datos', () => {
  it('deriva a una persona en vez de pedir datos que no puede recoger', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    // Un despacho a medio configurar: todo lo demás funciona, pero no hay formulario.
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000', undefined, {
      contenido: async () => contenidoDe(),
    });

    await chat.texto('buenas tardes');
    await chat.opcion('acepto');
    await chat.opcion('laboral');
    await chat.opcion('despido');
    await chat.opcion('agendar');

    const dias = ultimaLista(await chat.opcion('presencial'));
    const horas = ultimaLista(await chat.opcion(dias!.opciones[0]!));
    // Al elegir la hora el guion pide los datos, y ahí es donde el despacho no puede.
    await chat.opcion(horas!.opciones[0]!);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string; derivada_motivo: string | null }>(sql`
        SELECT estado, derivada_motivo FROM conversaciones
         WHERE tenant_id = ${a.tenantId}::uuid AND id = ${conversacionId}::uuid
      `),
    );

    expect(rows[0]!.estado).toBe('DERIVADA');
    expect(rows[0]!.derivada_motivo).toBe('error_sistema');
  });
});

describe('consentimiento LOPDP', () => {
  async function contacto(): Promise<{ consent_at: string | null; consent_version: string | null; consent_revocado_at: string | null }> {
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ consent_at: string | null; consent_version: string | null; consent_revocado_at: string | null }>(sql`
        SELECT consent_at, consent_version, consent_revocado_at FROM contactos
         WHERE tenant_id = ${a.tenantId}::uuid AND id = ${a.contactoId}::uuid
      `),
    );
    return rows[0]!;
  }

  it('aceptar queda registrado con la versión del texto que vio', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    await chat.texto('hola');
    expect((await contacto()).consent_at).toBeNull();

    await chat.opcion('acepto');

    // Sin esto el estudio no puede demostrar nada el día que un titular o la autoridad lo
    // pregunten, que es la obligación central de la LOPDP en este sistema.
    const despues = await contacto();
    expect(despues.consent_at).not.toBeNull();
    expect(despues.consent_version).toBe(VERSION_CONSENTIMIENTO);
  });

  it('rechazar sella la revocación, no la aceptación', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    await chat.texto('hola');
    await chat.opcion('no_acepto');

    const despues = await contacto();
    expect(despues.consent_at).toBeNull();
    expect(despues.consent_revocado_at).not.toBeNull();
  });

  it('volver a escribir no reinicia la fecha: es la que prueba desde cuándo', async () => {
    const primera = await abrirConversacion(a.contactoId);
    const uno = conversacionDe(primera, a.contactoId, '593990000000');
    await uno.texto('hola');
    await uno.opcion('acepto');
    const inicial = (await contacto()).consent_at;

    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        UPDATE conversaciones SET cerrada_at = now()
         WHERE tenant_id = ${a.tenantId}::uuid AND id = ${primera}::uuid
      `),
    );

    const segunda = await abrirConversacion(a.contactoId);
    const dos = conversacionDe(segunda, a.contactoId, '593990000000');
    await dos.texto('hola otra vez');
    await dos.opcion('acepto');

    expect((await contacto()).consent_at).toBe(inicial);
  });

  it('queda también en la auditoría, que es lo que prueba que se preguntó', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    await chat.texto('hola');
    await chat.opcion('acepto');

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ tipo: string; payload: { aceptado?: boolean } }>(sql`
        SELECT tipo, payload FROM eventos
         WHERE tenant_id = ${a.tenantId}::uuid AND tipo = 'consentimiento'
      `),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.aceptado).toBe(true);
  });
});

describe('contacto bloqueado', () => {
  it('el bot se calla, pero el mensaje queda guardado', async () => {
    const panel = crearRepoPanel(db);
    await panel.cambiarBloqueo(a.tenantId, a.contactoId, true);

    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    const envios = await chat.texto('hola');

    // Contestar a quien el estudio bloqueó sería la forma más rápida de que el bloqueo no
    // sirva de nada.
    expect(envios).toEqual([]);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM mensajes
         WHERE tenant_id = ${a.tenantId}::uuid AND conversacion_id = ${conversacionId}::uuid
      `),
    );
    // El mensaje sí se guarda: hace falta para la auditoría y para demostrar qué llegó.
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('desbloquear le devuelve la voz al bot', async () => {
    const panel = crearRepoPanel(db);
    await panel.cambiarBloqueo(a.tenantId, a.contactoId, true);
    await panel.cambiarBloqueo(a.tenantId, a.contactoId, false);

    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    expect((await chat.texto('hola')).length).toBeGreaterThan(0);
  });

  it('el bloqueo vale para todas sus conversaciones, no solo una', async () => {
    const panel = crearRepoPanel(db);
    const primera = await abrirConversacion(a.contactoId);
    await conversacionDe(primera, a.contactoId, '593990000000').texto('hola');

    await panel.cambiarBloqueo(a.tenantId, a.contactoId, true);
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        UPDATE conversaciones SET cerrada_at = now()
         WHERE tenant_id = ${a.tenantId}::uuid AND id = ${primera}::uuid
      `),
    );

    // Es la diferencia con derivar, que es de una sola conversación.
    const segunda = await abrirConversacion(a.contactoId);
    expect(await conversacionDe(segunda, a.contactoId, '593990000000').texto('otra vez')).toEqual([]);
  });
});
