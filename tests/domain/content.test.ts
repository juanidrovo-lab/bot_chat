import { describe, expect, it } from 'vitest';
import { CONTENIDO_BASE, contenidoDe, interpolar } from '../../src/app/content.ts';
import { CLAVES_TEXTO } from '../../src/domain/conversacion/acciones.ts';
import { LIMITES } from '../../src/adapters/whatsapp/limites.ts';
import { transicion, type Entorno } from '../../src/domain/conversacion/maquina.ts';
import type { Estado } from '../../src/domain/conversacion/estados.ts';

const TEXTOS = Object.entries(CONTENIDO_BASE.textos);

/** Frases de verdad: fragmentos con al menos una letra. El emoji suelto no cuenta. */
function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.!?])\s+/)
    .map((f) => f.trim())
    .filter((f) => /\p{L}/u.test(f));
}

describe('content · reglas de estilo (§8)', () => {
  it('hay texto para todas las claves que emite la máquina, y ninguno de más', () => {
    expect(Object.keys(CONTENIDO_BASE.textos).sort()).toEqual([...CLAVES_TEXTO].sort());
  });

  it('ninguno usa las frases prohibidas', () => {
    const prohibidas = [
      'asistente virtual',
      'en qué puedo ayudarte',
      'lo siento, no entendí',
      'por favor intenta de nuevo',
    ];
    for (const [clave, texto] of TEXTOS) {
      const normalizado = texto.toLowerCase();
      for (const frase of prohibidas) {
        expect(normalizado, `«${clave}» contiene «${frase}»`).not.toContain(frase);
      }
    }
  });

  it('todos tratan de usted, ninguno tutea', () => {
    // Formas de tú que se colarían por descuido; las de usted son las simétricas
    // (puede, tiene, escriba, toque, elija, complete, indique, confirme).
    const tuteo =
      /\b(tú|ti|tuyo|tuya|contigo|tu|tus|puedes|tienes|quieres|necesitas|deseas|escribe|escríbeme|toca|elige|indica|completa|confirma|dime)\b/i;

    // El detector se comprueba a sí mismo: un test que no puede fallar no prueba nada.
    for (const muestra of ['¿Puedes confirmar tu cita?', 'Escribe el número', 'Elige una opción']) {
      expect(tuteo.test(muestra), `el detector no caza «${muestra}»`).toBe(true);
    }

    for (const [clave, texto] of TEXTOS) {
      expect(tuteo.test(texto), `«${clave}» tutea: ${texto}`).toBe(false);
    }
  });

  it('ninguno pasa de dos frases', () => {
    for (const [clave, texto] of TEXTOS) {
      expect(frases(texto).length, `«${clave}» tiene ${frases(texto).length} frases`).toBeLessThanOrEqual(2);
    }
  });

  it('solo la confirmación de la cita lleva emoji, y lleva exactamente uno', () => {
    expect(/\p{Extended_Pictographic}/u.test('hola ✅')).toBe(true);
    const conEmoji = TEXTOS.filter(([, texto]) => /\p{Extended_Pictographic}/u.test(texto));
    expect(conEmoji.map(([clave]) => clave)).toEqual(['citaConfirmada']);

    const emojis = CONTENIDO_BASE.textos.citaConfirmada.match(/\p{Extended_Pictographic}/gu) ?? [];
    expect(emojis).toHaveLength(1);
  });

  it('la fila para pedir una persona cabe en una lista de WhatsApp', () => {
    expect(Array.from(CONTENIDO_BASE.filaPersona.titulo).length).toBeLessThanOrEqual(LIMITES.tituloFila);
  });
});

describe('content · por tenant', () => {
  it('un despacho puede reescribir un texto sin perder los demás', () => {
    const propio = contenidoDe({ menu: '¿En qué materia le ayudamos?' });
    expect(propio.textos.menu).toBe('¿En qué materia le ayudamos?');
    expect(propio.textos.derivada).toBe(CONTENIDO_BASE.textos.derivada);
  });

  it('una clave nueva nunca deja a un despacho sin texto', () => {
    const propio = contenidoDe({ menu: 'otro' });
    for (const clave of CLAVES_TEXTO) {
      expect(propio.textos[clave], `falta «${clave}»`).toBeTruthy();
    }
  });
});

describe('content · interpolación', () => {
  it('sustituye lo que conoce', () => {
    expect(interpolar('La consulta en {materia} cuesta {honorario}.', { materia: 'Laboral', honorario: 'USD 40' }))
      .toBe('La consulta en Laboral cuesta USD 40.');
  });

  it('deja visible lo que falta, en vez de escribir «undefined»', () => {
    expect(interpolar('Su cita el {fecha}.', {})).toBe('Su cita el {fecha}.');
  });
});

describe('opciones · límites de WhatsApp', () => {
  const ENTORNO: Entorno = { preguntasTriaje: 1, tieneCitaActiva: true, citaActivaId: 'c1' };

  it('ningún grupo de botones pasa de tres, ni ningún título de veinte caracteres', () => {
    const estados: Estado[] = [
      'INICIO', 'CONSENTIMIENTO', 'MENU', 'TRIAJE', 'TARIFA',
      'CITA_EXISTENTE', 'MODALIDAD', 'ELEGIR_DIA', 'ELEGIR_HORA', 'DATOS', 'CONFIRMAR',
    ];

    for (const estado of estados) {
      const { acciones } = transicion(estado, {}, 0, { tipo: 'noEntendido' }, ENTORNO);
      for (const accion of acciones) {
        if (accion.tipo !== 'botones') continue;
        expect(accion.opciones.length, `${estado} manda ${accion.opciones.length} botones`)
          .toBeLessThanOrEqual(LIMITES.botones);
        for (const opcion of accion.opciones) {
          expect(Array.from(opcion.titulo).length, `«${opcion.titulo}» en ${estado}`)
            .toBeLessThanOrEqual(LIMITES.textoBoton);
        }
      }
    }
  });
});
