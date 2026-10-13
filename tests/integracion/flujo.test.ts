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

/**
 * `estado` y `contexto` se pueden fijar porque el camino en el que el bot **reserva** ya no
 * se alcanza desde el saludo: el guion recoge el caso y el abogado agenda. Lo que ese camino
 * resuelve —la carrera por un horario— sigue siendo lo más delicado del sistema, así que se
 * sigue probando entrando por donde empieza.
 */
async function abrirConversacion(
  contactoId: string,
  estado = 'INICIO',
  contexto: object = {},
): Promise<string> {
  return enTenant(db, a.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversaciones (tenant_id, contacto_id, estado, contexto, flow_version, expira_at)
      VALUES (${a.tenantId}::uuid, ${contactoId}::uuid, ${estado}, ${JSON.stringify(contexto)}::jsonb,
              ${FLOW_VERSION}, now() + interval '24 hours')
      RETURNING id
    `);
    return rows[0]!.id;
  });
}

/** El contexto con el que el guion llega a elegir día: materia y modalidad ya decididas. */
const LISTO_PARA_AGENDAR = { materia: 'laboral', modalidad: 'presencial', triaje: [] };

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

describe('flujo completo · de un «hola» a una consulta en la bandeja', () => {
  it('recoge el caso, avisa al abogado y deja la conversación esperando', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    await chat.texto('buenas tardes');
    await chat.opcion('acepto');

    // El relato: texto libre, sin clasificador de por medio.
    await chat.texto('Me demandaron por una deuda y me llegó un papel del juzgado.');

    // Al responder los antecedentes, el guion ya propone agendar.
    const agendar = ultimosBotones(
      await chat.texto('Ya me citaron y me demandaron. No me han embargado nada.'),
    );
    expect(agendar, 'el bot debería ofrecer presencial o llamada').toBeDefined();
    expect(agendar!.opciones).toEqual(['presencial', 'virtual']);
    expect(agendar!.cuerpo).toContain('martes a jueves');

    await chat.opcion('presencial');

    // El bot NO reserva: no hay ninguna cita en la base.
    const citas = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM citas`),
    );
    expect(citas.rows[0]!.n).toBe('0');

    // La conversación queda derivada: es lo que hace cierto el «le escribirá».
    const conv = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string; derivada_at: Date | null }>(
        sql`SELECT estado, derivada_at FROM conversaciones WHERE id = ${conversacionId}::uuid`,
      ),
    );
    expect(conv.rows[0]!.estado).toBe('DERIVADA');
    expect(conv.rows[0]!.derivada_at).not.toBeNull();
  });

  it('lo que escribió el contacto se guarda y el panel lo puede leer después', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');
    const relato = 'Me demandaron por una deuda de hace tres años.';

    await chat.texto('hola');
    await chat.opcion('acepto');
    await chat.texto(relato);

    // Es el motivo por el que el bot pregunta y no responde: lo lee una persona después.
    const panel = crearRepoPanel(db);
    const transcripcion = await panel.transcripcion(a.tenantId, conversacionId);
    expect(transcripcion!.mensajes.map((m) => m.texto)).toContain(relato);
    // Y el botón que pulsó sale con su título, no con el identificador.
    expect(transcripcion!.mensajes.map((m) => m.texto)).toContain('acepto');
  });

  it('el aviso al abogado queda escrito en la outbox, no ejecutado', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000', undefined, {
      // Este despacho sí tiene a quién avisar.
      contenido: async () => ({
        ...contenidoDe(),
        avisoAbogado: { waId: '593911111111', plantilla: 'aviso_consulta' },
      }),
    });

    await chat.texto('hola');
    await chat.opcion('acepto');
    await chat.texto('mi caso');
    await chat.texto('ya me citaron');
    await chat.opcion('virtual');

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ tipo: string; publicado_at: Date | null }>(
        sql`SELECT tipo, publicado_at FROM outbox`,
      ),
    );
    // En la misma transacción que el turno, y sin publicar: lo publica el relay.
    expect(rows.map((r) => r.tipo)).toEqual(['wa.aviso_abogado']);
    expect(rows[0]!.publicado_at).toBeNull();
  });

  it('sin número configurado no se encola nada, y la consulta igual queda en la bandeja', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000');

    await chat.texto('hola');
    await chat.opcion('acepto');
    await chat.texto('mi caso');
    await chat.texto('ya me citaron');
    await chat.opcion('virtual');

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM outbox`),
    );
    expect(rows[0]!.n).toBe('0');

    const conv = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ derivada_at: Date | null }>(
        sql`SELECT derivada_at FROM conversaciones WHERE id = ${conversacionId}::uuid`,
      ),
    );
    expect(conv.rows[0]!.derivada_at).not.toBeNull();
  });
});

describe('flujo completo · cuando el horario se ocupa por el camino', () => {
  it('avisa y vuelve a preguntar la hora, sin dejar la conversación rota', async () => {
    const otroContacto = await sembrarContacto(db, a.tenantId, '593988888888');
    const conversacionUno = await abrirConversacion(a.contactoId, 'ELEGIR_DIA', LISTO_PARA_AGENDAR);
    const conversacionDos = await abrirConversacion(otroContacto, 'ELEGIR_DIA', LISTO_PARA_AGENDAR);

    const uno = conversacionDe(conversacionUno, a.contactoId, '593990000000');
    const dos = conversacionDe(conversacionDos, otroContacto, '593988888888');

    /**
     * Se entra directo en ELEGIR_DIA: el guion de hoy no lleva aquí, pero `citas_slot_unico`
     * sigue siendo la exclusión que impide dos citas en el mismo hueco, y eso no se prueba
     * con dobles.
     */
    async function hastaElegirHora(chat: ReturnType<typeof conversacionDe>) {
      const dias = ultimaLista(await chat.texto('empezar'));
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
    // Como la carrera por el horario: se entra por donde el guion pide los datos, que es lo
    // que hoy solo alcanza el camino de reagendar.
    const conversacionId = await abrirConversacion(a.contactoId, 'ELEGIR_DIA', LISTO_PARA_AGENDAR);
    // Un despacho a medio configurar: todo lo demás funciona, pero no hay formulario.
    const chat = conversacionDe(conversacionId, a.contactoId, '593990000000', undefined, {
      contenido: async () => contenidoDe(),
    });

    const dias = ultimaLista(await chat.texto('empezar'));
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
