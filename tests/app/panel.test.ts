/**
 * Lo que este archivo fija no es la forma de la pantalla: es la disciplina de auditoría.
 *
 * La LOPDP obliga a poder responder «quién vio la ficha de esta persona y cuándo». Eso solo
 * se sostiene si **toda** lectura de datos personales pasa por el caso de uso y deja rastro,
 * y si ese rastro no es a su vez una copia del dato.
 */
import { describe, expect, it } from 'vitest';
import { crearReloj } from '../../src/adapters/reloj.ts';
import {
  GRACIA_MS,
  MINIMO_BUSQUEDA,
  buscarContactos,
  cancelarDesdePanel,
  cerrarConversacion,
  deshacerCancelacion,
  hoyManana,
  marcarAsistencia,
  verFicha,
} from '../../src/app/panel.ts';
import type { EventoAuditable } from '../../src/app/puertos/Auditoria.ts';
import type { CitaDelDia, FichaContacto, RepoPanel } from '../../src/app/puertos/RepoPanel.ts';

const TENANT = 'despacho-a';
const ACTOR = 'usuario:abc';
/** Miércoles 16 de septiembre de 2026, 14:00 en Guayaquil. */
const AHORA = Date.parse('2026-09-16T19:00:00Z');
const reloj = crearReloj(() => AHORA);

function cita(parcial: Partial<CitaDelDia> = {}): CitaDelDia {
  return {
    id: 'cita-1',
    iniciaAt: new Date(AHORA + 3600_000),
    terminaAt: new Date(AHORA + 3600_000 + 45 * 60_000),
    estado: 'reservada',
    materia: 'laboral',
    modalidad: 'presencial',
    honorarioUsd: '40.00',
    abogadoId: 'ab-1',
    abogadoNombre: 'Abg. Prueba',
    contactoId: 'ct-1',
    contactoNombre: 'Ana Pérez',
    contactoWaId: '593990000000',
    ...parcial,
  };
}

const ficha: FichaContacto = {
  id: 'ct-1',
  waId: '593990000000',
  nombre: 'Ana Pérez',
  email: 'ana@ejemplo.ec',
  cedula: '0102030405',
  consentAt: new Date(AHORA - 86_400_000),
  consentRevocadoAt: null,
  bloqueado: false,
  citas: [],
};

function entorno(opciones: {
  citas?: CitaDelDia[];
  ficha?: FichaContacto | null;
  cancela?: boolean;
  deshace?: 'restaurada' | 'plazo' | 'ocupado';
  cierra?: boolean;
  encontrados?: { id: string; nombre: string | null; waId: string; proximaCitaAt: Date | null }[];
  marca?: boolean;
} = {}) {
  const registrados: EventoAuditable[] = [];
  const llamadas: { gracia?: number; texto?: string; vino?: boolean } = {};

  const repo = {
    async citasEntre() {
      return opciones.citas ?? [];
    },
    async bandeja() {
      return [];
    },
    async ficha() {
      return opciones.ficha === undefined ? ficha : opciones.ficha;
    },
    async cerrarConversacion() {
      return opciones.cierra ?? true;
    },
    async cancelarConGracia(_t: string, _c: string, graciaMs: number) {
      llamadas.gracia = graciaMs;
      return opciones.cancela ?? true;
    },
    async deshacerCancelacion() {
      return opciones.deshace ?? 'restaurada';
    },
    async buscarContactos(_t: string, texto: string) {
      llamadas.texto = texto;
      return opciones.encontrados ?? [];
    },
    async marcarAsistencia(_t: string, _c: string, vino: boolean) {
      llamadas.vino = vino;
      return opciones.marca ?? true;
    },
  } as unknown as RepoPanel;

  const deps = {
    repo,
    reloj,
    auditoria: {
      async registrar(evento: EventoAuditable) {
        registrados.push(evento);
      },
    },
  };

  return { deps, registrados, llamadas };
}

