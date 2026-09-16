/**
 * El contenido de cada despacho: sus textos reescritos y su Flow de captura de datos.
 *
 * §8 dice que todo el texto de cara al usuario vive en `content.ts` **por tenant**, y hasta
 * ahora el arranque pasaba el catálogo base a todo el mundo. Con un cliente daba igual; lo
 * que no daba igual es que `flowDatos` viniera de ahí, porque el catálogo base no lo trae y
 * sin él la conversación se queda a un paso de reservar.
 *
 * Se memoriza como el tarifario y por el mismo motivo: no cambia a mitad de una
 * conversación, y un turno pide el contenido varias veces.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CLAVES_TEXTO } from '../../domain/conversacion/acciones.ts';
import { contenidoDe, type Contenido } from '../../app/content.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';

/** Igual que el del tarifario: un despacho no reescribe sus textos a media conversación. */
const TTL_MS = 30_000;

/**
 * Los textos llegan como un mapa abierto y se filtran después, a propósito.
 *
 * `z.record(z.enum(CLAVES_TEXTO), ...)` **no** sirve: en Zod 4 un `record` con clave enum es
 * exhaustivo y exige las treinta y tantas claves, así que un despacho que reescriba una sola
 * falla la validación entera. `z.partialRecord` arregla eso pero rechaza el objeto completo
 * ante una clave desconocida, y entonces un error tipográfico borra **todos** los textos
 * propios del despacho en vez de uno.
 *
 * Filtrar deja el fallo donde corresponde: la clave mal escrita se ignora —y se avisa, que
 * si no el estudio se queda esperando un texto que nunca aparece— y las demás se aplican.
 */
const TextosCrudos = z.record(z.string(), z.string().min(1));

const CONOCIDAS = new Set<string>(CLAVES_TEXTO);

const FlowDatos = z.object({ flowId: z.string().min(1), cta: z.string().min(1) });

export interface RegistroContenido {
  warn(datos: object, mensaje: string): void;
}

export function crearContenidoDe(
  db: BaseDatos,
  registro: RegistroContenido = { warn: () => {} },
): (tenantId: string) => Promise<Contenido> {
  const cache = new Map<string, { valor: Promise<Contenido>; expira: number }>();

  return (tenantId) => {
    const ahora = Date.now();
    const guardado = cache.get(tenantId);
    if (guardado !== undefined && guardado.expira > ahora) return guardado.valor;

    const valor = (async (): Promise<Contenido> => {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ textos: unknown; flow_datos: unknown }>(sql`
          SELECT textos, flow_datos FROM tenant_config WHERE tenant_id = ${tenantId}::uuid
        `),
      );
      const fila = rows[0];

      /**
       * Configuración mal formada deja al despacho con el catálogo base, no sin contenido:
       * el bot sigue hablando aunque alguien haya escrito mal el JSON.
       */
      const crudos = TextosCrudos.safeParse(fila?.textos ?? {});
      const propios: Partial<Record<(typeof CLAVES_TEXTO)[number], string>> = {};
      const desconocidas: string[] = [];

      for (const [clave, valor] of Object.entries(crudos.success ? crudos.data : {})) {
        if (CONOCIDAS.has(clave)) propios[clave as (typeof CLAVES_TEXTO)[number]] = valor;
        else desconocidas.push(clave);
      }

      if (desconocidas.length > 0) {
        registro.warn({ tenantId, claves: desconocidas }, 'textos con claves que el guion no usa');
      }

      const flow = FlowDatos.safeParse(fila?.flow_datos ?? undefined);
      const base = contenidoDe(propios);
      return flow.success ? { ...base, flowDatos: flow.data } : base;
    })();

    // Si falla, no se deja un error cacheado treinta segundos.
    valor.catch(() => cache.delete(tenantId));
    cache.set(tenantId, { valor, expira: ahora + TTL_MS });
    return valor;
  };
}
