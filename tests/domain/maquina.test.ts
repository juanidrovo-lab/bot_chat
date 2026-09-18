import { describe, expect, it } from 'vitest';
import { OPCION } from '../../src/domain/conversacion/acciones.ts';
import type { Contexto, Estado } from '../../src/domain/conversacion/estados.ts';
import {
  requiereCitaActiva,
  transicion,
  type Entorno,
  type Evento,
} from '../../src/domain/conversacion/maquina.ts';

const SIN_CITA: Entorno = { preguntasTriaje: 1 };

/** Hilo de conversación: mantiene estado, contexto y fallos entre eventos. */
function conversacion(inicial: Estado = 'INICIO', entorno: Entorno = SIN_CITA) {
  let estado = inicial;
  let contexto: Contexto = {};
  let fallos = 0;
  let ultimas: readonly { tipo: string }[] = [];

  return {
    enviar(evento: Evento, entornoDelTurno: Entorno = entorno) {
      const r = transicion(estado, contexto, fallos, evento, entornoDelTurno);
      estado = r.estado;
      contexto = r.contexto;
      fallos = r.fallosConsecutivos;
      ultimas = r.acciones;
      return r;
    },
    get estado() { return estado; },
    get contexto() { return contexto; },
    get fallos() { return fallos; },
    get acciones() { return ultimas; },
  };
}

const opcion = (id: string): Evento => ({ tipo: 'opcion', id });

describe('máquina · el recorrido completo', () => {
  it('va de INICIO a CITA_OK sin red, sin Docker y sin el modelo', () => {
    const c = conversacion();

    c.enviar({ tipo: 'inicio' });
    expect(c.estado).toBe('CONSENTIMIENTO');
    expect(c.acciones.map((a) => a.tipo)).toEqual(['texto', 'audio', 'botones']);

    c.enviar(opcion(OPCION.acepto));
    expect(c.estado).toBe('MENU');

    // Dos opciones y ninguna materia que elegir: el menú pregunta si quiere cita.
    c.enviar(opcion(OPCION.agendar));
    expect(c.estado).toBe('MODALIDAD');

    const presencial = c.enviar(opcion(OPCION.presencial));
    expect(c.estado).toBe('ELEGIR_DIA');
    expect(c.contexto.modalidad).toBe('presencial');
    // La ubicación va ANTES de elegir horario: enterarse de dónde queda la oficina cuando
    // ya reservó es enterarse cuando ya no puede cambiar de idea.
    expect(presencial.acciones.map((a) => a.tipo)).toEqual(['texto', 'ubicacion', 'lista']);

    c.enviar(opcion('2026-09-22'));
    expect(c.estado).toBe('ELEGIR_HORA');

    c.enviar(opcion('2026-09-22T14:00:00.000Z'));
    expect(c.estado).toBe('DATOS');

    c.enviar({ tipo: 'formulario', datos: { nombre: 'Ana Pérez', email: 'ana@ejemplo.ec' } });
    expect(c.estado).toBe('CONFIRMAR');

    // Confirmar no lleva directo a CITA_OK: la reserva puede perder la carrera.
    const pendiente = c.enviar(opcion(OPCION.confirmar));
    expect(pendiente.estado).toBe('CONFIRMAR');
    expect(pendiente.acciones).toEqual([
      { tipo: 'reservar', datos: { nombre: 'Ana Pérez', email: 'ana@ejemplo.ec' } },
    ]);

    const final = c.enviar({ tipo: 'citaReservada' });
    expect(final.estado).toBe('CITA_OK');
    // La cuenta del depósito va DESPUÉS de reservar: cobrar antes dejaría el horario suelto
    // mientras alguien revisa el comprobante, y se lo llevaría otro.
    expect(final.acciones).toEqual([
      { tipo: 'texto', clave: 'citaConfirmada' },
      { tipo: 'imagen', clave: 'deposito', imagen: 'deposito' },
      { tipo: 'cerrarConversacion' },
    ]);
  });

  it('la consulta virtual no agenda nada: deriva para que una persona llame', () => {
    const c = conversacion('MODALIDAD');

    const r = c.enviar(opcion(OPCION.virtual));

    // Prometer que el abogado escribe en media hora solo se puede si la conversación queda
    // en la bandeja de alguien. Un mensaje que promete y no avisa a nadie es una mentira.
    expect(r.estado).toBe('DERIVADA');
    expect(r.acciones).toEqual([
      { tipo: 'derivar', motivo: 'peticion_usuario' },
      { tipo: 'texto', clave: 'consultaVirtual' },
    ]);
    expect(r.contexto.modalidad).toBe('virtual');
  });

  it('la segunda opción del menú no la contesta el bot: la atiende una persona', () => {
    const c = conversacion('MENU');

    const r = c.enviar(opcion(OPCION.otraConsulta));

    expect(r.estado).toBe('DERIVADA');
    expect(r.acciones[0]).toEqual({ tipo: 'derivar', motivo: 'peticion_usuario' });
  });

  it('quien ya tiene cita no llega a elegir modalidad: se le ofrece qué hacer con la suya', () => {
    const c = conversacion('MENU', {
      preguntasTriaje: 0,
      citaActiva: { id: 'cita-1', materia: 'consulta', modalidad: 'presencial' },
    });

    // `citas_una_activa_por_contacto` lo rechazaría igual, pero enterarse al final —después
    // de elegir día, hora y datos— es hacerle perder el tiempo a propósito.
    const r = c.enviar(opcion(OPCION.agendar));

    expect(r.estado).toBe('CITA_EXISTENTE');
    expect(r.contexto.citaActivaId).toBe('cita-1');
  });

  it('si el horario se ocupa, vuelve a preguntar la hora con el aviso', () => {
    const c = conversacion('CONFIRMAR');
    const r = c.enviar({ tipo: 'horarioOcupado' });
    expect(r.estado).toBe('ELEGIR_HORA');
    expect(r.acciones).toEqual([{ tipo: 'lista', clave: 'horarioOcupado', catalogo: 'horas' }]);
  });
});