describe('hoyManana', () => {
  it('devuelve los dos días aunque estén vacíos', async () => {
    const { deps } = entorno({ citas: [] });

    const datos = await hoyManana(deps, { tenantId: TENANT, actor: ACTOR });

    // Una tabla que aparece y desaparece obliga a mirar dos veces para saber si mañana está
    // libre o si la consulta falló.
    expect(datos.dias.map((d) => d.dia)).toEqual(['2026-09-16', '2026-09-17']);
    expect(datos.dias.every((d) => d.citas.length === 0)).toBe(true);
  });

  it('reparte cada cita en su día local, no en el día UTC', async () => {
    // 2026-09-17T03:00Z son las 22:00 del 16 en Guayaquil: por UTC caería en el día
    // siguiente y el abogado vería su última cita de hoy listada para mañana.
    const tarde = cita({ id: 'tardia', iniciaAt: new Date('2026-09-17T03:00:00Z') });
    const { deps } = entorno({ citas: [cita(), tarde] });

    const datos = await hoyManana(deps, { tenantId: TENANT, actor: ACTOR });

    expect(datos.dias[0]!.citas.map((c) => c.id)).toEqual(['cita-1', 'tardia']);
    expect(datos.dias[1]!.citas).toEqual([]);
  });

  it('ver la agenda no se audita: no despliega datos de nadie en concreto', async () => {
    const { deps, registrados } = entorno({ citas: [cita()] });

    await hoyManana(deps, { tenantId: TENANT, actor: ACTOR });

    expect(registrados).toEqual([]);
  });
});

describe('verFicha', () => {
  it('deja rastro de quién la vio y de qué contacto', async () => {
    const { deps, registrados } = entorno();

    await verFicha(deps, { tenantId: TENANT, actor: ACTOR, contactoId: 'ct-1' });

    expect(registrados).toHaveLength(1);
    expect(registrados[0]).toMatchObject({
      tenantId: TENANT,
      actor: ACTOR,
      tipo: 'contacto.visto',
      entidad: 'contacto',
      entidadId: 'ct-1',
    });
  });

  it('el rastro no copia el dato: sin nombre, sin correo, sin cédula', async () => {
    const { deps, registrados } = entorno();

    await verFicha(deps, { tenantId: TENANT, actor: ACTOR, contactoId: 'ct-1' });

    // Auditar el contenido convertiría la tabla de auditoría en una segunda copia de lo que
    // protege, y encima en una que nadie borra.
    const texto = JSON.stringify(registrados[0]);
    expect(texto).not.toContain('Ana');
    expect(texto).not.toContain('0102030405');
    expect(texto).not.toContain('ejemplo.ec');
  });

  it('un contacto que no existe no genera evento', async () => {
    const { deps, registrados } = entorno({ ficha: null });

    expect(await verFicha(deps, { tenantId: TENANT, actor: ACTOR, contactoId: 'ct-9' })).toBeNull();
    // Si no, probar identificadores al azar llenaría la auditoría de ruido.
    expect(registrados).toEqual([]);
  });
});

describe('cancelar con deshacer', () => {
  it('cancela con diez segundos de gracia y lo audita', async () => {
    const { deps, registrados, llamadas } = entorno();

    expect(await cancelarDesdePanel(deps, { tenantId: TENANT, actor: ACTOR, citaId: 'cita-1' })).toBe(true);

    expect(llamadas.gracia).toBe(GRACIA_MS);
    expect(GRACIA_MS).toBe(10_000);
    expect(registrados[0]).toMatchObject({ tipo: 'cita.cancelada', entidadId: 'cita-1' });
  });

  it('cancelar lo que ya no estaba activo no audita nada', async () => {
    const { deps, registrados } = entorno({ cancela: false });

    expect(await cancelarDesdePanel(deps, { tenantId: TENANT, actor: ACTOR, citaId: 'cita-1' })).toBe(false);
    expect(registrados).toEqual([]);
  });

  it('el deshacer que funciona queda registrado', async () => {
    const { deps, registrados } = entorno({ deshace: 'restaurada' });

    expect(await deshacerCancelacion(deps, { tenantId: TENANT, actor: ACTOR, citaId: 'cita-1' })).toBe(
      'restaurada',
    );
    expect(registrados[0]).toMatchObject({ tipo: 'cita.restaurada' });
  });

  it('el deshacer que llega tarde o pierde el horario no inventa un evento', async () => {
    for (const resultado of ['plazo', 'ocupado'] as const) {
      const { deps, registrados } = entorno({ deshace: resultado });

      expect(
        await deshacerCancelacion(deps, { tenantId: TENANT, actor: ACTOR, citaId: 'cita-1' }),
      ).toBe(resultado);
      expect(registrados).toEqual([]);
    }
  });
});

