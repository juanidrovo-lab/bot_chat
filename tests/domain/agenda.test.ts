import { describe, expect, it } from 'vitest';
import { disponibles, diasConCupo, slotsDelDia } from '../../src/domain/agenda/disponibilidad.ts';
import { generarCandidatos } from '../../src/domain/agenda/horarios.ts';
import { idDeSlot, leerIdDeSlot, type Ocupado, type Ventana } from '../../src/domain/agenda/Slot.ts';
import { minutosDeHora, pasoMin, POLITICA, tramosDelDia } from '../../src/domain/agenda/politicas.ts';

const MIN = 60_000;
/** Base arbitraria: el dominio solo hace aritmética, la fecha real da igual. */
const BASE = Date.UTC(2026, 9, 20, 0, 0, 0);
const enT = (minutos: number) => BASE + minutos * MIN;

function ventana(abogadoId: string, desdeMin: number, hastaMin: number, dia = '2026-10-20'): Ventana {
  return { abogadoId, dia, inicioMs: enT(desdeMin), finMs: enT(hastaMin) };
}

function ocupado(abogadoId: string, desdeMin: number, hastaMin: number): Ocupado {
  return { abogadoId, inicioMs: enT(desdeMin), finMs: enT(hastaMin) };
}

const minutosDe = (ms: number) => (ms - BASE) / MIN;

describe('políticas', () => {
  it('el paso efectivo es duración más buffer: los inicios caen en punto', () => {
    expect(POLITICA.duracionMin).toBe(45);
    expect(POLITICA.bufferMin).toBe(15);
    expect(pasoMin(POLITICA)).toBe(60);
  });

  it('lee las horas del horario y rechaza la basura en vez de producir NaN', () => {
    expect(minutosDeHora('09:00')).toBe(540);
    expect(minutosDeHora('9:30')).toBe(570);
    expect(minutosDeHora('23:59')).toBe(1439);
    for (const mala of ['', '24:00', '09:60', 'nueve', '09-00', '0900']) {
      expect(minutosDeHora(mala), `«${mala}» debería rechazarse`).toBeNull();
    }
  });

  it('descarta tramos invertidos o vacíos del horario de un despacho', () => {
    const horario = {
      '1': [{ desdeMin: 540, hastaMin: 780 }, { desdeMin: 900, hastaMin: 900 }, { desdeMin: 1000, hastaMin: 800 }],
    };
    expect(tramosDelDia(horario, 1)).toEqual([{ desdeMin: 540, hastaMin: 780 }]);
    expect(tramosDelDia(horario, 3)).toEqual([]);
  });
});

describe('generación de candidatos', () => {
  it('reparte la ventana en la rejilla de una hora', () => {
    // 09:00 a 13:00 son 240 minutos: caben inicios a las 9, 10, 11 y 12.
    const slots = generarCandidatos([ventana('a', 540, 780)], POLITICA);
    expect(slots.map((s) => minutosDe(s.inicioMs))).toEqual([540, 600, 660, 720]);
    expect(minutosDe(slots[0]!.finMs)).toBe(585);
  });

  it('nunca ofrece un hueco que se sale de la ventana', () => {
    // 50 minutos de ventana: la consulta dura 45, pero el último inicio posible es el 0.
    expect(generarCandidatos([ventana('a', 540, 590)], POLITICA)).toHaveLength(1);
    // 44 minutos: no cabe ninguna.
    expect(generarCandidatos([ventana('a', 540, 584)], POLITICA)).toHaveLength(0);
  });

  it('une varias ventanas y varios abogados en un solo orden cronológico', () => {
    const slots = generarCandidatos(
      [ventana('b', 900, 1020), ventana('a', 540, 660)],
      POLITICA,
    );
    expect(slots.map((s) => minutosDe(s.inicioMs))).toEqual([540, 600, 900, 960]);
    expect(slots.map((s) => s.abogadoId)).toEqual(['a', 'a', 'b', 'b']);
  });
});

