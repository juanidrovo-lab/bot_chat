/**
 * Todo el texto de cara al usuario, por tenant. Nunca en línea en el código.
 *
 * Las reglas de §8 son propiedades de **estos** textos, no comprobaciones en tiempo de
 * ejecución, y hay un test que las verifica una por una sobre este catálogo:
 *
 *  - Usted, nunca tú. Es un estudio jurídico.
 *  - Máximo dos frases por turno. El usuario imita el registro del bot.
 *  - **Un solo texto lleva emoji**: la confirmación de la cita. Ningún otro.
 *  - Preguntas accionables, no de sí o no: lo accionable son los botones y la lista, así
 *    que el cuerpo informa y las opciones preguntan.
 *  - Prohibidas: «asistente virtual», «¿en qué puedo ayudarte?», «lo siento, no entendí»,
 *    «por favor intenta de nuevo».
 */
import type { ClaveTexto } from '../domain/conversacion/acciones.ts';
import { OPCION } from '../domain/conversacion/acciones.ts';

export interface Contenido {
  textos: Readonly<Record<ClaveTexto, string>>;
  /** Fila que se añade al menú para pedir una persona (§5). */
  filaPersona: { id: string; titulo: string };
  /** Clave del audio pregrabado que acompaña a cada texto, cuando lo hay. */
  audios: Readonly<Partial<Record<ClaveTexto, string>>>;
  /**
   * Flow estático de captura de datos. Se crea y publica en Meta (fase 0), así que hasta
   * que exista para el despacho no hay id que enviar.
   */
  flowDatos?: { flowId: string; cta: string };
}

const TEXTOS: Record<ClaveTexto, string> = {
  bienvenida:
    'Le saluda el canal de citas del Estudio {estudio}. Este chat es automático: le atiende un sistema, no una persona.',
  consentimiento:
    'Para agendar necesito guardar su nombre, su correo y su número, y usarlos solo para su cita. Indique si acepta ese uso de sus datos.',
  consentimientoRechazado:
    'Entendido, no guardaré sus datos. Puede llamar al estudio si prefiere agendar por teléfono.',
  menu: '¿Sobre qué materia es su consulta?',
  // El cuerpo del triaje es la pregunta que toca, que viene del catálogo por materia.
  triaje: '{pregunta}',
  tarifa: 'La consulta en {materia} cuesta {honorario} y dura 45 minutos.',
  citaExistente: 'Ya tiene una cita el {fecha}. Elija qué desea hacer con ella.',
  modalidad: '¿Prefiere la consulta presencial o virtual?',
  elegirDia: '¿Qué día le queda mejor?',
  elegirHora: '¿A qué hora el {fecha}?',
  pedirDatos: 'Complete sus datos para reservar el horario.',
  confirmar: 'Su cita quedaría el {fecha}, {modalidad}. Confirme para reservarla.',
  // El único texto del flujo con emoji.
  citaConfirmada: 'Su cita quedó el {fecha}, {modalidad}. Le recordaremos un día antes. ✅',
  horarioOcupado: 'Ese horario se acaba de ocupar. Elija otro de la lista.',
  sinHorarios:
    'No quedan horarios libres en los próximos días. Escriba «persona» y le contactará alguien del estudio.',
  limiteReservas:
    'Ya hizo varias reservas este mes. Escriba «persona» y alguien del estudio le atenderá directamente.',
  cancelada: 'Cancelé su cita del {fecha}. Si desea otra, escriba «menu».',
  asistenciaConfirmada: 'Confirmada su cita del {fecha}. Le esperamos.',
  cierreSinCita: 'Quedo a la orden. Si después desea agendar, escriba «menu».',
  despedida: 'Gracias por escribir. Si desea agendar, escriba «menu».',
  derivada: 'Le paso con una persona del estudio. Le escribirán por este mismo chat.',
  // Reparación escalonada: el primer aviso reformula, el segundo da un ejemplo concreto.
  reformular: 'Toque una de las opciones para continuar.',
  ejemplo: 'Toque una opción de la lista, o escriba su número: por ejemplo, 2.',
  soloTexto: 'Solo puedo leer texto y las opciones de la lista. Toque una opción para continuar.',
  notaDeVoz: 'No puedo escuchar notas de voz. Escríbame su respuesta o toque una opción.',
  sesionExpirada: 'Pasaron más de 24 horas, así que empezamos de nuevo.',
  flujoActualizado: 'Actualizamos el sistema de citas, volvamos a empezar.',
};

/**
 * Versión del texto de consentimiento.
 *
 * **Hay que subirla cada vez que cambie `consentimiento`.** Lo que se guarda en `contactos`
 * es a qué versión dijo que sí cada persona; si el texto cambia y la versión no, el registro
 * dice que aceptó algo que nunca leyó.
 */
export const VERSION_CONSENTIMIENTO = '1';

export const CONTENIDO_BASE: Contenido = {
  textos: TEXTOS,
  filaPersona: { id: OPCION.persona, titulo: 'Hablar con una persona' },
  audios: { bienvenida: 'bienvenida', tarifa: 'tarifa' },
};

/**
 * Las claves de audio que el guion puede pedir.
 *
 * `scripts/audios.ts` valida contra esta lista: un fichero con otro nombre se registraría
 * igual de bien y no lo mandaría nadie nunca, y ese fallo —un audio que simplemente no
 * suena— no deja ningún error que lo delate.
 */
export const CLAVES_DE_AUDIO: readonly string[] = Object.values(CONTENIDO_BASE.audios).filter(
  (clave): clave is string => clave !== undefined,
);

/**
 * Contenido de un despacho: el catálogo base con los textos que ese despacho reescriba.
 * Una clave que el tenant no toque se queda con el texto base, así que añadir una clave
 * nueva nunca deja a un cliente sin texto.
 */
export function contenidoDe(overrides: Partial<Record<ClaveTexto, string>> = {}): Contenido {
  return { ...CONTENIDO_BASE, textos: { ...TEXTOS, ...overrides } };
}

/** Sustituye `{clave}` por su valor. Una clave sin valor se deja tal cual, para que se vea. */
export function interpolar(plantilla: string, datos: Readonly<Record<string, string>> = {}): string {
  return plantilla.replace(/\{(\w+)\}/g, (original, clave: string) => datos[clave] ?? original);
}
