/**
 * Las métricas de producto de §9, calculadas sobre lo que el sistema ya guarda.
 *
 * Dos decisiones que no son de estilo:
 *
 *  - **Los porcentajes no se calculan cuando la muestra es ridícula.** Con siete
 *    conversaciones, «43% de finalización» es tres citas: un número que suena a dato y es
 *    ruido. Se devuelve `null` y la pantalla dice «aún no hay suficientes datos», que es la
 *    verdad.
 *  - **Las citas pasadas sin marcar se cuentan y se enseñan.** La tasa de ausencias solo
 *    vale sobre lo que alguien marcó; si la mitad de las citas de la semana no se tocaron,
 *    el número que sale es una opinión sobre la otra mitad. Esconder eso es cómo una
 *    métrica pasa de útil a engañosa sin que nadie lo note.
 */
import type { Metricas, RepoMetricas } from './puertos/RepoMetricas.ts';
import type { Reloj } from './puertos/Reloj.ts';

/** Por debajo de esto no se dan porcentajes: son anécdotas con un signo de porcentaje. */
export const MINIMO_MUESTRA = 20;

const DIA_MS = 86_400_000;

export interface DependenciasMetricas {
  repo: RepoMetricas;
  reloj: Reloj;
}

export interface Porcentajes {
  /** Conversaciones que acabaron en cita, de cada 100. `null` si la muestra es pequeña. */
  citasPorCien: number | null;
  derivacionesPorCien: number | null;
  /** De las citas marcadas, cuántas faltaron. `null` si se marcaron pocas. */
  ausenciasPorCien: number | null;
}

export interface Informe extends Metricas {
  desde: string;
  hasta: string;
  porcentajes: Porcentajes;
  /** Lo que el informe no puede afirmar todavía, y por qué. */
  advertencias: string[];
}

function porcentaje(parte: number, total: number): number | null {
  if (total < MINIMO_MUESTRA) return null;
  return Math.round((parte / total) * 1000) / 10;
}

export async function informeDelPeriodo(
  deps: DependenciasMetricas,
  tenantId: string,
  dias = 30,
): Promise<Informe> {
  const hastaMs = deps.reloj.ahoraMs();
  const desdeMs = hastaMs - dias * DIA_MS;

  const datos = await deps.repo.resumen(tenantId, desdeMs, hastaMs);

  const advertencias: string[] = [];
  if (datos.conversaciones < MINIMO_MUESTRA) {
    advertencias.push(
      `Solo ${datos.conversaciones} conversaciones en el periodo: los porcentajes no dicen nada todavía.`,
    );
  }
  if (datos.citasSinMarcar > 0) {
    // Sin esto, la tasa de ausencias sería una opinión sobre la mitad que sí se marcó.
    advertencias.push(
      `${datos.citasSinMarcar} cita(s) ya pasadas sin marcar como atendidas ni ausentes.`,
    );
  }

  return {
    ...datos,
    desde: deps.reloj.diaLocal(desdeMs),
    hasta: deps.reloj.diaLocal(hastaMs),
    porcentajes: {
      citasPorCien: porcentaje(datos.conCita, datos.conversaciones),
      derivacionesPorCien: porcentaje(datos.derivadas, datos.conversaciones),
      ausenciasPorCien: porcentaje(datos.citasAusentes, datos.citasMarcadas),
    },
    advertencias,
  };
}
