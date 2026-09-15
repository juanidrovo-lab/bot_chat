/**
 * Los efectos externos hacia Google, tal como los publica el relay.
 *
 * Google Calendar es un espejo (D4). Nada de lo que pase aquí puede cambiar la agenda: la
 * cita ya está en Postgres, el horario ya está ocupado, y el usuario ya recibió su
 * confirmación. Lo único que hay que garantizar es que ejecutar esto dos veces no cree dos
 * eventos, porque la entrega es *at-least-once*.
 */
import { z } from 'zod';
import type { CalendarioDe } from './puertos/Calendario.ts';
import type { RepoCitas } from './puertos/RepoCitas.ts';
import type { ManejadorOutbox } from './relayOutbox.ts';
import { FalloPermanente } from './relayOutbox.ts';

const PayloadCrear = z.object({ citaId: z.uuid() });
const PayloadBorrar = z.object({ citaId: z.uuid(), gcalEventId: z.string().min(1) });

export interface DependenciasEfectos {
  repoCitas: RepoCitas;
  calendarioDe: CalendarioDe;
  /** Deriva el id determinista del evento a partir del id de la cita. */
  idDeEvento: (citaId: string) => string;
}

/**
 * El texto del evento **no** sale de `content.ts` a propósito: esa regla es para lo que el
 * bot dice en el chat, revisable por despacho. Esto es una entrada de agenda que solo ve el
 * abogado, y meterla en el catálogo conversacional la sometería a reglas —dos frases, un
 * emoji, usted— que no vienen al caso.
 */
function tituloDe(materia: string, nombre: string | null): string {
  return `Consulta ${materia}${nombre === null ? '' : ` · ${nombre}`}`;
}

export function crearManejadoresGoogle(
  deps: DependenciasEfectos,
): Readonly<Record<string, ManejadorOutbox>> {
  return {
    async 'gcal.crear'(trabajo) {
      const payload = PayloadCrear.safeParse(trabajo.payload);
      if (!payload.success) throw new FalloPermanente('payload de gcal.crear ilegible');

      const cita = await deps.repoCitas.paraCalendario(trabajo.tenantId, payload.data.citaId);
      // La cita se borró: no hay nada que reflejar y reintentar no la va a devolver.
      if (cita === null) throw new FalloPermanente('la cita ya no existe');

      // Se canceló entre que se encoló y se publicó. El borrado tiene su propio trabajo,
      // así que aquí basta con no crear nada.
      if (cita.estado === 'cancelada') return;
      if (cita.gcalEventId !== null) return;

      const calendario = await deps.calendarioDe(trabajo.tenantId, cita.abogadoId);
      // Sin Google conectado no hay espejo que mantener; tampoco es un fallo.
      if (calendario === null) return;

      const eventId = await calendario.crearEvento({
        id: deps.idDeEvento(cita.id),
        iniciaAt: cita.iniciaAt,
        terminaAt: cita.terminaAt,
        titulo: tituloDe(cita.materia, cita.nombreContacto),
        descripcion: `Modalidad: ${cita.modalidad}. WhatsApp: ${cita.waIdContacto}.`,
      });

      await deps.repoCitas.anotarEventoGoogle(trabajo.tenantId, cita.id, eventId);
    },

    async 'gcal.borrar'(trabajo) {
      const payload = PayloadBorrar.safeParse(trabajo.payload);
      if (!payload.success) throw new FalloPermanente('payload de gcal.borrar ilegible');

      const cita = await deps.repoCitas.paraCalendario(trabajo.tenantId, payload.data.citaId);
      // Si la cita desapareció, el abogado que hay que avisar tampoco se puede resolver.
      if (cita === null) throw new FalloPermanente('la cita ya no existe');

      const calendario = await deps.calendarioDe(trabajo.tenantId, cita.abogadoId);
      if (calendario === null) return;

      // Borrar algo que ya no está es el resultado que se buscaba; el adaptador se encarga.
      await calendario.borrarEvento(payload.data.gcalEventId);
    },
  };
}
