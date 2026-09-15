/**
 * La sonda de salud.
 *
 * Cada comprobación va con su propio límite de tiempo: una consulta colgada contra una base
 * saturada dejaría la petición esperando para siempre, y un balanceador que no obtiene
 * respuesta no sabe distinguir «tarda» de «cayó» — acaba sacando de rotación al proceso
 * sano y dejando el roto.
 */
import type { Sonda } from './puertos/Salud.ts';

export const LIMITE_MS = 2_000;

export interface Resultado {
  ok: boolean;
  comprobaciones: { nombre: string; ok: boolean; motivo?: string; ms: number }[];
}

async function conLimite(promesa: Promise<void>, ms: number): Promise<void> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promesa,
      new Promise<never>((_, rechazar) => {
        temporizador = setTimeout(() => rechazar(new Error(`no respondió en ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (temporizador !== undefined) clearTimeout(temporizador);
  }
}

export async function comprobarSalud(
  sondas: readonly Sonda[],
  limiteMs = LIMITE_MS,
  ahora: () => number = Date.now,
): Promise<Resultado> {
  // En paralelo: en serie, tres sondas lentas suman sus límites y la respuesta tarda seis
  // segundos en decir que algo va mal.
  const comprobaciones = await Promise.all(
    sondas.map(async (sonda) => {
      const inicio = ahora();
      try {
        await conLimite(sonda.comprobar(), limiteMs);
        return { nombre: sonda.nombre, ok: true, ms: ahora() - inicio };
      } catch (error) {
        // Solo el mensaje, nunca el error entero: una excepción de Postgres puede traer
        // los parámetros de la consulta, y ahí va el texto de una consulta jurídica.
        const motivo = error instanceof Error ? error.message.slice(0, 120) : 'desconocido';
        return { nombre: sonda.nombre, ok: false, motivo, ms: ahora() - inicio };
      }
    }),
  );

  return { ok: comprobaciones.every((c) => c.ok), comprobaciones };
}
