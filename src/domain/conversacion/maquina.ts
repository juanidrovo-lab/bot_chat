/**
 * La conversación, como reducer **puro** (§5).
 *
 * Ninguna llamada de red ni de base de datos adentro, y ninguna importación fuera de
 * `domain`. Recibe el estado y un evento ya normalizado, y devuelve el estado nuevo más
 * acciones declarativas que ejecuta el caso de uso. Así se prueba INICIO → CITA_OK entero
 * sin Docker, sin Meta y sin el modelo.
 *
 * Lo que NO decide esta máquina: qué horarios hay libres, cuánto cuesta la consulta, ni
 * cómo se redacta nada. Eso son catálogos y textos que rellena quien la ejecuta.
 */
import type { Accion, Catalogo, ClaveTexto, MotivoDerivacion, Opcion } from './acciones.ts';
import { OPCION } from './acciones.ts';
import type { Contexto, DatosContacto, Estado } from './estados.ts';
import { registrarFallo } from './reparacion.ts';

export type Evento =
  /** Primer mensaje de una conversación nueva. */
  | { tipo: 'inicio' }
  | { tipo: 'opcion'; id: string }
  | { tipo: 'formulario'; datos: DatosContacto }
  | { tipo: 'notaDeVoz' }
  | { tipo: 'noSoportado' }
  /** El clasificador no supo encajar el texto libre en la lista cerrada. */
  | { tipo: 'noEntendido' }
  | { tipo: 'sesionExpirada' }
  | { tipo: 'flujoActualizado' }
  /** Respuestas de la reserva, que ejecuta el caso de uso. */
  | { tipo: 'citaReservada' }
  | { tipo: 'horarioOcupado' }
  /** El contacto ya tenía una cita vigente: perdió la carrera contra otra conversación. */
  | { tipo: 'yaTieneCita' }
  /** Agotó el cupo de reservas del mes (§6). */
  | { tipo: 'limiteReservas' }
  /**
   * El despacho no tiene formulario de datos configurado, así que no hay forma de pedirlos.
   *
   * No es un fallo del usuario y no cuenta como tal: insistirle tres veces con un mensaje
   * que no puede satisfacer sería castigarle por algo que no depende de él.
   */
  | { tipo: 'sinFormulario' };

/**
 * La cita vigente del contacto, con lo que hace falta para moverla.
 *
 * Lleva `materia` y `modalidad` porque reagendar puede empezar sin contexto ninguno —desde
 * el botón de un recordatorio, en una conversación recién abierta— y sin ellas la reserva
 * no tendría con qué hacerse.
 */
export interface CitaActiva {
  id: string;
  materia: string;
  modalidad: 'presencial' | 'virtual';
}

export interface Entorno {
  /** Cuántas preguntas cerradas tiene el triaje de la materia elegida. */
  preguntasTriaje: number;
  citaActiva?: CitaActiva;
}

export interface Resultado {
  estado: Estado;
  contexto: Contexto;
  fallosConsecutivos: number;
  acciones: readonly Accion[];
}

const BOTONES_CONSENTIMIENTO: readonly Opcion[] = [
  { id: OPCION.acepto, titulo: 'Acepto' },
  { id: OPCION.noAcepto, titulo: 'No acepto' },
];

const BOTONES_TARIFA: readonly Opcion[] = [
  { id: OPCION.agendar, titulo: 'Agendar' },
  { id: OPCION.soloConsultaba, titulo: 'Era solo referencia' },
];

const BOTONES_MODALIDAD: readonly Opcion[] = [
  { id: OPCION.presencial, titulo: 'Presencial' },
  { id: OPCION.virtual, titulo: 'Virtual' },
];

const BOTONES_CONFIRMAR: readonly Opcion[] = [
  { id: OPCION.confirmar, titulo: 'Confirmar' },
  { id: OPCION.cambiar, titulo: 'Cambiar horario' },
];

const BOTONES_CITA_EXISTENTE: readonly Opcion[] = [
  { id: OPCION.reagendar, titulo: 'Reagendar' },
  { id: OPCION.cancelar, titulo: 'Cancelar' },
  { id: OPCION.menu, titulo: 'Volver al menú' },
];

