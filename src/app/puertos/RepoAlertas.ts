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

  /**
   * Efectos externos sin publicar con más de `minutos` de antigüedad.
   *
   * La sonda de `/health` ya mira esto, pero mirando **todos** los despachos a la vez: sirve
   * a quien vigila el servidor, no al estudio. Esta es la misma señal acotada a un despacho,
   * para poder enseñarla en su panel.
   */
  outboxAtrasada(tenantId: string, minutos: number): Promise<number>;
}
