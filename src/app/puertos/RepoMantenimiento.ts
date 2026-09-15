export interface ResumenRetencion {
  mensajesBorrados: number;
  contactosAnonimizados: number;
}

export interface RepoMantenimiento {
  /**
   * Borra los mensajes anteriores a la fecha. Su `payload` guarda consultas jurídicas: no
   * conservarlas más de lo necesario es parte del cumplimiento, no una limpieza de disco.
   */
  borrarMensajesAntiguos(tenantId: string, antesDeMs: number): Promise<number>;

  /**
   * Anonimiza contactos sin actividad. Borra nombre, correo y cédula dejando la fila: las
   * citas pasadas siguen contando para las métricas del estudio, pero ya no están
   * asociadas a una persona identificable.
   */
  anonimizarContactosInactivos(tenantId: string, antesDeMs: number): Promise<number>;

  /** Claves de audio cuyo `media_id` conviene renovar. */
  audiosParaRefrescar(tenantId: string, antesDeMs: number): Promise<string[]>;
}