/**
 * La pregunta de cada estado, en una sola acción.
 *
 * `clave` permite reemplazar el texto sin cambiar la pregunta: es lo que hace que un fallo
 * sea **un** mensaje —el aviso y las mismas opciones— en vez de dos.
 */
function preguntaDe(estado: Estado, clave?: ClaveTexto): readonly Accion[] {
  const lista = (catalogo: Catalogo, porDefecto: ClaveTexto): readonly Accion[] => [
    { tipo: 'lista', clave: clave ?? porDefecto, catalogo },
  ];
  const botones = (opciones: readonly Opcion[], porDefecto: ClaveTexto): readonly Accion[] => [
    { tipo: 'botones', clave: clave ?? porDefecto, opciones },
  ];

  switch (estado) {
    case 'CONSENTIMIENTO':
      return botones(BOTONES_CONSENTIMIENTO, 'consentimiento');
    case 'MENU':
      return lista('materias', 'menu');
    case 'TRIAJE':
      return lista('triaje', 'triaje');
    case 'TARIFA':
      return botones(BOTONES_TARIFA, 'tarifa');
    case 'CITA_EXISTENTE':
      return botones(BOTONES_CITA_EXISTENTE, 'citaExistente');
    case 'MODALIDAD':
      return botones(BOTONES_MODALIDAD, 'modalidad');
    case 'ELEGIR_DIA':
      return lista('dias', 'elegirDia');
    case 'ELEGIR_HORA':
      return lista('horas', 'elegirHora');
    case 'DATOS':
      return [{ tipo: 'formulario', clave: clave ?? 'pedirDatos' }];
    case 'CONFIRMAR':
      return botones(BOTONES_CONFIRMAR, 'confirmar');
    case 'CANCELAR_CITA':
      return lista('citasActivas', 'cancelada');
    default:
      return [];
  }
}

/**
 * Copia el contexto sembrándolo con la cita vigente.
 *
 * Sembrar `materia` y `modalidad` es lo que hace posible reagendar: sin ellas, el flujo
 * llegaba a CONFIRMAR sin modalidad, la reserva no se podía hacer y el usuario volvía a
 * elegir hora una y otra vez.
 */
function conCitaActiva(contexto: Contexto, cita: CitaActiva | undefined): Contexto {
  if (cita === undefined) return contexto;
  return { ...contexto, citaActivaId: cita.id, materia: cita.materia, modalidad: cita.modalidad };
}

function derivar(contexto: Contexto, motivo: MotivoDerivacion): Resultado {
  return {
    estado: 'DERIVADA',
    contexto,
    fallosConsecutivos: 0,
    acciones: [{ tipo: 'derivar', motivo }, { tipo: 'texto', clave: 'derivada' }],
  };
}

function alMenu(clave?: ClaveTexto): Resultado {
  return {
    estado: 'MENU',
    contexto: {},
    fallosConsecutivos: 0,
    acciones: clave === undefined
      ? preguntaDe('MENU')
      : [{ tipo: 'texto', clave }, ...preguntaDe('MENU')],
  };
}

/** Avanza a un estado nuevo: el contador de fallos se reinicia porque hubo entendimiento. */
function avanzar(estado: Estado, contexto: Contexto, acciones?: readonly Accion[]): Resultado {
  return {
    estado,
    contexto,
    fallosConsecutivos: 0,
    acciones: acciones ?? preguntaDe(estado),
  };
}

/** Reparación escalonada (§8): reformular, ejemplo, y a la tercera una persona. */
function fallar(
  estado: Estado,
  contexto: Contexto,
  fallosPrevios: number,
  claveEspecifica?: ClaveTexto,
): Resultado {
  const reparacion = registrarFallo(fallosPrevios);
  if (reparacion.tipo === 'derivar') return derivar(contexto, 'tres_fallos');

  const clave = claveEspecifica ?? (reparacion.tipo === 'ejemplo' ? 'ejemplo' : 'reformular');
  return {
    estado,
    contexto,
    fallosConsecutivos: reparacion.fallos,
    acciones: preguntaDe(estado, clave),
  };
}

