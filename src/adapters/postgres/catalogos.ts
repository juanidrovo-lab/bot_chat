/**
 * Lo que el dominio no sabe: qué materias atiende el despacho, qué pregunta el triaje de
 * cada una, cuánto cuesta y qué horarios quedan libres.
 *
 * Las materias NO son un enum: cada despacho define las suyas en `tenant_config.tarifario`
 * (§4.6). Un enum de Postgres convertiría al cliente #2 con otra materia en una migración.
 *
 * **Sobre las consultas.** Un turno pregunta por el catálogo varias veces —para la lista
 * que se envía y para la lista cerrada que recibe el clasificador—, y antes eso eran cinco
 * transacciones por mensaje contra las mismas filas. Ahora la configuración del despacho
 * sale de una sola consulta memorizada, y la disponibilidad se memoriza unos segundos. Que
 * la disponibilidad pueda quedar unos segundos vieja no es un riesgo: esa lista es
 * informativa y la exclusión real la da el índice único, que ya sabe decir «ese horario se
 * acaba de ocupar».
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Catalogos, PeticionCatalogo } from '../../app/puertos/Catalogos.ts';
import type { CitaActiva } from '../../domain/conversacion/maquina.ts';
import type { Reloj } from '../../app/puertos/Reloj.ts';
import type { RepoCitas } from '../../app/puertos/RepoCitas.ts';
import { slotsDisponibles } from '../../app/disponibilidad.ts';
import { diasConCupo, slotsDelDia } from '../../domain/agenda/disponibilidad.ts';
import { idDeSlot, leerIdDeSlot } from '../../domain/agenda/Slot.ts';
import type { Politica } from '../../domain/agenda/politicas.ts';
import { formatearFechaHora } from '../../platform/time.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';
import { aInstante } from './tipos.ts';

const PreguntaTriaje = z.object({
  pregunta: z.string(),
  opciones: z.array(z.object({ id: z.string(), titulo: z.string() })).min(1),
});

const MateriaConfig = z.object({
  titulo: z.string(),
  honorarioUsd: z.string(),
  triaje: z.array(PreguntaTriaje).default([]),
});

const Tarifario = z.record(z.string(), MateriaConfig);
export type Tarifario = z.infer<typeof Tarifario>;

interface ConfigDespacho {
  nombre: string;
  tarifario: Tarifario;
}

/**
 * Memoriza por clave durante un rato. Guarda la promesa, no el valor, para que dos
 * llamadas simultáneas compartan una sola consulta; y descarta la entrada si falla, para no
 * dejar un error cacheado.
 */
function memoria<T>(ttlMs: number, cargar: (clave: string) => Promise<T>) {
  const cache = new Map<string, { valor: Promise<T>; expira: number }>();

  return (clave: string): Promise<T> => {
    const ahora = Date.now();
    const guardado = cache.get(clave);
    if (guardado !== undefined && guardado.expira > ahora) return guardado.valor;

    if (cache.size > 64) {
      for (const [k, v] of cache) if (v.expira <= ahora) cache.delete(k);
    }

    const valor = cargar(clave).catch((error: unknown) => {
      cache.delete(clave);
      throw error;
    });
    cache.set(clave, { valor, expira: ahora + ttlMs });
    return valor;
  };
}

const TTL_CONFIG_MS = 30_000;

/** Los identificadores de día que produce el catálogo de días. */
const DIA_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

export interface OpcionesCatalogos {
  db: BaseDatos;
  repo: RepoCitas;
  reloj: Reloj;
  politica: Politica;
}

