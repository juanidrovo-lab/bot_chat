/**
 * Los activos del panel, servidos desde `estatico/`.
 *
 * Se leen una vez y se quedan en memoria: son dos archivos de cincuenta kilobytes que no
 * cambian sin un despliegue, y leer del disco en cada petición solo añadiría una forma de
 * fallar. La lista es cerrada a propósito —nada de componer una ruta con lo que venga en la
 * URL—, que es como se escribe un salto de directorio sin darse cuenta.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIRECTORIO = fileURLToPath(new URL('../../../../estatico/', import.meta.url));

const PERMITIDOS: Readonly<Record<string, string>> = {
  'htmx.js': 'htmx.min.js',
  'acceso.js': 'acceso.js',
};

const TIPO = 'text/javascript; charset=utf-8';

export interface Estatico {
  cuerpo: string;
  tipo: string;
}

export function crearEstaticos(): (nombre: string) => Promise<Estatico | null> {
  const memoria = new Map<string, Estatico>();

  return async (nombre) => {
    const enMemoria = memoria.get(nombre);
    if (enMemoria !== undefined) return enMemoria;

    const archivo = PERMITIDOS[nombre];
    if (archivo === undefined) return null;

    const cuerpo = await readFile(new URL(archivo, `file://${DIRECTORIO}`), 'utf8');
    const estatico = { cuerpo, tipo: TIPO };
    memoria.set(nombre, estatico);
    return estatico;
  };
}
