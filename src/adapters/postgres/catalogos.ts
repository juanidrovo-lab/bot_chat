/**
 * Lo que el dominio no sabe: qué materias atiende el despacho, qué pregunta el triaje de
 * cada una, cuánto cuesta y qué horarios quedan.
 *
 * Las materias NO son un enum: cada despacho define las suyas en `tenant_config.tarifario`
 * (§4.6). Un enum de Postgres convertiría al cliente #2 con otra materia en una migración.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Catalogos, OpcionCatalogo, PeticionCatalogo } from '../../app/puertos/Catalogos.ts';
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

export interface OpcionesCatalogos {
  db: BaseDatos;
  /** Nombre del estudio, para los textos. */
  nombreEstudio?: string;
}

export function crearCatalogos(opciones: OpcionesCatalogos): Catalogos {
  const { db } = opciones;

  async function tarifarioDe(tenantId: string): Promise<Tarifario> {
    const { rows } = await enTenant(db, tenantId, (tx) =>
      tx.execute<{ tarifario: unknown; nombre: string }>(sql`
        SELECT c.tarifario, t.nombre
          FROM tenant_config c JOIN tenants t ON t.id = c.tenant_id
         WHERE c.tenant_id = ${tenantId}::uuid
      `),
    );
    const analizado = Tarifario.safeParse(rows[0]?.tarifario ?? {});
    // Un tarifario mal formado deja al despacho sin materias y el flujo dice que no hay
    // opciones, en vez de reventar a mitad de una conversación.
    return analizado.success ? analizado.data : {};
  }

  async function nombreDe(tenantId: string): Promise<string> {
    const { rows } = await enTenant(db, tenantId, (tx) =>
      tx.execute<{ nombre: string }>(sql`SELECT nombre FROM tenants WHERE id = ${tenantId}::uuid`),
    );
    return rows[0]?.nombre ?? opciones.nombreEstudio ?? '';
  }

  async function citasActivas(peticion: PeticionCatalogo): Promise<readonly OpcionCatalogo[]> {
    const { rows } = await enTenant(db, peticion.tenantId, (tx) =>
      tx.execute<{ id: string; inicia_at: unknown }>(sql`
        SELECT id, inicia_at FROM citas
         WHERE tenant_id = ${peticion.tenantId}::uuid
           AND contacto_id = ${peticion.contactoId}::uuid
           AND estado IN ('reservada', 'confirmada')
         ORDER BY inicia_at
      `),
    );
    return rows.map((fila) => ({
      id: fila.id,
      titulo: formatearFechaHora(aInstante(fila.inicia_at)),
    }));
  }

  return {
    async opciones(catalogo, peticion) {
      switch (catalogo) {
        case 'materias': {
          const tarifario = await tarifarioDe(peticion.tenantId);
          return Object.entries(tarifario).map(([id, materia]) => ({
            id,
            titulo: materia.titulo,
            descripcion: materia.titulo,
          }));
        }

        case 'triaje': {
          const tarifario = await tarifarioDe(peticion.tenantId);
          const materia = peticion.contexto.materia;
          const config = materia === undefined ? undefined : tarifario[materia];
          const indice = peticion.contexto.triaje?.length ?? 0;
          return config?.triaje[indice]?.opciones ?? [];
        }

        case 'citasActivas':
          return citasActivas(peticion);

        case 'dias':
        case 'horas':
          // Fase 4. Mientras tanto no hay horarios que ofrecer, que es lo que el flujo
          // ya sabe manejar: avisa y no manda una lista vacía.
          return [];
      }
    },

    async preguntasTriaje(tenantId, materia) {
      if (materia === undefined) return 0;
      const tarifario = await tarifarioDe(tenantId);
      return tarifario[materia]?.triaje.length ?? 0;
    },

    async datosDeTexto(peticion) {
      const tarifario = await tarifarioDe(peticion.tenantId);
      const { materia, iniciaAt, modalidad, triaje } = peticion.contexto;
      const config = materia === undefined ? undefined : tarifario[materia];

      const datos: Record<string, string> = { estudio: await nombreDe(peticion.tenantId) };
      if (config !== undefined) {
        datos.materia = config.titulo;
        datos.honorario = `USD ${config.honorarioUsd}`;
        const pregunta = config.triaje[triaje?.length ?? 0]?.pregunta;
        if (pregunta !== undefined) datos.pregunta = pregunta;
      }
      if (iniciaAt !== undefined) datos.fecha = formatearFechaHora(new Date(iniciaAt));
      if (modalidad !== undefined) datos.modalidad = modalidad;
      return datos;
    },
  };
}
