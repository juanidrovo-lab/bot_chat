/**
 * Comprobación de que un audio es de verdad `.ogg` con OPUS.
 *
 * WhatsApp solo lo entrega como **nota de voz** si es OGG/OPUS y se manda con
 * `voice: true`. Cualquier otro formato —un m4a renombrado, un OGG con Vorbis— llega como
 * archivo adjunto: no se reproduce en línea, hay que descargarlo, y el efecto de «el
 * abogado le está hablando» se pierde por completo.
 *
 * Eso no da error en ningún sitio, así que sin esta comprobación el fallo se descubre
 * cuando un cliente lo comenta. Se mira aquí, al registrar el fichero.
 */

/** Cabecera de página Ogg. Los cuatro primeros bytes de todo fichero Ogg. */
const FIRMA_OGG = 'OggS';
/** Identificador del códec, dentro de la primera página. */
const FIRMA_OPUS = 'OpusHead';
/**
 * La primera página de un Ogg no pasa de 65 307 bytes, y `OpusHead` va al principio de su
 * carga útil. Mirar los primeros cuatro kilobytes sobra y evita leer el fichero entero.
 */
export const VENTANA = 4096;

export type Veredicto = { ok: true } | { ok: false; motivo: string };

export function esOggOpus(cabecera: Uint8Array): Veredicto {
  const texto = Buffer.from(cabecera.subarray(0, VENTANA)).toString('latin1');

  if (!texto.startsWith(FIRMA_OGG)) {
    return { ok: false, motivo: 'no es un contenedor Ogg (¿un .m4a renombrado?)' };
  }
  if (!texto.includes(FIRMA_OPUS)) {
    // Un Ogg con Vorbis es el error fácil: `ffmpeg` sin `-c:a libopus` lo produce.
    return { ok: false, motivo: 'es Ogg pero no lleva OPUS (falta -c:a libopus)' };
  }
  return { ok: true };
}
