/**
 * Las dos alertas de negocio de §9.
 *
 * La del silencio es la que importa de verdad: es el único fallo que deja todas las
 * métricas en verde. Un bot que no recibe nada no falla nunca.
 */
import { describe, expect, it } from 'vitest';
import { crearReloj } from '../../src/adapters/reloj.ts';
import {
  MINIMO_ENVIOS,
  MINIMO_PROMEDIO_DIARIO,
  UMBRAL_ERROR,
  revisarAlertas,
} from '../../src/app/alertas.ts';
import type { EntrantesDelDia, RepoAlertas } from '../../src/app/puertos/RepoAlertas.ts';

const TENANT = 'despacho-a';
/** Miércoles 16 de septiembre de 2026, 14:00 en Guayaquil. */
const AHORA = Date.parse('2026-09-16T19:00:00Z');
const HOY = '2026-09-16';
const reloj = crearReloj(() => AHORA);

function repo(opciones: {
  total?: number;
  fallidos?: number;
  historia?: EntrantesDelDia[];
}): RepoAlertas {
  return {
    async enviosRecientes() {
      return { total: opciones.total ?? 0, fallidos: opciones.fallidos ?? 0 };
    },
    async entrantesPorDia() {
      return opciones.historia ?? [];
    },
  };
}

const dias = (totales: readonly number[]): EntrantesDelDia[] =>
  totales.map((total, i) => ({ dia: `2026-09-${String(9 + i).padStart(2, '0')}`, total }));

describe('tasa de error de WhatsApp', () => {
  it('avisa por encima del 5%', async () => {
    const alertas = await revisarAlertas(
      { repo: repo({ total: 100, fallidos: 9 }), reloj },
      TENANT,
    );

    expect(alertas.map((a) => a.tipo)).toEqual(['whatsapp_errores']);
    expect(alertas[0]!.detalle['tasa']).toBeCloseTo(0.09);
  });

  it('no avisa justo en el umbral', async () => {
    const alertas = await revisarAlertas({ repo: repo({ total: 100, fallidos: 5 }), reloj }, TENANT);

    expect(UMBRAL_ERROR).toBe(0.05);
    expect(alertas).toEqual([]);
  });

  it('con pocos envíos no dice nada: un fallo de tres no es una tasa', async () => {
    // Con cinco envíos, uno fallido son veinte puntos. Alertar por eso enseña al estudio a
    // ignorar las alertas, que es como se pierde la que sí importaba.
    const alertas = await revisarAlertas({ repo: repo({ total: 5, fallidos: 1 }), reloj }, TENANT);

    expect(MINIMO_ENVIOS).toBeGreaterThan(5);
    expect(alertas).toEqual([]);
  });
});

describe('silencio anómalo', () => {
  it('avisa cuando hoy no llegó nada y los días anteriores sí', async () => {
    const alertas = await revisarAlertas(
      { repo: repo({ historia: [...dias([12, 9, 15, 11]), { dia: HOY, total: 0 }] }), reloj },
      TENANT,
    );

    expect(alertas.map((a) => a.tipo)).toEqual(['silencio_anomalo']);
  });

  it('un día sin entrantes que ni siquiera aparece en la historia cuenta igual', async () => {
    // Es el caso real: si no llegó nada, no hay filas de hoy que agrupar.
    const alertas = await revisarAlertas({ repo: repo({ historia: dias([12, 9, 15]) }), reloj }, TENANT);

    expect(alertas.map((a) => a.tipo)).toEqual(['silencio_anomalo']);
  });

  it('no avisa si hoy sí llegó algo', async () => {
    const alertas = await revisarAlertas(
      { repo: repo({ historia: [...dias([12, 9]), { dia: HOY, total: 1 }] }), reloj },
      TENANT,
    );

    expect(alertas).toEqual([]);
  });

  it('un despacho que casi no recibe mensajes no dispara la alerta cada noche', async () => {
    const alertas = await revisarAlertas({ repo: repo({ historia: dias([1, 0, 0, 0]) }), reloj }, TENANT);

    expect(MINIMO_PROMEDIO_DIARIO).toBeGreaterThan(0);
    expect(alertas).toEqual([]);
  });

  it('un despacho recién dado de alta, sin historia, no alerta', async () => {
    const alertas = await revisarAlertas({ repo: repo({ historia: [] }), reloj }, TENANT);

    expect(alertas).toEqual([]);
  });
});

describe('las dos a la vez', () => {
  it('se devuelven ambas: no se pisan', async () => {
    const alertas = await revisarAlertas(
      { repo: repo({ total: 50, fallidos: 20, historia: dias([10, 10, 10]) }), reloj },
      TENANT,
    );

    expect(alertas.map((a) => a.tipo).sort()).toEqual(['silencio_anomalo', 'whatsapp_errores']);
  });
});