export function transicion(
  estado: Estado,
  contexto: Contexto,
  fallosConsecutivos: number,
  evento: Evento,
  entorno: Entorno,
): Resultado {
  // ---- Eventos que mandan sobre cualquier estado -------------------------------------
  switch (evento.tipo) {
    case 'sesionExpirada':
      // Pasadas 24 h se cerró la ventana de servicio: se empieza de nuevo, no se falla.
      return alMenu('sesionExpirada');
    case 'flujoActualizado':
      // §4.5: el guion cambió bajo los pies de esta conversación. Reinicio limpio.
      return alMenu('flujoActualizado');
    case 'inicio':
      return avanzar('CONSENTIMIENTO', contexto, [
        { tipo: 'texto', clave: 'bienvenida' },
        { tipo: 'audio', clave: 'bienvenida' },
        ...preguntaDe('CONSENTIMIENTO'),
      ]);
    default:
      break;
  }

  // ---- Intents globales (§5) ----------------------------------------------------------
  if (evento.tipo === 'opcion') {
    if (evento.id === OPCION.persona) return derivar(contexto, 'peticion_usuario');
    if (evento.id === OPCION.menu) return alMenu();
    if (evento.id === OPCION.cancelar && estado !== 'CITA_EXISTENTE') {
      return entorno.citaActiva !== undefined
        ? avanzar('CANCELAR_CITA', conCitaActiva(contexto, entorno.citaActiva))
        : alMenu();
    }

    /**
     * Botones del recordatorio. Llegan en una conversación recién abierta —la anterior se
     * cerró al confirmar la cita—, así que tienen que valer como intents globales o el
     * usuario acabaría recibiendo el saludo de bienvenida en respuesta a «cancelar».
     */
    if (evento.id === OPCION.confirmarAsistencia) {
      const cita = entorno.citaActiva;
      if (cita === undefined) return alMenu();
      return {
        estado: 'CIERRE_SIN_CITA',
        contexto,
        fallosConsecutivos: 0,
        acciones: [
          { tipo: 'confirmarAsistencia', citaId: cita.id },
          { tipo: 'texto', clave: 'asistenciaConfirmada' },
          { tipo: 'cerrarConversacion' },
        ],
      };
    }

    if (evento.id === OPCION.reagendar && estado !== 'CITA_EXISTENTE') {
      return entorno.citaActiva !== undefined
        ? avanzar('ELEGIR_DIA', conCitaActiva(contexto, entorno.citaActiva))
        : alMenu();
    }
  }

  // ---- Entradas que no son una respuesta válida ---------------------------------------
  if (evento.tipo === 'notaDeVoz') return fallar(estado, contexto, fallosConsecutivos, 'notaDeVoz');
  if (evento.tipo === 'noSoportado') return fallar(estado, contexto, fallosConsecutivos, 'soloTexto');
  if (evento.tipo === 'noEntendido') return fallar(estado, contexto, fallosConsecutivos);

  // ---- Resultado de la reserva --------------------------------------------------------
  if (evento.tipo === 'citaReservada') {
    return {
      estado: 'CITA_OK',
      contexto,
      fallosConsecutivos: 0,
      acciones: [{ tipo: 'texto', clave: 'citaConfirmada' }, { tipo: 'cerrarConversacion' }],
    };
  }
  if (evento.tipo === 'horarioOcupado') {
    // El índice único ganó la carrera: se recalculan horarios y se vuelve a preguntar.
    return avanzar('ELEGIR_HORA', contexto, preguntaDe('ELEGIR_HORA', 'horarioOcupado'));
  }
  if (evento.tipo === 'yaTieneCita') {
    // `citas_una_activa_por_contacto` rechazó la inserción: se ofrece qué hacer con la que
    // ya tiene en vez de dejar al usuario con un error.
    return avanzar('CITA_EXISTENTE', conCitaActiva(contexto, entorno.citaActiva));
  }
  /**
   * Sin formulario no hay forma de recoger nombre y cédula, y el guion no puede continuar.
   * Se deriva en el acto en vez de dejar que el usuario falle tres veces contra una puerta
   * cerrada: lo que le pasa no es culpa suya, y una persona sí puede terminarlo.
   */
  if (evento.tipo === 'sinFormulario') return derivar(contexto, 'error_sistema');

  if (evento.tipo === 'limiteReservas') {
    return {
      estado: 'CIERRE_SIN_CITA',
      contexto,
      fallosConsecutivos: 0,
      acciones: [{ tipo: 'texto', clave: 'limiteReservas' }, { tipo: 'cerrarConversacion' }],
    };
  }

  // ---- Transiciones por estado --------------------------------------------------------
  switch (estado) {
    case 'INICIO':
      return avanzar('CONSENTIMIENTO', contexto, [
        { tipo: 'texto', clave: 'bienvenida' },
        { tipo: 'audio', clave: 'bienvenida' },
        ...preguntaDe('CONSENTIMIENTO'),
      ]);

    case 'CONSENTIMIENTO':
      if (evento.tipo === 'opcion' && evento.id === OPCION.acepto) {
        const menu = alMenu();
        return { ...menu, acciones: [{ tipo: 'consentimiento', aceptado: true }, ...menu.acciones] };
      }
      if (evento.tipo === 'opcion' && evento.id === OPCION.noAcepto) {
        return {
          estado: 'DESPEDIDA',
          contexto,
          fallosConsecutivos: 0,
          acciones: [
            // También se registra el «no»: la prueba de que se preguntó y de cuándo vale
            // tanto como la del «sí».
            { tipo: 'consentimiento', aceptado: false },
            { tipo: 'texto', clave: 'consentimientoRechazado' },
            { tipo: 'cerrarConversacion' },
          ],
        };
      }
      return fallar(estado, contexto, fallosConsecutivos);

    case 'MENU':
      if (evento.tipo === 'opcion') {
        const siguiente: Contexto = { ...contexto, materia: evento.id, triaje: [] };
        // Una materia sin preguntas de triaje salta directa al honorario.
        return entorno.preguntasTriaje === 0
          ? avanzar('TARIFA', siguiente)
          : avanzar('TRIAJE', siguiente);
      }
      return fallar(estado, contexto, fallosConsecutivos);

    case 'TRIAJE': {
      if (evento.tipo !== 'opcion') return fallar(estado, contexto, fallosConsecutivos);
      const respuestas = [...(contexto.triaje ?? []), evento.id];
      const siguiente: Contexto = { ...contexto, triaje: respuestas };
      return respuestas.length >= entorno.preguntasTriaje
        ? avanzar('TARIFA', siguiente)
        : avanzar('TRIAJE', siguiente);
    }

    case 'TARIFA':
      if (evento.tipo === 'opcion' && evento.id === OPCION.agendar) {
        // Máximo una cita activa por contacto (§6): si ya tiene, se ofrece qué hacer.
        return entorno.citaActiva !== undefined
          ? avanzar('CITA_EXISTENTE', conCitaActiva(contexto, entorno.citaActiva))
          : avanzar('MODALIDAD', contexto);
      }
      if (evento.tipo === 'opcion' && evento.id === OPCION.soloConsultaba) {
        return {
          estado: 'CIERRE_SIN_CITA',
          contexto,
          fallosConsecutivos: 0,
          acciones: [{ tipo: 'texto', clave: 'cierreSinCita' }, { tipo: 'cerrarConversacion' }],
        };
      }
      return fallar(estado, contexto, fallosConsecutivos);

    case 'CITA_EXISTENTE':
      if (evento.tipo === 'opcion' && evento.id === OPCION.reagendar) {
        // Reagendar es cancelar y volver a reservar: la cancelación la hace la reserva,
        // en la misma transacción, para no dejar al contacto sin cita si algo falla.
        // El contexto se siembra con la materia y la modalidad de la cita que se mueve:
        // llegar aquí desde TARIFA significa que MODALIDAD nunca se preguntó.
        return avanzar('ELEGIR_DIA', conCitaActiva(contexto, entorno.citaActiva));
      }
      if (evento.tipo === 'opcion' && evento.id === OPCION.cancelar) {
        const citaId = contexto.citaActivaId ?? entorno.citaActiva?.id;
        if (citaId === undefined) return alMenu();
        return {
          estado: 'CIERRE_SIN_CITA',
          contexto,
          fallosConsecutivos: 0,
          acciones: [
            { tipo: 'cancelarCita', citaId },
            { tipo: 'texto', clave: 'cancelada' },
            { tipo: 'cerrarConversacion' },
          ],
        };
      }
      return fallar(estado, contexto, fallosConsecutivos);

    case 'MODALIDAD':
      if (evento.tipo === 'opcion' && (evento.id === OPCION.presencial || evento.id === OPCION.virtual)) {
        return avanzar('ELEGIR_DIA', { ...contexto, modalidad: evento.id });
      }
      return fallar(estado, contexto, fallosConsecutivos);

    case 'ELEGIR_DIA':
      if (evento.tipo === 'opcion') return avanzar('ELEGIR_HORA', { ...contexto, dia: evento.id });
      return fallar(estado, contexto, fallosConsecutivos);

    case 'ELEGIR_HORA':
      if (evento.tipo === 'opcion') return avanzar('DATOS', { ...contexto, slotId: evento.id });
      return fallar(estado, contexto, fallosConsecutivos);

    case 'DATOS':
      if (evento.tipo === 'formulario') {
        return avanzar('CONFIRMAR', { ...contexto, datos: evento.datos });
      }
      return fallar(estado, contexto, fallosConsecutivos);

    case 'CONFIRMAR':
      if (evento.tipo === 'opcion' && evento.id === OPCION.confirmar) {
        const datos = contexto.datos;
        if (datos === undefined) return avanzar('DATOS', contexto);
        // No se pasa a CITA_OK todavía: la reserva puede perder la carrera por el horario.
        // El caso de uso ejecuta `reservar` y devuelve `citaReservada` u `horarioOcupado`.
        return { estado: 'CONFIRMAR', contexto, fallosConsecutivos: 0, acciones: [{ tipo: 'reservar', datos }] };
      }
      if (evento.tipo === 'opcion' && evento.id === OPCION.cambiar) {
        return avanzar('ELEGIR_DIA', contexto);
      }
      return fallar(estado, contexto, fallosConsecutivos);

    case 'CANCELAR_CITA':
      if (evento.tipo === 'opcion') {
        return {
          estado: 'CIERRE_SIN_CITA',
          contexto,
          fallosConsecutivos: 0,
          acciones: [
            { tipo: 'cancelarCita', citaId: evento.id },
            { tipo: 'texto', clave: 'cancelada' },
            { tipo: 'cerrarConversacion' },
          ],
        };
      }
      return fallar(estado, contexto, fallosConsecutivos);

    default:
      // Estados terminales: la conversación quedó cerrada y un mensaje nuevo abre otra.
      return alMenu();
  }
}

