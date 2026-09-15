/**
 * Relay del outbox (D9).
 *
 * Todo efecto externo se escribió en `outbox` dentro de la misma transacción que el cambio
 * de negocio. Esto lo publica: **la cita ya existe pase lo que pase con Google**, y si
 * Google está caído el relay reintenta sin bloquear nada.
 *
 * La entrega es *at-least-once* —un proceso que muere a mitad deja el trabajo arrendado y
 * alguien lo vuelve a tomar—, así que cada manejador tiene que ser idempotente. No es una
 * aspiración: es el contrato.
 */
import type { RepoOutbox, TrabajoOutbox } from './puertos/RepoOutbox.ts';

/** Tras estos intentos se deja de reintentar y el estudio tiene que enterarse (§9). */
export const MAX_INTENTOS = 5;

const MINUTO_MS = 60_000;
/** Tope de espera: más allá, reintentar cada media hora ya es «cuando vuelva». */
const ESPERA_MAXIMA_MS = 30 * MINUTO_MS;

/**
 * Espera antes del reintento número `intentos`: 1, 2, 4, 8, 16 minutos, con tope.
 *
 * El jitter no es decorativo. Si Google se cae y vuelve, sin él todos los trabajos
 * reintentarían en el mismo instante y le devolverían la caída.
 */
export function esperaMs(intentos: number, aleatorio: () => number = Math.random): number {
  const base = Math.min(2 ** Math.max(0, intentos - 1) * MINUTO_MS, ESPERA_MAXIMA_MS);
  return Math.round(base * (0.9 + aleatorio() * 0.2));
}

/**
 * Fallo que no mejora reintentando: la cita ya no existe, el evento ya estaba borrado, el
 * tipo de trabajo no lo conoce nadie. Se archiva en el primer intento en vez de gastar
 * cinco y media hora.
 */
export class FalloPermanente extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'FalloPermanente';
  }
}

export type ManejadorOutbox = (trabajo: TrabajoOutbox) => Promise<void>;

export interface Registro {
  warn(datos: object, mensaje: string): void;
  error(datos: object, mensaje: string): void;
}

export interface DependenciasRelay {
  repo: RepoOutbox;
  manejadores: Readonly<Record<string, ManejadorOutbox>>;
  registro: Registro;
  /** Trabajos por despacho y pasada. */
  lote?: number;
  /** Despachos por pasada. */
  maxTenants?: number;
  aleatorio?: () => number;
}

export interface ResumenRelay {
  publicados: number;
  fallidos: number;
  archivados: number;
}

/**
 * El error que se guarda **no** puede llevar PII: el cuerpo de una respuesta de Google
 * puede traer el nombre del contacto o el título de la cita. Solo el nombre del error y su
 * mensaje, recortado.
 */
function resumirError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return `desconocido: ${typeof error}`;
}

export async function relayOutbox(deps: DependenciasRelay): Promise<ResumenRelay> {
  const lote = deps.lote ?? 20;
  const resumen: ResumenRelay = { publicados: 0, fallidos: 0, archivados: 0 };

  const tenants = await deps.repo.tenantsConPendientes(deps.maxTenants ?? 50);

  for (const tenantId of tenants) {
    const trabajos = await deps.repo.reclamar(tenantId, lote);

    for (const trabajo of trabajos) {
      const manejador = deps.manejadores[trabajo.tipo];

      if (manejador === undefined) {
        // Un tipo desconocido no se vuelve conocido reintentando.
        await deps.repo.archivar(tenantId, trabajo.id, `tipo desconocido: ${trabajo.tipo}`);
        deps.registro.error({ tenantId, tipo: trabajo.tipo }, 'trabajo de outbox sin manejador');
        resumen.archivados++;
        continue;
      }

      try {
        await manejador(trabajo);
        await deps.repo.marcarPublicado(tenantId, trabajo.id);
        resumen.publicados++;
      } catch (error) {
        const motivo = resumirError(error);
        const agotado = trabajo.intentos >= MAX_INTENTOS;

        if (error instanceof FalloPermanente || agotado) {
          await deps.repo.archivar(tenantId, trabajo.id, motivo);
          resumen.archivados++;
          // Nivel error a propósito: esto es lo que tiene que llegar al estudio (§9).
          deps.registro.error(
            { tenantId, tipo: trabajo.tipo, intentos: trabajo.intentos, motivo },
            'efecto externo abandonado tras agotar los reintentos',
          );
          continue;
        }

        await deps.repo.marcarFallido(
          tenantId,
          trabajo.id,
          esperaMs(trabajo.intentos, deps.aleatorio),
          motivo,
        );
        resumen.fallidos++;
        deps.registro.warn(
          { tenantId, tipo: trabajo.tipo, intentos: trabajo.intentos, motivo },
          'efecto externo falló; se reintentará',
        );
      }
    }
  }

  return resumen;
}
