/**
 * Lo que `/health` tiene que comprobar de verdad (§9).
 *
 * Un 200 vacío solo demuestra que el proceso de Node sigue vivo, que es justo lo que no
 * falla: lo que falla es la base llena, la cola atascada o el disco sin espacio. Una sonda
 * que no toca esas cosas es peor que no tener sonda, porque convence a todo el mundo de que
 * el sistema está bien.
 */
export interface Sonda {
  nombre: string;
  /** Lanza si no está bien. El mensaje sale al cuerpo de la respuesta: sin PII. */
  comprobar(): Promise<void>;
}
