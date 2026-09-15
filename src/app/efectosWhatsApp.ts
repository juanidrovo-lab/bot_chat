/**
 * El recordatorio de la cita, tal como lo publica el relay.
 *
 * Va por plantilla porque se envía fuera de la ventana de 24 h: pasado ese plazo WhatsApp
 * no deja mandar texto libre. El cuerpo de la plantilla lo aprueba Meta y vive allí, no en
 * `content.ts`; lo que sí se decide aquí son los **payloads** de los botones, porque son los
 * identificadores que la máquina de estados va a recibir de vuelta.
 */
import { z } from 'zod';
import type { MensajeriaDe } from './puertos/Mensajeria.ts';
import type { RepoCitas } from './puertos/RepoCitas.ts';
import type { Reloj } from './puertos/Reloj.ts';
import type { ManejadorOutbox } from './relayOutbox.ts';
import { FalloPermanente } from './relayOutbox.ts';
import { OPCION } from '../domain/conversacion/acciones.ts';

const PayloadRecordatorio = z.object({ citaId: z.uuid() });

/** Nombre de la plantilla aprobada en Meta (fase 0). */
export const PLANTILLA_RECORDATORIO = 'recordatorio_cita';
export const IDIOMA_PLANTILLA = 'es';

/**
 * Los tres botones, en el orden en que están definidos en la plantilla. El índice importa:
 * Meta los casa por posición, no por nombre.
 */
const BOTONES = [OPCION.confirmarAsistencia, OPCION.cancelar, OPCION.reagendar];

export interface DependenciasRecordatorio {
  repoCitas: RepoCitas;
  mensajeriaDe: MensajeriaDe;
  reloj: Reloj;
}

export function crearManejadoresWhatsApp(
  deps: DependenciasRecordatorio,
): Readonly<Record<string, ManejadorOutbox>> {
  return {
    async 'wa.recordatorio'(trabajo) {
      const payload = PayloadRecordatorio.safeParse(trabajo.payload);
      if (!payload.success) throw new FalloPermanente('payload de wa.recordatorio ilegible');

      const cita = await deps.repoCitas.paraCalendario(trabajo.tenantId, payload.data.citaId);
      if (cita === null) throw new FalloPermanente('la cita ya no existe');

      // Se canceló entre que se encoló el recordatorio y se publicó. Mandarlo sería peor
      // que no mandarlo: el contacto recibiría un aviso de una cita que ya no tiene.
      if (cita.estado === 'cancelada') return;

      const mensajeria = await deps.mensajeriaDe(trabajo.tenantId);

      await mensajeria.enviarPlantilla(cita.waIdContacto, {
        nombre: PLANTILLA_RECORDATORIO,
        idioma: IDIOMA_PLANTILLA,
        componentes: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: deps.reloj.formatearFechaHora(cita.iniciaAt.getTime()) }],
          },
          ...BOTONES.map((payloadBoton, indice) => ({
            type: 'button',
            sub_type: 'quick_reply',
            index: String(indice),
            parameters: [{ type: 'payload', payload: payloadBoton }],
          })),
        ],
      });
    },
  };
}
