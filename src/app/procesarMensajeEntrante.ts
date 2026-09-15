/**
 * Un turno de conversación, de punta a punta.
 *
 * Toda la lógica del guion vive en `domain/conversacion/maquina.ts`, que es pura. Este caso
 * de uso solo hace tres cosas: traducir el mensaje a un evento, pedirle a la máquina la
 * transición, y ejecutar las acciones declarativas que devuelve. Si aquí aparece un `if`
 * sobre el estado de la conversación, está en el sitio equivocado.
 */
import { z } from 'zod';
import type { Accion, Catalogo } from '../domain/conversacion/acciones.ts';
import type { Contexto, DatosContacto, Estado } from '../domain/conversacion/estados.ts';
import { esEstado } from '../domain/conversacion/estados.ts';
import { intentGlobal, type MensajeNormalizado } from '../domain/conversacion/mensaje.ts';
import {
  opcionesFijasDe,
  requiereCitaActiva,
  transicion,
  type Entorno,
  type Evento,
} from '../domain/conversacion/maquina.ts';
import type { Politica } from '../domain/agenda/politicas.ts';
import { cancelarCita } from './cancelarCita.ts';
import { reservarCita } from './reservarCita.ts';
import type { RepoCitas } from './puertos/RepoCitas.ts';
import { interpolar, type Contenido } from './content.ts';
import type { Catalogos, PeticionCatalogo } from './puertos/Catalogos.ts';
import type { Clasificador, OpcionClasificable } from './puertos/Clasificador.ts';
import type { TrabajoMensajeEntrante } from './puertos/Cola.ts';
import type { Mensajeria } from './puertos/Mensajeria.ts';
import type { RepoConversaciones, SesionConversacion } from './puertos/RepoConversaciones.ts';

/** Respuesta del Flow estático de captura de datos. */
const RespuestaDatos = z.object({
  nombre: z.string().trim().min(2).max(120),
  correo: z.email().optional(),
  cedula: z.string().trim().min(5).max(20).optional(),
});

export interface Registro {
  warn(datos: object, mensaje: string): void;
}

export interface DependenciasProcesar {
  repo: RepoConversaciones;
  /**
   * Fábrica, no instancia: el token y el `phone_number_id` de WhatsApp son de cada
   * despacho, así que una mensajería única mandaría los mensajes de todos por la línea del
   * primero que arrancara.
   */
  mensajeria: (tenantId: string) => Promise<Mensajeria>;
  clasificador: Clasificador;
  catalogos: Catalogos;
  contenido: (tenantId: string) => Promise<Contenido>;
  repoCitas: RepoCitas;
  politica: Politica;
  flowVersion: number;
  registro: Registro;
}

/** Tope de realimentaciones por turno: reservar devuelve un evento, y ese ya no devuelve otro. */
const MAX_VUELTAS = 3;

function aDatosContacto(respuesta: unknown): DatosContacto | null {
  const analizado = RespuestaDatos.safeParse(respuesta);
  if (!analizado.success) return null;
  const { nombre, correo, cedula } = analizado.data;
  return {
    nombre,
    ...(correo === undefined ? {} : { email: correo }),
    ...(cedula === undefined ? {} : { cedula }),
  };
}

