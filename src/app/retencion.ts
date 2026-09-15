/**
 * Retención de datos (LOPDP).
 *
 * Dos obligaciones distintas, y conviene no confundirlas: los **mensajes** se borran porque
 * su `payload` guarda consultas jurídicas y no hay motivo para conservarlas indefinidamente;
 * los **contactos** se anonimizan, no se borran, porque sus citas pasadas siguen contando
 * para las métricas del estudio pero ya no tienen por qué estar asociadas a una persona.
 *
 * Es idempotente por construcción: borrar lo ya borrado y anonimizar lo ya anónimo no hacen
 * nada.
 */
import type { RepoMantenimiento, ResumenRetencion } from './puertos/RepoMantenimiento.ts';
import type { Reloj } from './puertos/Reloj.ts';

const DIA_MS = 86_400_000;

export const DIAS_MENSAJES = 90;
export const MESES_CONTACTOS = 12;

export interface DependenciasRetencion {
  repo: RepoMantenimiento;
  reloj: Reloj;
}

export async function aplicarRetencion(
  deps: DependenciasRetencion,
  tenantId: string,
): Promise<ResumenRetencion> {
  const ahora = deps.reloj.ahoraMs();

  return {
    mensajesBorrados: await deps.repo.borrarMensajesAntiguos(tenantId, ahora - DIAS_MENSAJES * DIA_MS),
    contactosAnonimizados: await deps.repo.anonimizarContactosInactivos(
      tenantId,
      ahora - MESES_CONTACTOS * 30 * DIA_MS,
    ),
  };
}
