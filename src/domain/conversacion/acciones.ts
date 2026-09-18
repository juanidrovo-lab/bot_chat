import type { DatosContacto } from './estados.ts';

/**
 * Claves de los textos de cara al usuario. El dominio decide QUÉ se dice; `content.ts`
 * decide CÓMO, por tenant. Por eso aquí solo viajan claves y datos, nunca frases.
 */
export const CLAVES_TEXTO = [
  'bienvenida',
  'consentimiento',
  'consentimientoRechazado',
  'menu',
  'triaje',
  'tarifa',
  'citaExistente',
  'modalidad',
  /** Dónde queda la oficina. Acompaña al punto en el mapa, no lo sustituye. */
  'ubicacion',
  /** La consulta virtual no se agenda: el abogado llama. */
  'consultaVirtual',
  /** Pie de la imagen con la cuenta bancaria, después de reservar. */
  'deposito',
  'elegirDia',
  'elegirHora',
  'pedirDatos',
  'confirmar',
  'citaConfirmada',
  'horarioOcupado',
  'sinHorarios',
  'limiteReservas',
  'cancelada',
  'asistenciaConfirmada',
  'cierreSinCita',
  'despedida',
  'derivada',
  'reformular',
  'ejemplo',
  'soloTexto',
  'notaDeVoz',
  'sesionExpirada',
  'flujoActualizado',
] as const;

export type ClaveTexto = (typeof CLAVES_TEXTO)[number];

/** Catálogos que rellena el caso de uso: el dominio no sabe qué horarios hay libres. */
export type Catalogo = 'materias' | 'triaje' | 'dias' | 'horas' | 'citasActivas';

export interface Opcion {
  id: string;
  titulo: string;
}

export type MotivoDerivacion = 'peticion_usuario' | 'tres_fallos' | 'error_sistema';

/**
 * Acciones declarativas. La máquina no envía nada: describe lo que hay que hacer y el caso
 * de uso lo ejecuta. Así la conversación entera se testea sin red, sin Docker y sin Meta.
 */
export type Accion =
  | { tipo: 'texto'; clave: ClaveTexto }
  | { tipo: 'audio'; clave: ClaveTexto }
  /**
   * Deja constancia de que el contacto aceptó —o rechazó— el tratamiento de sus datos.
   *
   * Es la obligación central de la LOPDP en este sistema: se le pregunta, responde, y tiene
   * que quedar registrado **con la versión del texto que vio**. Sin eso, el estudio no puede
   * demostrar nada el día que un titular o la autoridad lo pregunten.
   */
  | { tipo: 'consentimiento'; aceptado: boolean }
  /** Lista interactiva cuyo contenido rellena el caso de uso desde el catálogo. */
  | { tipo: 'lista'; clave: ClaveTexto; catalogo: Catalogo }
  | { tipo: 'botones'; clave: ClaveTexto; opciones: readonly Opcion[] }
  /** Flow estático de captura de datos (§8). */
  | { tipo: 'formulario'; clave: ClaveTexto }
  /**
   * El punto de la oficina en el mapa. Va como mensaje aparte del texto porque en WhatsApp
   * una ubicación no lleva cuerpo: el texto explica y el punto se toca para abrir el mapa.
   *
   * Las coordenadas y la dirección son del despacho, así que las pone el caso de uso: el
   * dominio no sabe dónde está ninguna oficina.
   */
  | { tipo: 'ubicacion'; clave: ClaveTexto }
  /**
   * Una imagen del despacho con su pie de texto — hoy, la cuenta para el depósito.
   *
   * `clave` es el pie; `imagen` es qué imagen, y el caso de uso la canjea por un `media_id`
   * vigente igual que hace con los audios. Mandar la clave a Meta es un rechazo silencioso.
   */
  | { tipo: 'imagen'; clave: ClaveTexto; imagen: string }
  | { tipo: 'derivar'; motivo: MotivoDerivacion }
  | { tipo: 'reservar'; datos: DatosContacto }
  | { tipo: 'cancelarCita'; citaId: string }
  /** El contacto confirmó que asistirá, desde el botón del recordatorio. */
  | { tipo: 'confirmarAsistencia'; citaId: string }
  | { tipo: 'cerrarConversacion' };

/** Identificadores de las opciones fijas. Los variables (horarios) los pone el catálogo. */
export const OPCION = {
  acepto: 'acepto',
  noAcepto: 'no_acepto',
  persona: 'persona',
  agendar: 'agendar',
  soloConsultaba: 'solo_consultaba',
  /** La segunda opción del menú: no quiere cita, quiere preguntar algo. */
  otraConsulta: 'otra_consulta',
  presencial: 'presencial',
  virtual: 'virtual',
  confirmar: 'confirmar',
  cambiar: 'cambiar',
  reagendar: 'reagendar',
  cancelar: 'cancelar',
  /** Botón del recordatorio: distinto de `confirmar`, que confirma una reserva nueva. */
  confirmarAsistencia: 'confirmar_asistencia',
  menu: 'menu',
} as const;