describe('disponibilidad', () => {
  const candidatos = generarCandidatos([ventana('a', 540, 1020)], POLITICA);
  const ahora = enT(0);

  it('una cita ocupa su hueco', () => {
    const libres = disponibles(candidatos, [ocupado('a', 600, 645)], ahora, POLITICA);
    expect(libres.map((s) => minutosDe(s.inicioMs))).not.toContain(600);
    expect(libres.map((s) => minutosDe(s.inicioMs))).toContain(540);
  });

  it('un bloqueo elimina el slot igual que una cita', () => {
    // Aceptación (b): los bloqueos importados de Google entran por la misma puerta.
    const manana = disponibles(candidatos, [ocupado('a', 540, 720)], ahora, POLITICA);
    expect(manana.map((s) => minutosDe(s.inicioMs))).toEqual([780, 840, 900, 960]);
  });

  it('el buffer protege una cita que no está en la rejilla', () => {
    // Cita de 14:30 a 15:15 con 15 de buffer: tapa los candidatos de 14:00 y de 15:00.
    const libres = disponibles(candidatos, [ocupado('a', 870, 915)], ahora, POLITICA);
    const inicios = libres.map((s) => minutosDe(s.inicioMs));
    expect(inicios).not.toContain(840);
    expect(inicios).not.toContain(900);
    expect(inicios).toContain(960);
  });

  it('pero el buffer no se come el candidato siguiente de la propia rejilla', () => {
    // Una cita en rejilla (600–645) más 15 de buffer llega justo a 660, que sigue libre.
    const libres = disponibles(candidatos, [ocupado('a', 600, 645)], ahora, POLITICA);
    expect(libres.map((s) => minutosDe(s.inicioMs))).toContain(660);
  });

  it('lo ocupado de un abogado no tapa los huecos de otro', () => {
    const dos = generarCandidatos([ventana('a', 540, 660), ventana('b', 540, 660)], POLITICA);
    const libres = disponibles(dos, [ocupado('a', 540, 585)], ahora, POLITICA);
    expect(libres.filter((s) => s.abogadoId === 'b')).toHaveLength(2);
    expect(libres.filter((s) => s.abogadoId === 'a')).toHaveLength(1);
  });

  it('respeta la antelación mínima: nadie reserva para dentro de diez minutos', () => {
    // A las 09:10 locales, con 3 h de antelación, el primer hueco posible es el de 13:00.
    const libres = disponibles(candidatos, [], enT(550), POLITICA);
    expect(minutosDe(libres[0]!.inicioMs)).toBe(780);
  });

  it('sin nada ocupado devuelve todos los candidatos', () => {
    expect(disponibles(candidatos, [], ahora, POLITICA)).toHaveLength(candidatos.length);
  });
});

describe('agrupación para las listas de WhatsApp', () => {
  const slots = [
    ...generarCandidatos([ventana('a', 540, 780, '2026-10-20')], POLITICA),
    ...generarCandidatos([ventana('a', 540, 780, '2026-10-21')], POLITICA),
    ...generarCandidatos([ventana('b', 540, 600, '2026-10-20')], POLITICA),
  ].sort((x, y) => x.inicioMs - y.inicioMs);

  it('los días no pasan del tope de filas de una lista', () => {
    const muchos = Array.from({ length: 30 }, (_, i) =>
      generarCandidatos([ventana('a', 540, 600, `2026-11-${String(i + 1).padStart(2, '0')}`)], POLITICA),
    ).flat();
    expect(diasConCupo(muchos, POLITICA)).toHaveLength(POLITICA.maxOpciones);
  });

  it('un día sin huecos no aparece en la lista de días', () => {
    expect(diasConCupo(slots, POLITICA)).toEqual(['2026-10-20', '2026-10-21']);
  });

  it('dos abogados libres a la misma hora dan una sola fila', () => {
    // Al usuario se le pide un horario, no que elija abogado.
    const delDia = slotsDelDia(slots, '2026-10-20', POLITICA);
    const inicios = delDia.map((s) => s.inicioMs);
    expect(new Set(inicios).size).toBe(inicios.length);
    expect(delDia).toHaveLength(4);
  });

  it('las horas de un día tampoco pasan del tope', () => {
    const largo = generarCandidatos([ventana('a', 0, 1440, '2026-10-22')], POLITICA);
    expect(largo.length).toBeGreaterThan(POLITICA.maxOpciones);
    expect(slotsDelDia(largo, '2026-10-22', POLITICA)).toHaveLength(POLITICA.maxOpciones);
  });
});

describe('identificador opaco del slot', () => {
  it('va y vuelve', () => {
    const slot = { abogadoId: 'ab-1', dia: '2026-10-20', inicioMs: enT(540), finMs: enT(585) };
    expect(leerIdDeSlot(idDeSlot(slot))).toEqual({ abogadoId: 'ab-1', inicioMs: enT(540) });
  });

  it('aguanta un uuid con guiones y rechaza lo que no entiende', () => {
    const id = idDeSlot({ abogadoId: '0b7c-4d', dia: 'x', inicioMs: 123, finMs: 456 });
    expect(leerIdDeSlot(id)).toEqual({ abogadoId: '0b7c-4d', inicioMs: 123 });
    for (const malo of ['', 'sin-arroba', '@123', 'a@', 'a@no-es-numero', 'a@1.5']) {
      expect(leerIdDeSlot(malo), `«${malo}»`).toBeNull();
    }
  });
});
