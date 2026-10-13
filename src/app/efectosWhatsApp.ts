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

const PayloadCita = z.object({ citaId: z.uuid() });

/** Nombres de las plantillas aprobadas en Meta (fase 0). */
export const PLANTILLA_RECORDATORIO = 'recordatorio_cita';
export const PLANTILLA_CANCELADA = 'cita_cancelada';
export const IDIOMA_PLANTILLA = 'es';

const PayloadAviso = z.object({ conversacionId: z.uuid(), waIdContacto: z.string().min(1) });

/**
 * Los tres botones, en el orden en que están definidos en la plantilla. El índice importa:
 * Meta los casa por posición, no por nombre.
 */
const BOTONES = [OPCION.confirmarAsistencia, OPCION.cancelar, OPCION.reagendar];

export interface DependenciasRecordatorio {
  repoCitas: RepoCitas;
  mensajeriaDe: MensajeriaDe;
  reloj: Reloj;
  /** A quién avisar de una consulta nueva, por despacho. Sin configurar, no se avisa. */
  avisoAbogadoDe: (tenantId: string) => Promise<{ waId: string; plantilla: string } | null>;
}

export function crearManejadoresWhatsApp(
  deps: DependenciasRecordatorio,
): Readonly<Record<string, ManejadorOutbox>> {
  return {
    /**
     * «Entró una consulta»: el aviso al número del abogado.
     *
     * Va por plantilla porque ese número nunca escribió al bot y la ventana de 24 h está
     * cerrada desde siempre. El único parámetro es el número del contacto: **el relato no
     * viaja aquí**. Lo que la persona contó es la consulta jurídica, y mandarla por una
     * plantilla la sacaría del único sitio donde la retención de §9 la borra.
     */
    async 'wa.aviso_abogado'(trabajo) {
      const payload = PayloadAviso.safeParse(trabajo.payload);
      if (!payload.success) throw new FalloPermanente('payload de wa.aviso_abogado ilegible');

      const aviso = await deps.avisoAbogadoDe(trabajo.tenantId);
      // Dejó de estar configurado entre que se encoló y se publicó: no es un fallo que
      // mejore reintentando, y la consulta sigue en la bandeja del panel.
      if (aviso === null) throw new FalloPermanente('el despacho no tiene a quién avisar');

      const mensajeria = await deps.mensajeriaDe(trabajo.tenantId);
      await mensajeria.enviarPlantilla(aviso.waId, {
        nombre: aviso.plantilla,
        idioma: IDIOMA_PLANTILLA,
        componentes: [
          { type: 'body', parameters: [{ type: 'text', text: payload.data.waIdContacto }] },
        ],
      });
    },

    async 'wa.recordatorio'(trabajo) {
      const payload = PayloadCita.safeParse(trabajo.payload);
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

    /**
     * El estudio canceló desde el panel. Sale por plantilla y no como texto libre porque a
     * la hora en que un abogado reorganiza su día la ventana de 24 h casi nunca sigue
     * abierta, y un aviso que no llega es peor que no cancelar.
     *
     * Este trabajo se encola con el `proximo_intento_at` diez segundos en el futuro: es el
     * plazo de deshacer del panel. Cuando el relay llega hasta aquí, ya no hay vuelta atrás
     * —y por eso el deshacer borra la fila antes, en vez de intentar desmentirla después—.
     */
    async 'wa.cancelada'(trabajo) {
      const payload = PayloadCita.safeParse(trabajo.payload);
      if (!payload.success) throw new FalloPermanente('payload de wa.cancelada ilegible');

      const cita = await deps.repoCitas.paraCalendario(trabajo.tenantId, payload.data.citaId);
      if (cita === null) throw new FalloPermanente('la cita ya no existe');

      // Se deshizo entre que venció el plazo y que el relay reclamó el trabajo. Avisar de
      // una cancelación que ya no existe dejaría al contacto creyendo que no tiene cita.
      if (cita.estado !== 'cancelada') return;

      const mensajeria = await deps.mensajeriaDe(trabajo.tenantId);

      await mensajeria.enviarPlantilla(cita.waIdContacto, {
        nombre: PLANTILLA_CANCELADA,
        idioma: IDIOMA_PLANTILLA,
        componentes: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: deps.reloj.formatearFechaHora(cita.iniciaAt.getTime()) }],
          },
        ],
      });
    },
  };
}