describe('cerrarConversacion', () => {
  it('cerrar una de la bandeja deja rastro', async () => {
    const { deps, registrados } = entorno();

    await cerrarConversacion(deps, { tenantId: TENANT, actor: ACTOR, conversacionId: 'cv-1' });

    expect(registrados[0]).toMatchObject({ tipo: 'conversacion.cerrada', entidadId: 'cv-1' });
  });

  it('cerrar la que ya estaba cerrada no duplica el rastro', async () => {
    const { deps, registrados } = entorno({ cierra: false });

    expect(
      await cerrarConversacion(deps, { tenantId: TENANT, actor: ACTOR, conversacionId: 'cv-1' }),
    ).toBe(false);
    expect(registrados).toEqual([]);
  });
});

describe('buscarContactos', () => {
  const uno = { id: 'ct-1', nombre: 'Ana Pérez', waId: '593990000000', proximaCitaAt: null };

  it('con una sola letra no busca: devolvería medio despacho', async () => {
    const { deps, llamadas } = entorno({ encontrados: [uno] });

    expect(await buscarContactos(deps, { tenantId: TENANT, actor: ACTOR, texto: 'a' })).toEqual([]);
    expect(MINIMO_BUSQUEDA).toBe(2);
    expect(llamadas.texto).toBeUndefined();
  });

  it('recorta los espacios antes de decidir si hay texto', async () => {
    const { deps, llamadas } = entorno({ encontrados: [uno] });

    await buscarContactos(deps, { tenantId: TENANT, actor: ACTOR, texto: '   ' });

    expect(llamadas.texto).toBeUndefined();
  });

  it('una búsqueda con resultados se audita: expuso nombres', async () => {
    const { deps, registrados } = entorno({ encontrados: [uno] });

    await buscarContactos(deps, { tenantId: TENANT, actor: ACTOR, texto: 'Pérez' });

    expect(registrados[0]).toMatchObject({ tipo: 'contactos.buscados' });
    expect(registrados[0]!.payload).toEqual({ resultados: 1 });
  });

  it('el rastro NO guarda lo tecleado: suele ser el nombre de una persona', async () => {
    const { deps, registrados } = entorno({ encontrados: [uno] });

    await buscarContactos(deps, { tenantId: TENANT, actor: ACTOR, texto: 'Ana Pérez' });

    expect(JSON.stringify(registrados[0])).not.toContain('Ana');
  });

  it('una búsqueda sin resultados no expuso a nadie y no deja rastro', async () => {
    const { deps, registrados } = entorno({ encontrados: [] });

    await buscarContactos(deps, { tenantId: TENANT, actor: ACTOR, texto: 'Zutano' });

    // Si no, cada tecla pulsada llenaría la auditoría de ruido.
    expect(registrados).toEqual([]);
  });
});

describe('marcarAsistencia', () => {
  it('registra que vino', async () => {
    const { deps, registrados, llamadas } = entorno();

    expect(
      await marcarAsistencia(deps, { tenantId: TENANT, actor: ACTOR, citaId: 'cita-1', vino: true }),
    ).toBe(true);
    expect(llamadas.vino).toBe(true);
    expect(registrados[0]).toMatchObject({ tipo: 'cita.atendida', entidadId: 'cita-1' });
  });

  it('registra que faltó, que es la mitad que sostiene la tasa de ausencias', async () => {
    const { deps, registrados } = entorno();

    await marcarAsistencia(deps, { tenantId: TENANT, actor: ACTOR, citaId: 'cita-1', vino: false });

    expect(registrados[0]).toMatchObject({ tipo: 'cita.ausente' });
  });

  it('una cita que no se puede marcar no inventa un evento', async () => {
    const { deps, registrados } = entorno({ marca: false });

    expect(
      await marcarAsistencia(deps, { tenantId: TENANT, actor: ACTOR, citaId: 'cita-1', vino: true }),
    ).toBe(false);
    expect(registrados).toEqual([]);
  });
});
