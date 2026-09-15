/**
 * Las cuatro alertas de §9.
 *
 * Dos de ellas —`/health` y la outbox atrasada— son sondas y viven con la salud. Las otras
 * dos son de negocio y necesitan comparar contra la historia, así que son un trabajo
 * periódico:
 *
 *  - **Tasa de error de WhatsApp por encima del 5% en 10 minutos.** Un token rotado o un
 *    número suspendido no tumban el proceso: simplemente todo empieza a fallar.
 *  - **Silencio anómalo:** cero mensajes entrantes en 24 h cuando el promedio es mayor.
 *    Este es el fallo que nadie detecta hasta que el cliente llama enojado, porque un
 *    sistema que no recibe nada tiene todas las métricas en verde.
 *
 * El transporte del aviso no está aquí: esto devuelve alertas y el arranque decide si van al
 * log, a Sentry o a un WhatsApp del estudio. Mezclar detección y envío es lo que hace que
 * después no se pueda probar ninguna de las dos.
 */
import type { RepoAlertas } from './puertos/RepoAlertas.ts';
import type { Reloj } from './puertos/Reloj.ts';

/** Por debajo de esto, un 5% es una llamada fallida de veinte: ruido, no señal. */
export const MINIMO_ENVIOS = 20;
export const UMBRAL_ERROR = 0.05;
export const VENTANA_ERROR_MIN = 10;

/** Días de historia con los que se compara el silencio. */
export const DIAS_HISTORIA = 14;
/** Por debajo de un mensaje al día de promedio, un día en blanco no significa nada. */
export const MINIMO_PROMEDIO_DIARIO = 1;

export type Severidad = 'aviso' | 'urgente';

export interface Alerta {
  tenantId: string;
  tipo: 'whatsapp_errores' | 'silencio_anomalo';
  severidad: Severidad;
  detalle: Record<string, number>;
}

export interface DependenciasAlertas {
  repo: RepoAlertas;
  reloj: Reloj;
}

export async function revisarAlertas(
  deps: DependenciasAlertas,
  tenantId: string,
): Promise<Alerta[]> {
  const alertas: Alerta[] = [];
  const ahora = deps.reloj.ahoraMs();

  const envios = await deps.repo.enviosRecientes(tenantId, VENTANA_ERROR_MIN);
  if (envios.total >= MINIMO_ENVIOS) {
    const tasa = envios.fallidos / envios.total;
    if (tasa > UMBRAL_ERROR) {
      alertas.push({
        tenantId,
        tipo: 'whatsapp_errores',
        severidad: 'urgente',
        detalle: { total: envios.total, fallidos: envios.fallidos, tasa: Number(tasa.toFixed(3)) },
      });
    }
  }

  const historia = await deps.repo.entrantesPorDia(tenantId, DIAS_HISTORIA);
  const hoy = deps.reloj.diaLocal(ahora);
  const anteriores = historia.filter((d) => d.dia !== hoy);
  const deHoy = historia.find((d) => d.dia === hoy)?.total ?? 0;

  if (anteriores.length > 0 && deHoy === 0) {
    const promedio = anteriores.reduce((suma, d) => suma + d.total, 0) / anteriores.length;
    if (promedio >= MINIMO_PROMEDIO_DIARIO) {
      alertas.push({
        tenantId,
        tipo: 'silencio_anomalo',
        severidad: 'urgente',
        detalle: { promedioDiario: Number(promedio.toFixed(2)), hoy: deHoy },
      });
    }
  }

  return alertas;
}
