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
import { opcionesFijasDe, transicion, type Evento } from '../domain/conversacion/maquina.ts';
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
  flowVersion: number;
  registro: Registro;
}

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

  async function ejecutar(
    accion: Accion,
    sesion: SesionConversacion,
    mensajeria: Mensajeria,
    contenido: Contenido,
    peticion: PeticionCatalogo,
    datosTexto: Readonly<Record<string, string>>,
  ): Promise<void> {
    const waId = sesion.conversacion.waId;
    const texto = (clave: keyof Contenido['textos']) =>
      interpolar(contenido.textos[clave], datosTexto);

    switch (accion.tipo) {
      case 'texto':
        await mensajeria.enviarTexto(waId, texto(accion.clave));
        return;

      case 'audio': {
        const clave = contenido.audios[accion.clave];
        // Un despacho sin ese audio grabado simplemente no lo manda: el texto ya salió.
        if (clave !== undefined) await mensajeria.enviarAudio(waId, clave);
        return;
      }

      case 'lista': {
        const opciones = await deps.catalogos.opciones(accion.catalogo, peticion);
        if (opciones.length === 0) {
          // Sin opciones que ofrecer no se manda una lista vacía, que Meta rechaza.
          await mensajeria.enviarTexto(waId, texto('sinHorarios'));
          return;
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
        return;
      }

      case 'botones':
        await mensajeria.enviarBotones(waId, {
          cuerpo: texto(accion.clave),
          botones: accion.opciones.map((o) => ({ id: o.id, titulo: o.titulo })),
        });
        return;

      case 'formulario': {
        const flow = contenido.flowDatos;
        if (flow === undefined) {
          // El Flow se crea y publica en Meta (fase 0). Sin él no hay id que enviar.
          deps.registro.warn({ tenantId: peticion.tenantId }, 'despacho sin Flow de datos configurado');
          await mensajeria.enviarTexto(waId, texto(accion.clave));
          return;
        }
        await mensajeria.enviarFlow(waId, {
          flowId: flow.flowId,
          cta: flow.cta,
          cuerpo: texto(accion.clave),
          token: sesion.conversacion.id,
        });
        return;
      }

      case 'derivar':
        await sesion.derivar(accion.motivo);
        await sesion.registrarEvento('conversacion.derivada', { motivo: accion.motivo });
        return;

      case 'cerrarConversacion':
        await sesion.cerrar();
        return;

      case 'reservar':
      case 'cancelarCita':
        // Fase 4. Hasta entonces los catálogos de agenda vienen vacíos, así que el guion
        // no llega hasta aquí en producción; si llegara, se avisa en vez de callar.
        deps.registro.warn({ accion: accion.tipo }, 'accion de agenda todavía no implementada');
        return;
    }
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

        const citasActivas = await deps.catalogos.opciones('citasActivas', peticion);
        const primeraCita = citasActivas[0];
        const siguiente = transicion(estado, contexto, sesion.conversacion.fallosConsecutivos, evento, {
          preguntasTriaje: await deps.catalogos.preguntasTriaje(trabajo.tenantId, contexto.materia),
          tieneCitaActiva: citasActivas.length > 0,
          ...(primeraCita === undefined ? {} : { citaActivaId: primeraCita.id }),
        });

        await sesion.guardar(siguiente.estado, siguiente.contexto, siguiente.fallosConsecutivos);
        await sesion.renovarVentana();

        const contenido = await deps.contenido(trabajo.tenantId);
        const mensajeria = await deps.mensajeria(trabajo.tenantId);
        const peticionFinal = { ...peticion, contexto: siguiente.contexto };
        const datosTexto = await deps.catalogos.datosDeTexto(peticionFinal);
        for (const accion of siguiente.acciones) {
          await ejecutar(accion, sesion, mensajeria, contenido, peticionFinal, datosTexto);
        }

        await sesion.registrarEvento('mensaje.procesado', {
          waMessageId: trabajo.waMessageId,
          estado: siguiente.estado,
        });
      },
    );

    if (resultado === null) {
      deps.registro.warn({ conversacionId: trabajo.conversacionId }, 'conversacion inexistente');
    }
  };
}
