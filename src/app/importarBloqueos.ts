/**
 * Trae de Google lo que ocupa la agenda del abogado fuera del bot.
 *
 * Sin esto, el bot ofrecería como libre el horario en el que el abogado tiene una audiencia
 * apuntada en su calendario personal. Es la otra mitad de que Google sea un espejo: se
 * escribe lo que el bot reserva, y se lee lo que el abogado apunta por su cuenta.
 */
import type { Politica } from '../domain/agenda/politicas.ts';
import type { CalendarioDe } from './puertos/Calendario.ts';
import type { Reloj } from './puertos/Reloj.ts';
import type { RepoBloqueos } from './puertos/RepoBloqueos.ts';

export interface DependenciasImportar {
  repo: RepoBloqueos;
  calendarioDe: CalendarioDe;
  reloj: Reloj;
  politica: Politica;
  registro: { warn(datos: object, mensaje: string): void };
}

export interface ResumenImportacion {
  abogados: number;
  bloqueos: number;
}

const MS_POR_DIA = 86_400_000;

export async function importarBloqueos(
  deps: DependenciasImportar,
  tenantId: string,
): Promise<ResumenImportacion> {
  const abogados = await deps.repo.conCalendario(tenantId);
  const desdeMs = deps.reloj.ahoraMs();
  const hastaMs = desdeMs + deps.politica.horizonteDias * MS_POR_DIA;

  const resumen: ResumenImportacion = { abogados: 0, bloqueos: 0 };

  for (const abogado of abogados) {
    const calendario = await deps.calendarioDe(tenantId, abogado.id);
    if (calendario === null) continue;

    try {
      const ocupados = await calendario.ocupados(desdeMs, hastaMs);
      resumen.bloqueos += await deps.repo.reemplazarDeGoogle(
        tenantId,
        abogado.id,
        desdeMs,
        hastaMs,
        ocupados,
      );
      resumen.abogados++;
    } catch (error) {
      /**
       * Un abogado cuyo Google falle no puede dejar sin sincronizar a los demás, y tampoco
       * puede vaciar sus bloqueos: sin respuesta se conservan los que ya había, porque
       * ofrecer como libre un horario ocupado es peor que ofrecer de menos.
       */
      deps.registro.warn(
        { tenantId, abogadoId: abogado.id, err: error instanceof Error ? error.name : 'desconocido' },
        'no se pudieron importar los bloqueos de un abogado',
      );
    }
  }

  return resumen;
}