/**
 * Estados y eventos en los que la transición consulta si el contacto ya tiene cita.
 *
 * Existe para no pagar una consulta a `citas` en cada mensaje: la inmensa mayoría de los
 * turnos no la necesita, y el caso de uso solo la pide cuando de verdad cambia la decisión.
 */
export function requiereCitaActiva(estado: Estado, evento: Evento): boolean {
  if (evento.tipo === 'opcion') {
    const conCita: readonly string[] = [
      OPCION.cancelar,
      OPCION.reagendar,
      OPCION.confirmarAsistencia,
    ];
    if (conCita.includes(evento.id)) return true;
  }
  if (evento.tipo === 'yaTieneCita') return true;
  return estado === 'TARIFA' || estado === 'CITA_EXISTENTE' || estado === 'CANCELAR_CITA';
}

/**
 * Lista cerrada que espera cada estado, para que el clasificador nunca pueda devolver algo
 * que la máquina no sepa encajar. Los estados cuyas opciones son variables (horarios,
 * materias) las reciben del catálogo, así que aquí solo van las fijas.
 */
export function opcionesFijasDe(estado: Estado): readonly string[] {
  switch (estado) {
    case 'CONSENTIMIENTO':
      return [OPCION.acepto, OPCION.noAcepto];
    case 'TARIFA':
      return [OPCION.agendar, OPCION.soloConsultaba];
    case 'MODALIDAD':
      return [OPCION.presencial, OPCION.virtual];
    case 'CONFIRMAR':
      return [OPCION.confirmar, OPCION.cambiar];
    case 'CITA_EXISTENTE':
      return [OPCION.reagendar, OPCION.cancelar, OPCION.menu];
    default:
      return [];
  }
}