describe('máquina · reparación escalonada', () => {
  it('al tercer fallo consecutivo deriva a una persona, sin cuarto intento', () => {
    const c = conversacion('MENU');

    const primero = c.enviar({ tipo: 'noEntendido' });
    expect(primero.acciones).toMatchObject([{ tipo: 'botones', clave: 'reformular' }]);
    expect(c.fallos).toBe(1);

    const segundo = c.enviar({ tipo: 'noEntendido' });
    expect(segundo.acciones).toMatchObject([{ tipo: 'botones', clave: 'ejemplo' }]);
    expect(c.fallos).toBe(2);

    const tercero = c.enviar({ tipo: 'noEntendido' });
    expect(tercero.estado).toBe('DERIVADA');
    expect(tercero.acciones).toEqual([
      { tipo: 'derivar', motivo: 'tres_fallos' },
      { tipo: 'texto', clave: 'derivada' },
    ]);
  });

  it('un fallo es UN mensaje: el aviso va en el cuerpo de la misma pregunta', () => {
    const c = conversacion('MODALIDAD');
    const r = c.enviar({ tipo: 'noEntendido' });
    expect(r.acciones).toHaveLength(1);
    expect(r.acciones[0]).toMatchObject({ tipo: 'botones', clave: 'reformular' });
  });

  it('acertar reinicia el contador: tres fallos son consecutivos, no acumulados', () => {
    const c = conversacion('MENU');
    c.enviar({ tipo: 'noEntendido' });
    c.enviar({ tipo: 'noEntendido' });
    expect(c.fallos).toBe(2);

    c.enviar(opcion(OPCION.agendar));
    expect(c.fallos).toBe(0);

    c.enviar({ tipo: 'noEntendido' });
    expect(c.estado).toBe('MODALIDAD');
    expect(c.fallos).toBe(1);
  });

  it('una nota de voz y un tipo no soportado avisan de lo suyo, y también cuentan', () => {
    const c = conversacion('MENU');
    expect(c.enviar({ tipo: 'notaDeVoz' }).acciones[0]).toMatchObject({ clave: 'notaDeVoz' });
    expect(c.fallos).toBe(1);
    expect(c.enviar({ tipo: 'noSoportado' }).acciones[0]).toMatchObject({ clave: 'soloTexto' });
    expect(c.fallos).toBe(2);
    expect(c.enviar({ tipo: 'notaDeVoz' }).estado).toBe('DERIVADA');
  });
});

