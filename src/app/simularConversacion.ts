/**
 * El guion, ejecutado sin WhatsApp: lo que el panel enseña como demostración.
 *
 * **Es la máquina de verdad, no una imitación.** `domain/conversacion/maquina.ts` es una
 * función pura, así que se puede correr aquí con los textos del despacho y su agenda real, y
 * lo que se ve en pantalla es literalmente lo que el contacto recibiría por WhatsApp. Una
 * maqueta aparte sería una segunda copia del guion con una segunda forma de desincronizarse,
 * y el día que divergieran la demostración enseñaría un bot que no existe.
 *
 * **No escribe nada.** El estado de la conversación viaja en la petición —la máquina es
 * pura, así que cabe— y no hay fila en `conversaciones`, ni en `citas`, ni en `mensajes`. No
 * es por prudencia: una demostración que escribiera contaminaría las métricas del panel con
 * conversaciones que nunca existieron, y el informe del mes dejaría de ser cierto.
 *
 * Lo único que se finge es lo que no se puede hacer sin escribir: la reserva. Donde el bot
 * real inserta la cita y espera a ver si gana la carrera por el horario, aquí se responde
 * que sí y se dice en pantalla que esa parte es simulada.
 */
import type { Accion, Opcion } from '../domain/conversacion/acciones.ts';
import type { Contexto, DatosContacto, Estado } from '../domain/conversacion/estados.ts';
import { transicion, type Entorno, type Evento } from '../domain/conversacion/maquina.ts';
import { interpolar, type Contenido } from './content.ts';
import type { Catalogos, PeticionCatalogo } from './puertos/Catalogos.ts';

/** Un contacto que no existe. El simulador no toca `contactos` ni `citas`. */
const CONTACTO_NULO = '00000000-0000-0000-0000-000000000000';

/** Tope de vueltas, igual que en el turno real: corta cualquier realimentación inesperada. */
const MAX_VUELTAS = 6;

export type MensajeSimulado =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'audio'; clave: string }
  | { tipo: 'ubicacion'; direccion: string; latitud: number; longitud: number }
  | { tipo: 'imagen'; imagen: string; pie: string }
  /** Lo que pasaría por detrás y el contacto no ve. En la demostración sí se enseña. */
  | { tipo: 'nota'; texto: string };

export type Controles =
  | { tipo: 'botones'; opciones: readonly Opcion[] }
  | { tipo: 'lista'; opciones: readonly Opcion[] }
  | { tipo: 'formulario' }
  | { tipo: 'ninguno' };

export interface Paso {
  estado: Estado;
  contexto: Contexto;
  fallos: number;
  mensajes: readonly MensajeSimulado[];
  controles: Controles;
  /** La conversación terminó: el panel ofrece empezar de nuevo. */
  cerrada: boolean;
  /** Quedó esperando a una persona. En el bot real, aparece en la bandeja. */
  derivada: boolean;
}

export interface DependenciasSimulador {
  catalogos: Catalogos;
  contenido: (tenantId: string) => Promise<Contenido>;
}

export interface Peticion {
  tenantId: string;
  estado: Estado;
  contexto: Contexto;
  fallos: number;
  evento: Evento;
}

/**
 * Da un paso del guion y devuelve lo que se vería.
 *
 * El bucle es el mismo del turno real y por el mismo motivo: confirmar emite `reservar`, y
 * el resultado de la reserva vuelve a la máquina como un evento nuevo.
 */
export async function simularPaso(
  deps: DependenciasSimulador,
  peticion: Peticion,
): Promise<Paso> {
  const contenido = await deps.contenido(peticion.tenantId);

  let estado = peticion.estado;
  let contexto = peticion.contexto;
  let fallos = peticion.fallos;
  let evento: Evento | null = peticion.evento;

  const mensajes: MensajeSimulado[] = [];
  let controles: Controles = { tipo: 'ninguno' };
  let cerrada = false;
  let derivada = false;

  for (let vuelta = 0; vuelta < MAX_VUELTAS && evento !== null; vuelta += 1) {
    const pet = (ctx: Contexto): PeticionCatalogo => ({
      tenantId: peticion.tenantId,
      contactoId: CONTACTO_NULO,
      contexto: ctx,
    });

    const entorno: Entorno = {
      preguntasTriaje: await deps.catalogos.preguntasTriaje(peticion.tenantId, contexto.materia),
      /**
       * `citaActiva` se deja siempre vacía: el contacto es el uuid nulo y no tiene citas.
       * Es lo correcto para una demostración —se enseña el camino limpio— y además evita
       * que la agenda real de un contacto de verdad se cuele en la pantalla.
       */
      ...(estado === 'MENU'
        ? await materiaPorDefecto(deps, peticion.tenantId)
        : {}),
    };

    const resultado = transicion(estado, contexto, fallos, evento, entorno);
    estado = resultado.estado;
    contexto = resultado.contexto;
    fallos = resultado.fallosConsecutivos;
    evento = null;

    const datos = await deps.catalogos.datosDeTexto(pet(contexto));

    for (const accion of resultado.acciones) {
      const siguiente = await pintar(accion, {
        deps,
        tenantId: peticion.tenantId,
        contexto,
        contenido,
        datos,
        mensajes,
        peticion: pet(contexto),
      });
      if (siguiente.controles !== undefined) controles = siguiente.controles;
      if (siguiente.cerrada === true) cerrada = true;
      if (siguiente.derivada === true) derivada = true;
      if (siguiente.evento !== undefined) evento = siguiente.evento;
    }
  }

  return { estado, contexto, fallos, mensajes, controles, cerrada, derivada };
}

