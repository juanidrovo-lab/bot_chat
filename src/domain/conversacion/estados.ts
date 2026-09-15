/**
 * Estados de la conversación (§5). Son texto porque `conversaciones.estado` es texto: el
 * guion cambia y `flow_version` es el mecanismo previsto para que una conversación vieja no
 * se cuelgue, no una migración de la base.
 */
export const ESTADOS = [
  'INICIO',
  'CONSENTIMIENTO',
  'MENU',
  'TRIAJE',
  'TARIFA',
  'CITA_EXISTENTE',
  'MODALIDAD',
  'ELEGIR_DIA',
  'ELEGIR_HORA',
  'DATOS',
  'CONFIRMAR',
  'CITA_OK',
  'CANCELAR_CITA',
  'CIERRE_SIN_CITA',
  'DESPEDIDA',
  'DERIVADA',
] as const;

export type Estado = (typeof ESTADOS)[number];

export function esEstado(valor: string): valor is Estado {
  return (ESTADOS as readonly string[]).includes(valor);
}

/** Estados en los que la conversación terminó: no se espera nada del usuario. */
const TERMINALES: readonly Estado[] = ['CITA_OK', 'CIERRE_SIN_CITA', 'DESPEDIDA', 'DERIVADA'];

export function esTerminal(estado: Estado): boolean {
  return TERMINALES.includes(estado);
}

export interface DatosContacto {
  nombre: string;
  email?: string;
  cedula?: string;
}

/** Lo que se va sabiendo de la consulta. Se guarda en `conversaciones.contexto`. */
export interface Contexto {
  materia?: string;
  /** Respuestas del triaje, en orden de pregunta. */
  triaje?: readonly string[];
  honorarioUsd?: string;
  modalidad?: 'presencial' | 'virtual';
  /** Día elegido, `YYYY-MM-DD` en hora local. */
  dia?: string;
  /**
   * Hueco elegido, como identificador **opaco**. Dentro viajan el abogado y el instante,
   * pero la máquina no lo interpreta: qué abogado atiende y a qué hora es cosa de la
   * agenda, no del guion.
   */
  slotId?: string;
  datos?: DatosContacto;
  /** Cita vigente, cuando la hay. */
  citaActivaId?: string;
}
