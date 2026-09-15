/**
 * Recordatorio de la cita del día siguiente, con botones (§8).
 *
 * Reduce las ausencias, y la tasa de ausencias es la métrica que el estudio va a mirar para
 * decidir si renueva. Por eso lleva *Confirmar* / *Cancelar* / *Reagendar*: quien no puede
 * venir avisa en vez de no presentarse, y ese hueco vuelve a la agenda.
 *
 * El envío **no** se hace aquí: se encola en `outbox`. Así el recordatorio hereda la
 * idempotencia por clave, el backoff y los reintentos del relay, y existe un solo camino
 * para todo lo que sale del sistema.
 */
import type { RepoOutbox } from './puertos/RepoOutbox.ts';
import type { Reloj } from './puertos/Reloj.ts';

export interface CitaRecordable {
  id: string;
}

export interface RepoRecordatorios {
  /** Citas vigentes que empiezan dentro de la ventana. */
  citasEntre(tenantId: string, desdeMs: number, hastaMs: number): Promise<CitaRecordable[]>;
}

export interface DependenciasRecordatorios {
  repo: RepoRecordatorios;
  outbox: RepoOutbox;
  reloj: Reloj;
}

export const CLAVE_RECORDATORIO = 'recordatorio';

export async function enviarRecordatorios(
  deps: DependenciasRecordatorios,
  tenantId: string,
): Promise<number> {
  // El día siguiente en hora local, no «dentro de 24 horas»: el estudio piensa en días.
  const dias = deps.reloj.diasDesdeHoy(2);
  const manana = dias[1];
  if (manana === undefined) return 0;

  const desdeMs = deps.reloj.instanteLocal(manana, 0);
  const hastaMs = deps.reloj.instanteLocal(manana, 24 * 60);

  const citas = await deps.repo.citasEntre(tenantId, desdeMs, hastaMs);

  let encolados = 0;
  for (const cita of citas) {
    // Correr el trabajo dos veces el mismo día no manda dos recordatorios: la clave ya está.
    const nuevo = await deps.outbox.encolar(
      tenantId,
      'wa.recordatorio',
      { citaId: cita.id },
      `${CLAVE_RECORDATORIO}:${cita.id}`,
    );
    if (nuevo) encolados++;
  }
  return encolados;
}