describe('máquina · intents globales', () => {
  it('pedir una persona deriva desde cualquier estado', () => {
    for (const estado of ['MENU', 'TRIAJE', 'ELEGIR_HORA', 'CONFIRMAR'] as Estado[]) {
      const r = transicion(estado, {}, 0, opcion(OPCION.persona), SIN_CITA);
      expect(r.estado).toBe('DERIVADA');
      expect(r.acciones[0]).toEqual({ tipo: 'derivar', motivo: 'peticion_usuario' });
    }
  });

  it('volver al menú limpia el contexto a medio llenar', () => {
    const c = conversacion('ELEGIR_HORA');
    c.enviar(opcion(OPCION.menu));
    expect(c.estado).toBe('MENU');
    expect(c.contexto).toEqual({});
  });

  it('cancelar sin cita activa lleva al menú, no a un callejón', () => {
    const r = transicion('MENU', {}, 0, opcion(OPCION.cancelar), SIN_CITA);
    expect(r.estado).toBe('MENU');
  });

  it('cancelar con cita activa ofrece la lista de citas', () => {
    const r = transicion('MENU', {}, 0, opcion(OPCION.cancelar), {
      preguntasTriaje: 0,
      citaActiva: { id: 'cita-1', materia: 'laboral', modalidad: 'presencial' },
    });
    expect(r.estado).toBe('CANCELAR_CITA');
    expect(r.contexto.citaActivaId).toBe('cita-1');
  });
});

describe('máquina · cita ya existente', () => {
  const conCita: Entorno = {
    preguntasTriaje: 0,
    citaActiva: { id: 'cita-1', materia: 'laboral', modalidad: 'virtual' },
  };

  it('quien ya tiene cita no llega a elegir modalidad', () => {
    const r = transicion('TARIFA', {}, 0, opcion(OPCION.agendar), conCita);
    expect(r.estado).toBe('CITA_EXISTENTE');
  });

  it('reagendar siembra materia y modalidad de la cita que se mueve', () => {
    // Sin esto la reserva llegaba a CONFIRMAR sin modalidad, fallaba, y el guion devolvía
    // al usuario a elegir hora una y otra vez: un bucle sin salida.
    const r = transicion('CITA_EXISTENTE', { citaActivaId: 'cita-1' }, 0, opcion(OPCION.reagendar), conCita);
    expect(r.estado).toBe('ELEGIR_DIA');
    expect(r.contexto).toMatchObject({
      citaActivaId: 'cita-1',
      materia: 'laboral',
      modalidad: 'virtual',
    });
  });

  it('cancelar emite la acción de cancelar esa cita concreta', () => {
    const r = transicion('CITA_EXISTENTE', { citaActivaId: 'cita-1' }, 0, opcion(OPCION.cancelar), conCita);
    expect(r.acciones[0]).toEqual({ tipo: 'cancelarCita', citaId: 'cita-1' });
    expect(r.acciones.at(-1)).toEqual({ tipo: 'cerrarConversacion' });
  });
});

describe('máquina · botones del recordatorio', () => {
  // Llegan en una conversación recién abierta: la anterior se cerró al confirmar la cita.
  const conCita: Entorno = {
    preguntasTriaje: 1,
    citaActiva: { id: 'cita-1', materia: 'laboral', modalidad: 'presencial' },
  };

  it('confirmar asistencia marca la cita y cierra, sin pasar por el saludo', () => {
    const r = transicion('MENU', {}, 0, opcion(OPCION.confirmarAsistencia), conCita);
    expect(r.acciones[0]).toEqual({ tipo: 'confirmarAsistencia', citaId: 'cita-1' });
    expect(r.acciones.at(-1)).toEqual({ tipo: 'cerrarConversacion' });
  });

  it('cancelar desde el recordatorio lleva a la lista de citas', () => {
    const r = transicion('MENU', {}, 0, opcion(OPCION.cancelar), conCita);
    expect(r.estado).toBe('CANCELAR_CITA');
    expect(r.contexto.citaActivaId).toBe('cita-1');
  });

  it('reagendar desde el recordatorio arranca con materia y modalidad ya sabidas', () => {
    const r = transicion('MENU', {}, 0, opcion(OPCION.reagendar), conCita);
    expect(r.estado).toBe('ELEGIR_DIA');
    expect(r.contexto).toMatchObject({ materia: 'laboral', modalidad: 'presencial' });
  });

  it('si la cita ya no existe, los botones viejos llevan al menú y no a un error', () => {
    // El recordatorio se quedó en el chat y el usuario lo toca una semana después.
    for (const id of [OPCION.confirmarAsistencia, OPCION.reagendar, OPCION.cancelar]) {
      const r = transicion('MENU', {}, 0, opcion(id), { preguntasTriaje: 1 });
      expect(r.estado, id).toBe('MENU');
    }
  });

  it('el estado de la máquina decide si hace falta consultar la cita vigente', () => {
    // Consultarla en cada mensaje sería una consulta a `citas` por turno para un dato que
    // casi nunca cambia la decisión.
    expect(requiereCitaActiva('MENU', opcion(OPCION.reagendar))).toBe(true);
    expect(requiereCitaActiva('MENU', opcion(OPCION.confirmarAsistencia))).toBe(true);
    expect(requiereCitaActiva('TARIFA', { tipo: 'noEntendido' })).toBe(true);
    expect(requiereCitaActiva('CONSENTIMIENTO', opcion('acepto'))).toBe(false);
    expect(requiereCitaActiva('ELEGIR_HORA', opcion('x'))).toBe(false);
  });
});

