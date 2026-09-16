export interface AbogadoConCalendario {
  id: string;
  nombre: string;
  /** El calendario conectado, o `null` si todavía no autorizó. */
  calendarId: string | null;
}

export interface StateConsumido {
  abogadoId: string;
}

export interface RepoCalendarios {
  /** Los abogados del despacho y qué calendario tiene conectado cada uno. */
  listar(tenantId: string): Promise<AbogadoConCalendario[]>;

  /** `null` si ese abogado no es de este despacho. */
  abogado(tenantId: string, abogadoId: string): Promise<AbogadoConCalendario | null>;

  guardarState(
    tenantId: string,
    state: string,
    abogadoId: string,
    expiraAt: Date,
  ): Promise<void>;

  /**
   * Consume el `state`: lo borra y devuelve a qué abogado pertenecía. De un solo uso y en
   * una sola sentencia, por lo mismo que el reto de WebAuthn.
   */
  consumirState(tenantId: string, state: string): Promise<StateConsumido | null>;

  /** El refresh token llega **ya cifrado**: aquí no se cifra nada. */
  guardarCalendario(
    tenantId: string,
    abogadoId: string,
    calendarId: string,
    refreshTokenCifrado: string,
  ): Promise<void>;

  olvidarCalendario(tenantId: string, abogadoId: string): Promise<void>;
}
