export interface TrabajoOutbox {
  id: string;
  tenantId: string;
  tipo: string;
  payload: unknown;
  idempotencyKey: string;
  /** Intentos consumidos, ya contando el actual. */
  intentos: number;
}

export interface RepoOutbox {
  /**
   * Despachos con trabajos pendientes. El relay tiene que recorrerlos uno a uno: `outbox`
   * está bajo RLS, así que no existe una consulta que los vea todos a la vez. `tenants` sí
   * es legible sin tenant fijado, y por eso no guarda secretos.
   */
  tenantsConPendientes(limite: number): Promise<string[]>;

  /**
   * Reclama hasta `limite` trabajos vencidos del despacho y los arrienda: marca un próximo
   * intento en el futuro para que ningún otro relay los tome mientras se ejecutan.
   *
   * El arrendamiento es lo que permite **no** mantener abierta la transacción durante la
   * llamada de red. Si el proceso muere a mitad, el arriendo vence y el trabajo se reintenta:
   * la entrega es *at-least-once* y por eso cada efecto tiene que tolerar ejecutarse dos veces.
   */
  reclamar(tenantId: string, limite: number): Promise<TrabajoOutbox[]>;

  marcarPublicado(tenantId: string, id: string): Promise<void>;

  /** Programa el reintento. `error` se guarda ya redactado: puede traer PII. */
  marcarFallido(tenantId: string, id: string, esperaMs: number, error: string): Promise<void>;

  /** Deja de reintentar: el fallo no mejora repitiendo. */
  archivar(tenantId: string, id: string, error: string): Promise<void>;
}
