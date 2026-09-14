/**
 * Reparación escalonada (§8). Tres fallos y se deriva, sin excepción y sin cuarto intento.
 *
 * Es lo que separa un bot usable de uno que la gente abandona: el bot genérico repite
 * «no entendí» en bucle infinito hasta que el usuario se va.
 */
export const MAX_FALLOS = 3;

export type Reparacion =
  /** 1.er fallo: reformular corto, con otras palabras. */
  | { tipo: 'reformular'; fallos: number }
  /** 2.º fallo: dar un ejemplo concreto de respuesta válida. */
  | { tipo: 'ejemplo'; fallos: number }
  /** 3.er fallo: derivar a una persona. */
  | { tipo: 'derivar'; fallos: number };

export function registrarFallo(fallosPrevios: number): Reparacion {
  const fallos = Math.min(fallosPrevios + 1, MAX_FALLOS);
  if (fallos >= MAX_FALLOS) return { tipo: 'derivar', fallos: MAX_FALLOS };
  if (fallos === 2) return { tipo: 'ejemplo', fallos };
  return { tipo: 'reformular', fallos };
}
