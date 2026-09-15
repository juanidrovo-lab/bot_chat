import type { Reloj } from '../app/puertos/Reloj.ts';
import {
  desdeLocal,
  diaSemanaLocal,
  fechaLocalISO,
  formatearFechaHora,
  formatearHora,
  partesLocales,
} from '../platform/time.ts';

const MS_POR_DIA = 86_400_000;

function partesDelDia(dia: string): { anio: number; mes: number; dia: number } {
  const [anio, mes, diaMes] = dia.split('-').map(Number);
  return { anio: anio ?? 0, mes: mes ?? 1, dia: diaMes ?? 1 };
}

/** Implementación real. Es el único punto del proyecto que sabe que existe Cuenca. */
export function crearReloj(ahora: () => number = Date.now): Reloj {
  return {
    ahoraMs: ahora,

    diaLocal: (ms) => fechaLocalISO(new Date(ms)),

    instanteLocal(dia, minutosDelDia) {
      const { anio, mes, dia: diaMes } = partesDelDia(dia);
      return desdeLocal(anio, mes, diaMes, 0, minutosDelDia).getTime();
    },

    diaSemana(dia) {
      const { anio, mes, dia: diaMes } = partesDelDia(dia);
      return diaSemanaLocal(desdeLocal(anio, mes, diaMes, 12, 0));
    },

    diasDesdeHoy(n) {
      const hoy = fechaLocalISO(new Date(ahora()));
      const { anio, mes, dia } = partesDelDia(hoy);
      // Se avanza sobre el mediodía local para que sumar días nunca caiga en el borde:
      // aunque algún día Ecuador adoptara horario de verano, el mediodía sigue siendo
      // inequívoco.
      const mediodia = desdeLocal(anio, mes, dia, 12, 0).getTime();
      return Array.from({ length: n }, (_, i) => fechaLocalISO(new Date(mediodia + i * MS_POR_DIA)));
    },

    formatearFechaHora: (ms) => formatearFechaHora(new Date(ms)),
    formatearHora: (ms) => formatearHora(new Date(ms)),

    formatearDia(dia) {
      const { anio, mes, dia: diaMes } = partesDelDia(dia);
      const texto = formatearFechaHora(desdeLocal(anio, mes, diaMes, 12, 0));
      // «martes 20 de octubre, 12:00» → «martes 20 de octubre»
      return texto.slice(0, texto.lastIndexOf(','));
    },
  };
}

export function partesDe(ms: number) {
  return partesLocales(new Date(ms));
}