async function materiaPorDefecto(
  deps: DependenciasSimulador,
  tenantId: string,
): Promise<{ materiaPorDefecto?: string }> {
  const materia = await deps.catalogos.materiaPorDefecto(tenantId);
  return materia === null ? {} : { materiaPorDefecto: materia };
}

interface Contexto2 {
  deps: DependenciasSimulador;
  tenantId: string;
  contexto: Contexto;
  contenido: Contenido;
  datos: Readonly<Record<string, string>>;
  mensajes: MensajeSimulado[];
  peticion: PeticionCatalogo;
}

interface Efecto {
  controles?: Controles;
  cerrada?: boolean;
  derivada?: boolean;
  evento?: Evento;
}

/** Traduce una acción a lo que se ve. Es el equivalente del ejecutor del turno real. */
async function pintar(accion: Accion, c: Contexto2): Promise<Efecto> {
  const decir = (clave: keyof Contenido['textos']): string =>
    interpolar(c.contenido.textos[clave], c.datos);

  switch (accion.tipo) {
    case 'texto':
      c.mensajes.push({ tipo: 'texto', texto: decir(accion.clave) });
      return {};

    case 'audio': {
      const clave = c.contenido.audios[accion.clave];
      if (clave === undefined) return {};
      c.mensajes.push({ tipo: 'audio', clave });
      return {};
    }

    case 'botones':
      c.mensajes.push({ tipo: 'texto', texto: decir(accion.clave) });
      return { controles: { tipo: 'botones', opciones: accion.opciones } };

    case 'lista': {
      const opciones = await c.deps.catalogos.opciones(accion.catalogo, c.peticion);
      if (opciones.length === 0) {
        // Igual que el bot real: sin nada que ofrecer no se manda una lista vacía.
        c.mensajes.push({ tipo: 'texto', texto: decir('sinHorarios') });
        return { controles: { tipo: 'ninguno' } };
      }
      c.mensajes.push({ tipo: 'texto', texto: decir(accion.clave) });
      const filas = opciones.map((o) => ({ id: o.id, titulo: o.titulo }));
      if (accion.catalogo === 'materias') filas.push(c.contenido.filaPersona);
      return { controles: { tipo: 'lista', opciones: filas } };
    }

    case 'ubicacion': {
      const oficina = c.contenido.oficina;
      // Sin oficina configurada el bot real no manda nada; aquí tampoco se inventa un punto.
      if (oficina === undefined) {
        c.mensajes.push({
          tipo: 'nota',
          texto: 'Este despacho no tiene oficina configurada, así que no se envía ubicación.',
        });
        return {};
      }
      c.mensajes.push({
        tipo: 'ubicacion',
        direccion: oficina.direccion,
        latitud: oficina.latitud,
        longitud: oficina.longitud,
      });
      return {};
    }

    case 'imagen': {
      const imagen = c.contenido.imagenDeposito;
      if (imagen === undefined) {
        c.mensajes.push({
          tipo: 'nota',
          texto: 'Este despacho no tiene registrada la imagen de la cuenta, así que no se envía.',
        });
        return {};
      }
      c.mensajes.push({ tipo: 'imagen', imagen, pie: decir(accion.clave) });
      return {};
    }

    case 'formulario':
      if (c.contenido.flowDatos === undefined) {
        // Mismo desenlace que en el bot real: sin Flow no hay forma de pedir los datos.
        c.mensajes.push({
          tipo: 'nota',
          texto:
            'Sin el formulario de Meta publicado, el bot no puede pedir los datos y deriva a una persona.',
        });
        return { evento: { tipo: 'sinFormulario' } };
      }
      c.mensajes.push({ tipo: 'texto', texto: decir(accion.clave) });
      return { controles: { tipo: 'formulario' } };

    case 'consentimiento':
      c.mensajes.push({
        tipo: 'nota',
        texto: accion.aceptado
          ? 'Queda registrado el consentimiento, con la versión del texto que se mostró.'
          : 'Queda registrado el rechazo: la prueba de que se preguntó vale igual.',
      });
      return {};

    case 'derivar':
      c.mensajes.push({
        tipo: 'nota',
        texto: 'La conversación pasa a la bandeja del panel y el bot se calla.',
      });
      return { derivada: true, controles: { tipo: 'ninguno' } };

    case 'reservar':
      /**
       * Lo único que se finge. El bot real inserta la cita y el índice único decide si gana
       * la carrera por el horario; aquí no se escribe nada, así que se responde que sí.
       */
      c.mensajes.push({
        tipo: 'nota',
        texto: 'Aquí el bot reserva la cita. En esta demostración no se guarda nada.',
      });
      return { evento: { tipo: 'citaReservada' } };

    case 'cancelarCita':
    case 'confirmarAsistencia':
      c.mensajes.push({ tipo: 'nota', texto: 'Aquí el bot actualizaría la cita en la base.' });
      return {};

    case 'cerrarConversacion':
      return { cerrada: true, controles: { tipo: 'ninguno' } };
  }
}

/** Los datos que el formulario del simulador entrega, con la misma forma que el Flow. */
export function datosDePrueba(nombre: string, email: string, cedula?: string): DatosContacto {
  return { nombre, email, ...(cedula === undefined || cedula === '' ? {} : { cedula }) };
}

/** El evento con el que arranca una conversación nueva. */
export const EVENTO_INICIAL: Evento = { tipo: 'inicio' };
