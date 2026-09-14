export interface OpcionClasificable {
  id: string;
  /** Cómo la reconocería una persona. Es lo que lee el modelo, no el id. */
  descripcion: string;
}

/**
 * **El modelo clasifica, no redacta** (D3).
 *
 * Recibe texto libre del usuario y devuelve **uno** de los `id` que se le pasaron, o
 * `null` si ninguno encaja. Nunca devuelve texto libre, nunca tiene herramientas y su
 * salida jamás se reenvía al usuario. Eso elimina de raíz la inyección de prompt y la
 * alucinación en el tramo crítico: lo peor que puede hacer un atacante es conseguir que se
 * elija la opción equivocada de una lista que nosotros escribimos.
 */
export interface Clasificador {
  clasificar(texto: string, opciones: readonly OpcionClasificable[]): Promise<string | null>;
}

/** Clasificador que nunca entiende nada. Útil donde no hay lista cerrada que ofrecer. */
export const CLASIFICADOR_NULO: Clasificador = {
  async clasificar() {
    return null;
  },
};
