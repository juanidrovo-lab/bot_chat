/**
 * Las cinco métricas de producto de §9.
 *
 * Métricas de **producto**, no de sistema: sin estas no se puede mejorar el guion ni
 * justificar la mensualidad. «El servidor estuvo al 99,9%» no le dice nada a un abogado;
 * «de cada cien conversaciones salieron dieciocho citas, y el mes pasado fueron doce» sí.
 *
 * Todas se leen de lo que el sistema ya guarda —conversaciones, citas, derivaciones—: no
 * hay una tabla de analítica aparte, que sería una segunda copia de los mismos datos con
 * una segunda forma de quedarse desincronizada.
 */
export interface AbandonoPorEstado {
  estado: string;
  total: number;
}

export interface Metricas {
  /** Conversaciones del periodo. Es el denominador de casi todo lo demás. */
  conversaciones: number;
  /** Las que llegaron a reservar. */
  conCita: number;
  /** Las que pidieron una persona o escalaron por tres fallos. */
  derivadas: number;
  /** Dónde se quedaron las que no acabaron, de mayor a menor. */
  abandono: AbandonoPorEstado[];
  /** Citas ya pasadas y marcadas: es lo que hace calculable la tasa de ausencias. */
  citasMarcadas: number;
  citasAusentes: number;
  /** Citas pasadas que nadie marcó. Si esto crece, la tasa de ausencias miente. */
  citasSinMarcar: number;
}

export interface RepoMetricas {
  /** Del periodo `[desdeMs, hastaMs)`, en instantes UTC. */
  resumen(tenantId: string, desdeMs: number, hastaMs: number): Promise<Metricas>;
}
