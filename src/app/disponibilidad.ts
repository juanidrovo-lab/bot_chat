import { disponibles } from '../domain/agenda/disponibilidad.ts';
import { generarCandidatos } from '../domain/agenda/horarios.ts';
import type { Slot, Ventana } from '../domain/agenda/Slot.ts';
import { tramosDelDia, type Politica } from '../domain/agenda/politicas.ts';
import type { Reloj } from './puertos/Reloj.ts';
import type { RepoCitas } from './puertos/RepoCitas.ts';

export interface DependenciasAgenda {
  repo: RepoCitas;
  reloj: Reloj;
  politica: Politica;
}

/**
 * Huecos realmente libres para una materia, en los próximos días.
 *
 * Tres consultas y ni una más: los abogados de la materia, el horario del despacho, y las
 * citas y bloqueos de la ventana entera en una sola. Todo lo demás es aritmética pura del
 * dominio, que no toca la base.
 *
 * Esta lista es informativa, no una reserva. Entre que se ofrece y el usuario elige puede
 * ocuparse, y está bien: la exclusión la garantiza el índice único, y el guion ya sabe
 * decir «ese horario se acaba de ocupar» y volver a preguntar.
 */
export async function slotsDisponibles(
  deps: DependenciasAgenda,
  tenantId: string,
  materia: string,
): Promise<Slot[]> {
  const abogados = await deps.repo.abogadosDe(tenantId, materia);
  if (abogados.length === 0) return [];

  const horario = await deps.repo.horarioSemanal(tenantId);
  const dias = deps.reloj.diasDesdeHoy(deps.politica.horizonteDias);

  const ventanas: Ventana[] = [];
  for (const dia of dias) {
    for (const tramo of tramosDelDia(horario, deps.reloj.diaSemana(dia))) {
      const inicioMs = deps.reloj.instanteLocal(dia, tramo.desdeMin);
      const finMs = deps.reloj.instanteLocal(dia, tramo.hastaMin);
      for (const abogadoId of abogados) ventanas.push({ abogadoId, dia, inicioMs, finMs });
    }
  }

  const candidatos = generarCandidatos(ventanas, deps.politica);
  if (candidatos.length === 0) return [];

  const desdeMs = candidatos[0]!.inicioMs;
  const hastaMs = Math.max(...candidatos.map((c) => c.finMs));
  const ocupados = await deps.repo.ocupados(tenantId, abogados, desdeMs, hastaMs);

  return disponibles(candidatos, ocupados, deps.reloj.ahoraMs(), deps.politica);
}
