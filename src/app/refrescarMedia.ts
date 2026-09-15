/**
 * Renueva los `media_id` de los audios antes de que caduquen.
 *
 * Los identificadores de media de WhatsApp caducan a los 30 días. Sin esto, el bot se queda
 * sin voz un mes después del despliegue, **en silencio**: los envíos de audio empiezan a
 * fallar y nadie se entera hasta que un cliente lo comenta.
 */
import type { MediaDe } from './puertos/Media.ts';
import type { RepoMantenimiento } from './puertos/RepoMantenimiento.ts';
import type { Reloj } from './puertos/Reloj.ts';

const DIA_MS = 86_400_000;

/** Se renueva a los 25 y no a los 30: el margen cubre que el job falle unos días. */
export const DIAS_REFRESCO = 25;

export interface DependenciasMedia {
  repo: RepoMantenimiento;
  mediaDe: MediaDe;
  reloj: Reloj;
  registro: { warn(datos: object, mensaje: string): void };
}

export async function refrescarMedia(
  deps: DependenciasMedia,
  tenantId: string,
): Promise<number> {
  const claves = await deps.repo.audiosParaRefrescar(tenantId, deps.reloj.ahoraMs() - DIAS_REFRESCO * DIA_MS);
  if (claves.length === 0) return 0;

  const gestor = await deps.mediaDe(tenantId);
  if (gestor === null) return 0;

  let renovados = 0;
  for (const clave of claves) {
    try {
      await gestor.asegurarMediaFresco(tenantId, clave);
      renovados++;
    } catch (error) {
      // Un audio que falle no puede dejar sin renovar a los demás: cada uno es independiente
      // y al día siguiente se vuelve a intentar.
      deps.registro.warn(
        { tenantId, clave, err: error instanceof Error ? error.name : 'desconocido' },
        'no se pudo renovar el media_id de un audio',
      );
    }
  }
  return renovados;
}
