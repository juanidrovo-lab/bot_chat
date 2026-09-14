/**
 * Límites de la API de WhatsApp. Se truncan **en código**, nunca se confía en que el texto
 * venga corto: pasarse hace que Meta rechace el mensaje entero con un 400, y entonces el
 * usuario no recibe nada en vez de recibirlo recortado.
 */
import type { BotonRespuesta, FilaLista } from '../../app/puertos/Mensajeria.ts';

export const LIMITES = {
  /** Filas totales de una lista interactiva, sumando todas las secciones. */
  filasLista: 10,
  /** Botones de respuesta rápida. */
  botones: 3,
  tituloFila: 24,
  descripcionFila: 72,
  tituloSeccion: 24,
  textoBoton: 20,
  /** Texto del botón que abre una lista. */
  textoBotonLista: 20,
  encabezado: 60,
  cuerpo: 1024,
  pie: 60,
  /** Mensaje de texto plano. */
  texto: 4096,
} as const;

/**
 * Trunca por puntos de código, no por unidades UTF-16: cortar un `string` a la mitad de un
 * par suplente produce un carácter inválido, y el emoji de la confirmación de la cita está
 * justo en ese caso.
 */
export function truncar(texto: string, maximo: number): string {
  const puntos = Array.from(texto);
  if (puntos.length <= maximo) return texto;
  if (maximo <= 1) return puntos.slice(0, maximo).join('');
  return puntos.slice(0, maximo - 1).join('') + '…';
}

/** Recorta las filas al máximo de la lista y cada campo a su propio límite. */
export function ajustarFilas(filas: readonly FilaLista[]): FilaLista[] {
  return filas.slice(0, LIMITES.filasLista).map((fila) => ({
    id: fila.id,
    titulo: truncar(fila.titulo, LIMITES.tituloFila),
    ...(fila.descripcion === undefined
      ? {}
      : { descripcion: truncar(fila.descripcion, LIMITES.descripcionFila) }),
  }));
}

export function ajustarBotones(botones: readonly BotonRespuesta[]): BotonRespuesta[] {
  return botones.slice(0, LIMITES.botones).map((boton) => ({
    id: boton.id,
    titulo: truncar(boton.titulo, LIMITES.textoBoton),
  }));
}