export function crearCatalogos(opciones: OpcionesCatalogos): Catalogos {
  const { db, repo, reloj, politica } = opciones;

  /** Nombre y tarifario en una sola consulta: antes eran dos, y varias veces por turno. */
  const configDe = memoria<ConfigDespacho>(TTL_CONFIG_MS, async (tenantId) => {
    const { rows } = await enTenant(db, tenantId, (tx) =>
      tx.execute<{ tarifario: unknown; nombre: string }>(sql`
        SELECT c.tarifario, t.nombre
          FROM tenant_config c JOIN tenants t ON t.id = c.tenant_id
         WHERE c.tenant_id = ${tenantId}::uuid
      `),
    );
    const fila = rows[0];
    const analizado = Tarifario.safeParse(fila?.tarifario ?? {});
    // Un tarifario mal formado deja al despacho sin materias y el flujo dice que no hay
    // opciones, en vez de reventar a mitad de una conversación.
    return { nombre: fila?.nombre ?? '', tarifario: analizado.success ? analizado.data : {} };
  });

  /**
   * La disponibilidad **no** se memoriza, a diferencia de la configuración.
   *
   * Se intentó con unos segundos de vida y resultó estar mal: justo después de perder la
   * carrera por un horario, el guion vuelve a ELEGIR_HORA y tiene que ofrecer una lista
   * **fresca**. Con caché reaparecía el hueco recién ocupado y el usuario podía elegirlo
   * otra vez, en bucle. Son tres consultas, y solo cuando hay una lista de días u horas de
   * por medio: barato al lado de un bucle de «ese horario se acaba de ocupar».
   */
  async function slotsPara(peticion: PeticionCatalogo) {
    const materia = peticion.contexto.materia;
    if (materia === undefined) return [];
    return slotsDisponibles({ repo, reloj, politica }, peticion.tenantId, materia);
  }

  /**
   * La cita vigente. Por `citas_una_activa_por_contacto` no puede haber más de una, así que
   * la misma consulta sirve para el entorno de la máquina y para la lista de CANCELAR_CITA.
   */
  async function citaActivaDe(
    peticion: PeticionCatalogo,
  ): Promise<{ cita: CitaActiva; titulo: string } | null> {
    const { rows } = await enTenant(db, peticion.tenantId, (tx) =>
      tx.execute<{
        id: string;
        materia: string;
        modalidad: 'presencial' | 'virtual';
        inicia_at: unknown;
      }>(sql`
        SELECT id, materia, modalidad, inicia_at FROM citas
         WHERE tenant_id = ${peticion.tenantId}::uuid
           AND contacto_id = ${peticion.contactoId}::uuid
           AND estado IN ('reservada', 'confirmada')
         ORDER BY inicia_at
         LIMIT 1
      `),
    );
    const fila = rows[0];
    if (fila === undefined) return null;
    return {
      cita: { id: fila.id, materia: fila.materia, modalidad: fila.modalidad },
      titulo: formatearFechaHora(aInstante(fila.inicia_at)),
    };
  }

  return {
    async opciones(catalogo, peticion) {
      switch (catalogo) {
        case 'materias': {
          const { tarifario } = await configDe(peticion.tenantId);
          return Object.entries(tarifario).map(([id, materia]) => ({
            id,
            titulo: materia.titulo,
            descripcion: materia.titulo,
          }));
        }

        case 'triaje': {
          const { tarifario } = await configDe(peticion.tenantId);
          const materia = peticion.contexto.materia;
          const config = materia === undefined ? undefined : tarifario[materia];
          const indice = peticion.contexto.triaje?.length ?? 0;
          return config?.triaje[indice]?.opciones ?? [];
        }

        case 'dias': {
          const slots = await slotsPara(peticion);
          return diasConCupo(slots, politica).map((dia) => ({
            id: dia,
            titulo: reloj.formatearDia(dia),
          }));
        }

        case 'horas': {
          const dia = peticion.contexto.dia;
          // La máquina guarda el id de la opción sin interpretarlo, así que aquí puede
          // llegar cualquier cosa —un botón viejo, un id manipulado—. Sin huecos que
          // ofrecer, el guion dice que no hay horarios; que es exactamente lo correcto.
          if (dia === undefined || !DIA_LOCAL.test(dia)) return [];
          const slots = await slotsPara(peticion);
          return slotsDelDia(slots, dia, politica).map((slot) => ({
            id: idDeSlot(slot),
            titulo: reloj.formatearHora(slot.inicioMs),
          }));
        }

        case 'citasActivas': {
          const activa = await citaActivaDe(peticion);
          return activa === null ? [] : [{ id: activa.cita.id, titulo: activa.titulo }];
        }
      }
    },

    async citaActiva(peticion) {
      return (await citaActivaDe(peticion))?.cita ?? null;
    },

    async preguntasTriaje(tenantId, materia) {
      if (materia === undefined) return 0;
      const { tarifario } = await configDe(tenantId);
      return tarifario[materia]?.triaje.length ?? 0;
    },

    async datosDeTexto(peticion) {
      const { nombre, tarifario } = await configDe(peticion.tenantId);
      const { materia, slotId, dia, modalidad, triaje } = peticion.contexto;
      const config = materia === undefined ? undefined : tarifario[materia];

      const datos: Record<string, string> = { estudio: nombre };
      if (config !== undefined) {
        datos.materia = config.titulo;
        datos.honorario = `USD ${config.honorarioUsd}`;
        const pregunta = config.triaje[triaje?.length ?? 0]?.pregunta;
        if (pregunta !== undefined) datos.pregunta = pregunta;
      }
      if (modalidad !== undefined) datos.modalidad = modalidad;

      // La fecha del texto sale del hueco elegido; si aún no hay hueco, del día.
      const slot = slotId === undefined ? null : leerIdDeSlot(slotId);
      if (slot !== null) datos.fecha = reloj.formatearFechaHora(slot.inicioMs);
      else if (dia !== undefined && DIA_LOCAL.test(dia)) datos.fecha = reloj.formatearDia(dia);

      return datos;
    },
  };
}
