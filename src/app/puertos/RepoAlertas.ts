export interface ResumenEnvios {
  total: number;
  fallidos: number;
}

export interface EntrantesDelDia {
  /** Día local `YYYY-MM-DD`. */
  dia: string;
  total: number;
}

export interface RepoAlertas {
  /** Envíos salientes de los últimos `minutos`, y cuántos quedaron sin `wa_message_id`. */
  enviosRecientes(tenantId: string, minutos: number): Promise<ResumenEnvios>;

  /** Mensajes entrantes por día local, los últimos `dias`. */
  entrantesPorDia(tenantId: string, dias: number): Promise<EntrantesDelDia[]>;
}