export function crearProcesarMensajeEntrante(deps: DependenciasProcesar) {
  /**
   * Traduce el mensaje a un evento del dominio.
   *
   * El texto libre es el único caso que necesita al modelo, y solo cuando el estado espera
   * una lista cerrada: los intents globales se reconocen sin él, y todo lo demás llega ya
   * como opción, formulario o audio.
   */
  async function aEvento(
    mensaje: MensajeNormalizado,
    estado: Estado,
    peticion: PeticionCatalogo,
  ): Promise<Evento> {
    switch (mensaje.clase) {
      case 'opcion':
        return { tipo: 'opcion', id: mensaje.opcionId };

      case 'formulario': {
        const datos = aDatosContacto(mensaje.respuesta);
        return datos === null ? { tipo: 'noEntendido' } : { tipo: 'formulario', datos };
      }

      case 'audio':
        return mensaje.esNotaDeVoz ? { tipo: 'notaDeVoz' } : { tipo: 'noSoportado' };

      case 'no_soportado':
        return { tipo: 'noSoportado' };

      case 'texto': {
        const intent = intentGlobal(mensaje.texto);
        if (intent !== null) return { tipo: 'opcion', id: intent };

        const candidatas = await opcionesClasificables(estado, peticion);
        if (candidatas.length === 0) return { tipo: 'noEntendido' };

        const elegida = await deps.clasificador.clasificar(mensaje.texto, candidatas);
        return elegida === null ? { tipo: 'noEntendido' } : { tipo: 'opcion', id: elegida };
      }
    }
  }

  /** La lista cerrada que puede devolver el clasificador en este estado. */
  async function opcionesClasificables(
    estado: Estado,
    peticion: PeticionCatalogo,
  ): Promise<readonly OpcionClasificable[]> {
    const fijas = opcionesFijasDe(estado).map((id) => ({ id, descripcion: id }));
    if (fijas.length > 0) return fijas;

    const catalogo = catalogoDe(estado);
    if (catalogo === null) return [];
    const opciones = await deps.catalogos.opciones(catalogo, peticion);
    return opciones.map((o) => ({ id: o.id, descripcion: o.descripcion ?? o.titulo }));
  }

  function catalogoDe(estado: Estado): Catalogo | null {
    switch (estado) {
      case 'MENU':
        return 'materias';
      case 'TRIAJE':
        return 'triaje';
      case 'ELEGIR_DIA':
        return 'dias';
      case 'ELEGIR_HORA':
        return 'horas';
      case 'CANCELAR_CITA':
        return 'citasActivas';
      default:
        return null;
    }
  }

  /**
   * Ejecuta una acción. Devuelve un evento cuando el resultado tiene que volver a la
   * máquina —una reserva puede salir bien, perder la carrera por el horario o toparse con
   * el cupo— y `null` cuando la acción se agota en sí misma.
   */
  async function ejecutar(
    accion: Accion,
    sesion: SesionConversacion,
    mensajeria: Mensajeria,
    contenido: Contenido,
    peticion: PeticionCatalogo,
    datosTexto: Readonly<Record<string, string>>,
  ): Promise<Evento | null> {
    const waId = sesion.conversacion.waId;
    const texto = (clave: keyof Contenido['textos']) =>
      interpolar(contenido.textos[clave], datosTexto);

    switch (accion.tipo) {
      case 'texto':
        await mensajeria.enviarTexto(waId, texto(accion.clave));
        return null;

      case 'audio': {
        const clave = contenido.audios[accion.clave];
        // Un despacho sin ese audio grabado simplemente no lo manda: el texto ya salió.
        if (clave !== undefined) await mensajeria.enviarAudio(waId, clave);
        return null;
      }

      case 'lista': {
        const opciones = await deps.catalogos.opciones(accion.catalogo, peticion);
        if (opciones.length === 0) {
          // Sin opciones que ofrecer no se manda una lista vacía, que Meta rechaza.
          await mensajeria.enviarTexto(waId, texto('sinHorarios'));
          return null;
        }
        const filas = opciones.map((o) => ({
          id: o.id,
          titulo: o.titulo,
          ...(o.descripcion === undefined ? {} : { descripcion: o.descripcion }),
        }));
        // El menú lleva además la salida a una persona (§5).
        if (accion.catalogo === 'materias') filas.push({ id: contenido.filaPersona.id, titulo: contenido.filaPersona.titulo });

        await mensajeria.enviarLista(waId, {
          cuerpo: texto(accion.clave),
          textoBoton: 'Ver opciones',
          secciones: [{ titulo: 'Opciones', filas }],
        });
        return null;
      }

      case 'botones':
        await mensajeria.enviarBotones(waId, {
          cuerpo: texto(accion.clave),
          botones: accion.opciones.map((o) => ({ id: o.id, titulo: o.titulo })),
        });
        return null;

      case 'formulario': {
        const flow = contenido.flowDatos;
        if (flow === undefined) {
          // El Flow se crea y publica en Meta (fase 0). Sin él no hay id que enviar.
          deps.registro.warn({ tenantId: peticion.tenantId }, 'despacho sin Flow de datos configurado');
          await mensajeria.enviarTexto(waId, texto(accion.clave));
          return null;
        }
        await mensajeria.enviarFlow(waId, {
          flowId: flow.flowId,
          cta: flow.cta,
          cuerpo: texto(accion.clave),
          token: sesion.conversacion.id,
        });
        return null;
      }

      case 'derivar':
        await sesion.derivar(accion.motivo);
        await sesion.registrarEvento('conversacion.derivada', { motivo: accion.motivo });
        return null;

      case 'cerrarConversacion':
        await sesion.cerrar();
        return null;

      case 'reservar': {
        const { materia, modalidad, slotId, citaActivaId } = peticion.contexto;
        if (materia === undefined || modalidad === undefined || slotId === undefined) {
          deps.registro.warn({ conversacionId: sesion.conversacion.id }, 'reserva sin datos completos');
          return { tipo: 'horarioOcupado' };
        }

        // Los datos del Flow se guardan aunque la reserva falle: volver a pedirlos sería
        // castigar al usuario por una carrera que no provocó.
        await sesion.guardarDatosContacto(accion.datos);

        const resultado = await reservarCita(deps.repoCitas, deps.politica, {
          tenantId: peticion.tenantId,
          contactoId: peticion.contactoId,
          materia,
          modalidad,
          slotId,
          honorarioUsd: (datosTexto.honorario ?? '0').replace(/[^\d.]/g, ''),
          datos: accion.datos,
          // Si venía de CITA_EXISTENTE, esto es un reagendamiento: cancela y reserva en la
          // misma transacción, y no gasta cupo mensual.
          ...(citaActivaId === undefined ? {} : { citaOrigenId: citaActivaId }),
        });

        await sesion.registrarEvento('reserva.intentada', { resultado: resultado.estado });

        switch (resultado.estado) {
          case 'reservada':
            return { tipo: 'citaReservada' };
          case 'yaTieneCita':
            return { tipo: 'yaTieneCita' };
          case 'limiteMensual':
            return { tipo: 'limiteReservas' };
          case 'ocupado':
          case 'slotInvalido':
            return { tipo: 'horarioOcupado' };
        }
        break;
      }

      case 'cancelarCita': {
        const cancelada = await cancelarCita(deps.repoCitas, peticion.tenantId, accion.citaId);
        await sesion.registrarEvento('cita.cancelada', { citaId: accion.citaId, cancelada });
        return null;
      }

      case 'confirmarAsistencia': {
        const confirmada = await deps.repoCitas.confirmarAsistencia(peticion.tenantId, accion.citaId);
        await sesion.registrarEvento('cita.confirmada', { citaId: accion.citaId, confirmada });
        return null;
      }
    }
    return null;
  }

  return async function procesarMensajeEntrante(trabajo: TrabajoMensajeEntrante): Promise<void> {
    const resultado = await deps.repo.enConversacionBloqueada(
      trabajo.tenantId,
      trabajo.conversacionId,
      async (sesion) => {
        /**
         * Derivada a una persona: el bot se calla. El mensaje ya quedó guardado y la
         * conversación está en la bandeja del panel; responder aquí sería exactamente el
         * bot que insiste después de haber admitido que no entiende.
         */
        if (sesion.conversacion.derivada) {
          await sesion.registrarEvento('mensaje.ignorado_por_derivacion', {
            waMessageId: trabajo.waMessageId,
          });
          return;
        }

        const mensaje = await sesion.leerMensaje(trabajo.waMessageId);
        if (mensaje === null) {
          deps.registro.warn({ waMessageId: trabajo.waMessageId }, 'mensaje encolado que ya no está');
          return;
        }

        const guardado = sesion.conversacion.estado;
        const estado: Estado = esEstado(guardado) ? guardado : 'INICIO';
        const contexto = (sesion.conversacion.contexto ?? {}) as Contexto;
        const peticion: PeticionCatalogo = {
          tenantId: trabajo.tenantId,
          contactoId: sesion.conversacion.contactoId,
          contexto,
        };

        let evento: Evento;
        if (sesion.conversacion.flowVersion !== deps.flowVersion) {
          // §4.5: el guion cambió bajo los pies de esta conversación.
          evento = { tipo: 'flujoActualizado' };
        } else if (sesion.conversacion.ventanaExpirada) {
          evento = { tipo: 'sesionExpirada' };
        } else if (estado === 'INICIO') {
          evento = { tipo: 'inicio' };
        } else {
          evento = await aEvento(mensaje, estado, peticion);
        }

        /**
         * Si el contacto ya tiene cita solo importa en unos pocos estados. Preguntarlo en
         * cada mensaje era una consulta a `citas` por turno para un dato que casi nunca
         * cambia la decisión.
         */
        async function entornoPara(estadoActual: Estado, eventoActual: Evento): Promise<Entorno> {
          const preguntasTriaje = await deps.catalogos.preguntasTriaje(
            trabajo.tenantId,
            contexto.materia,
          );
          if (!requiereCitaActiva(estadoActual, eventoActual)) return { preguntasTriaje };
          const activa = await deps.catalogos.citaActiva(peticion);
          return { preguntasTriaje, ...(activa === null ? {} : { citaActiva: activa }) };
        }

        const contenido = await deps.contenido(trabajo.tenantId);
        const mensajeria = await deps.mensajeria(trabajo.tenantId);

        let estadoActual = estado;
        let contextoActual = contexto;
        let fallosActual = sesion.conversacion.fallosConsecutivos;
        let eventoActual: Evento | null = evento;
        let estadoFinal = estado;

        /**
         * El turno puede dar más de una vuelta: confirmar emite `reservar`, y el resultado
         * de la reserva vuelve a la máquina como evento. El tope corta cualquier
         * realimentación inesperada en vez de dejar un bucle girando con la conversación
         * bloqueada.
         */
        for (let vuelta = 0; vuelta < MAX_VUELTAS && eventoActual !== null; vuelta++) {
          const siguiente = transicion(
            estadoActual,
            contextoActual,
            fallosActual,
            eventoActual,
            await entornoPara(estadoActual, eventoActual),
          );

          await sesion.guardar(siguiente.estado, siguiente.contexto, siguiente.fallosConsecutivos);
          estadoFinal = siguiente.estado;

          const peticionFinal = { ...peticion, contexto: siguiente.contexto };
          const datosTexto = await deps.catalogos.datosDeTexto(peticionFinal);

          let realimentacion: Evento | null = null;
          for (const accion of siguiente.acciones) {
            const devuelto = await ejecutar(accion, sesion, mensajeria, contenido, peticionFinal, datosTexto);
            if (devuelto !== null) realimentacion = devuelto;
          }

          estadoActual = siguiente.estado;
          contextoActual = siguiente.contexto;
          fallosActual = siguiente.fallosConsecutivos;
          eventoActual = realimentacion;
        }

        await sesion.renovarVentana();

        await sesion.registrarEvento('mensaje.procesado', {
          waMessageId: trabajo.waMessageId,
          estado: estadoFinal,
        });
      },
    );

    if (resultado === null) {
      deps.registro.warn({ conversacionId: trabajo.conversacionId }, 'conversacion inexistente');
    }
  };
}
