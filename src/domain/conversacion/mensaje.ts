import { OPCION } from './acciones.ts';

/**
 * Un mensaje entrante como lo ve el dominio. El adaptador traduce la forma de Meta a esto;
 * la máquina de estados no sabe que WhatsApp existe, y el día que haya un widget web o
 * Telegram cambia un solo adaptador.
 */
export type MensajeNormalizado =
  | { clase: 'texto'; waMessageId: string; waId: string; texto: string }
  | { clase: 'opcion'; waMessageId: string; waId: string; opcionId: string; titulo: string }
  | { clase: 'formulario'; waMessageId: string; waId: string; respuesta: unknown }
  | { clase: 'audio'; waMessageId: string; waId: string; mediaId: string; esNotaDeVoz: boolean }
  | { clase: 'no_soportado'; waMessageId: string; waId: string; tipo: string };

/** Palabras que valen en cualquier punto del guion (§5). */
const INTENTS: readonly { palabras: readonly string[]; id: string }[] = [
  { palabras: ['menu', 'menú', '0', 'inicio', 'volver'], id: OPCION.menu },
  { palabras: ['cancelar', 'anular'], id: OPCION.cancelar },
  { palabras: ['persona', 'humano', 'asesor', 'abogado'], id: OPCION.persona },
];

/**
 * Reconoce los intents globales sin pasar por el modelo.
 *
 * Solo dispara con el mensaje entero, no con una palabra suelta dentro de una frase: quien
 * escribe «quiero cancelar el contrato de arriendo» está describiendo su consulta, no
 * pidiendo cancelar una cita. Esa distinción, en texto corrido, es justamente lo que se
 * delega al clasificador.
 */
export function intentGlobal(texto: string): string | null {
  const limpio = texto
    .trim()
    .toLowerCase()
    .replace(/[.,;:!¡?¿]/g, '');
  for (const intent of INTENTS) {
    if (intent.palabras.includes(limpio)) return intent.id;
  }
  return null;
}