describe('máquina · reinicios', () => {
  it('la ventana vencida empieza de nuevo, no falla', () => {
    const c = conversacion('ELEGIR_HORA');
    c.enviar({ tipo: 'noEntendido' });
    const r = c.enviar({ tipo: 'sesionExpirada' });

    expect(r.estado).toBe('MENU');
    expect(r.fallosConsecutivos).toBe(0);
    expect(r.acciones[0]).toEqual({ tipo: 'texto', clave: 'sesionExpirada' });
  });

  it('un guion nuevo reinicia limpiamente en vez de colgarse', () => {
    const r = transicion('ELEGIR_HORA', { materia: 'laboral' }, 2, { tipo: 'flujoActualizado' }, SIN_CITA);
    expect(r.estado).toBe('MENU');
    expect(r.contexto).toEqual({});
    expect(r.acciones[0]).toEqual({ tipo: 'texto', clave: 'flujoActualizado' });
  });

  it('no aceptar el tratamiento de datos cierra la conversación', () => {
    const r = transicion('CONSENTIMIENTO', {}, 0, opcion(OPCION.noAcepto), SIN_CITA);
    expect(r.estado).toBe('DESPEDIDA');
    expect(r.acciones.at(-1)).toEqual({ tipo: 'cerrarConversacion' });
  });
});

describe('despacho sin formulario de datos', () => {
  it('deriva en el acto, sin gastar los tres intentos del usuario', () => {
    // Antes esto mandaba el texto y esperaba una respuesta de formulario que no iba a
    // llegar: el usuario fallaba tres veces contra una puerta cerrada, se llevaba dos
    // mensajes de reproche, y acababa derivado igual.
    const r = transicion('DATOS', { materia: 'laboral' }, 0, { tipo: 'sinFormulario' }, SIN_CITA);

    expect(r.estado).toBe('DERIVADA');
    expect(r.acciones.map((a) => a.tipo)).toEqual(['derivar', 'texto']);
  });

  it('el motivo es del sistema, no del usuario', () => {
    const r = transicion('DATOS', {}, 2, { tipo: 'sinFormulario' }, SIN_CITA);

    expect(r.acciones.find((a) => a.tipo === 'derivar')).toMatchObject({
      motivo: 'error_sistema',
    });
    // Y no arrastra los fallos previos: lo que pasó no fue culpa de quien escribía.
    expect(r.fallosConsecutivos).toBe(0);
  });
});

describe('consentimiento', () => {
  it('aceptar deja constancia antes de seguir al menú', () => {
    const r = transicion('CONSENTIMIENTO', {}, 0, opcion(OPCION.acepto), SIN_CITA);

    // Primero el registro y después el resto: si el turno se cortara a la mitad, lo que
    // tiene que haber quedado es la prueba de que dijo que sí.
    expect(r.acciones[0]).toEqual({ tipo: 'consentimiento', aceptado: true });
    expect(r.estado).toBe('MENU');
  });

  it('rechazar también se registra: la prueba de que se preguntó vale igual', () => {
    const r = transicion('CONSENTIMIENTO', {}, 0, opcion(OPCION.noAcepto), SIN_CITA);

    expect(r.acciones[0]).toEqual({ tipo: 'consentimiento', aceptado: false });
    expect(r.acciones.map((a) => a.tipo)).toContain('cerrarConversacion');
  });

  it('una respuesta que no es ni sí ni no no registra nada', () => {
    const r = transicion('CONSENTIMIENTO', {}, 0, { tipo: 'noEntendido' }, SIN_CITA);

    expect(r.acciones.some((a) => a.tipo === 'consentimiento')).toBe(false);
  });
});
