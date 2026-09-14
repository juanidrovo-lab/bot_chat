/**
 * Fallos previstos de la reserva. No son excepciones excepcionales: son ramas del guion.
 * Cada uno tiene su texto en `content.ts` y su transición en la máquina de estados.
 */
export class SlotTomadoError extends Error {
  constructor() {
    super('El horario se ocupó entre que se ofreció y se confirmó');
    this.name = 'SlotTomadoError';
  }
}

export class YaTieneCitaError extends Error {
  constructor() {
    super('El contacto ya tiene una cita activa');
    this.name = 'YaTieneCitaError';
  }
}

export class LimiteMensualError extends Error {
  readonly limite: number;

  constructor(limite: number) {
    super(`El contacto agotó su cupo de ${limite} reservas este mes`);
    this.name = 'LimiteMensualError';
    this.limite = limite;
  }
}
