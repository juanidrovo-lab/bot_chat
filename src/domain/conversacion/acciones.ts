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
  'elegirDia',
  'elegirHora',
  'pedirDatos',
  'confirmar',
  'citaConfirmada',
  'horarioOcupado',
  'sinHorarios',
  'limiteReservas',
  'cancelada',
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
  /** Lista interactiva cuyo contenido rellena el caso de uso desde el catálogo. */
  | { tipo: 'lista'; clave: ClaveTexto; catalogo: Catalogo }
  | { tipo: 'botones'; clave: ClaveTexto; opciones: readonly Opcion[] }
  /** Flow estático de captura de datos (§8). */
  | { tipo: 'formulario'; clave: ClaveTexto }
  | { tipo: 'derivar'; motivo: MotivoDerivacion }
  | { tipo: 'reservar'; datos: DatosContacto }
  | { tipo: 'cancelarCita'; citaId: string }
  | { tipo: 'cerrarConversacion' };

/** Identificadores de las opciones fijas. Los variables (horarios) los pone el catálogo. */
export const OPCION = {
  acepto: 'acepto',
  noAcepto: 'no_acepto',
  persona: 'persona',
  agendar: 'agendar',
  soloConsultaba: 'solo_consultaba',
  presencial: 'presencial',
  virtual: 'virtual',
  confirmar: 'confirmar',
  cambiar: 'cambiar',
  reagendar: 'reagendar',
  cancelar: 'cancelar',
  menu: 'menu',
} as const;
