/**
 * La hoja de estilos del panel contra el HTML que se sirve.
 *
 * Las dos averías que prueba aquí no dan error en ninguna parte: la página se sirve con un
 * 200, el navegador no se queja y lo único que pasa es que el panel se ve mal.
 *
 *  - **Una clase que el HTML usa y la hoja no define.** Pasó con `.oculto` y con `.tenue`:
 *    la etiqueta del buscador quedó a la vista en medio de la pantalla.
 *  - **Dos reglas distintas con el mismo nombre de clase.** Pasó con `.barra`, que era a la
 *    vez la barra de navegación y la fila de la gráfica de abandono. Gana la última, y la
 *    navegación se convirtió en una rejilla de tres columnas que empujaba el nombre del
 *    usuario fuera de la pantalla.
 */
import { describe, expect, it } from 'vitest';
import { ESTILOS } from '../../src/adapters/http/panel/estilos.ts';
import {
  fichaContacto,
  formularioAgendar,
  pantallaAcceso,
  pantallaAlta,
  pantallaAltaHecha,
  pantallaAltaUsada,
  pantallaCalendarios,
  pantallaHoyManana,
  pantallaMetricas,
  resultadosBusqueda,
  avisoCancelada,
  filaAsistencia,
} from '../../src/adapters/http/panel/vistas.ts';

const BASE = '/panel/despacho-a';
/** La marca es por despacho (`tenants.marca`): ninguna pantalla la pone por su cuenta. */
const MARCA = 'Chatbot Prueba';
const AHORA = Date.parse('2026-09-16T14:00:00Z');
const hora = () => '09:00';
const fechaHora = () => '16 sep, 09:00';

const cita = (id: string, estado: string, nombre: string | null) => ({
  id,
  iniciaAt: new Date(AHORA - 3_600_000),
  terminaAt: new Date(AHORA),
  estado,
  materia: 'Divorcio',
  modalidad: 'presencial',
  honorarioUsd: '250.00',
  abogadoId: 'ab-1',
  abogadoNombre: 'Abg. Prueba',
  contactoId: `c-${id}`,
  contactoNombre: nombre,
  contactoWaId: '593998123456',
});

/** Con y sin nombre, empezada y por empezar: las cuatro filas posibles de la tabla. */
const DATOS = {
  dias: [
    { dia: '2026-09-16', etiqueta: 'Hoy', citas: [cita('a', 'atendida', 'Con Nombre'), cita('b', 'ausente', null)] },
    {
      dia: '2026-09-17',
      etiqueta: 'Mañana',
      citas: [{ ...cita('c', 'reservada', 'Futura'), iniciaAt: new Date(AHORA + 86_400_000) }],
    },
  ],
  bandeja: [
    {
      id: 'cv-1',
      contactoId: 'c-9',
      contactoNombre: 'Esperando',
      contactoWaId: '593991112233',
      estado: 'ELEGIR_HORA',
      motivo: 'tres_fallos',
      derivadaAt: new Date(AHORA),
      ultimoInboundAt: new Date(AHORA),
    },
  ],
};

/** El despacho que todavía no puso precios: la agenda no debe decir «$0». */
const SIN_PRECIOS = {
  dias: DATOS.dias.map((d) => ({
    ...d,
    citas: d.citas.map((c) => ({ ...c, honorarioUsd: '0.00' })),
  })),
  bandeja: [],
};

const INFORME = {
  desde: '17 ago',
  hasta: '16 sep',
  conversaciones: 184,
  conCita: 41,
  derivadas: 137,
  consultasListas: 129,
  atascadas: 8,
  citasMarcadas: 37,
  citasAusentes: 6,
  citasSinMarcar: 4,
  abandono: [{ estado: 'RELATO', total: 38 }],
  porcentajes: {
    citasPorCien: 22.3,
    consultasPorCien: 70.1,
    atascadasPorCien: 4.3,
    ausenciasPorCien: 16.2,
  },
  advertencias: ['Aviso de muestra.'],
};

const FICHA = {
  id: 'c-a',
  waId: '593998123456',
  nombre: 'Con Nombre',
  email: 'a@b.ec',
  cedula: '0102030405',
  consentAt: new Date(AHORA),
  consentRevocadoAt: null,
  bloqueado: false,
  citas: [{ id: 'x', iniciaAt: new Date(AHORA), estado: 'atendida', materia: 'Divorcio' }],
};

/** Todo lo que el panel llega a servir, incluidos los trozos que devuelve HTMX. */
async function todoElHtml(): Promise<string> {
  const piezas = [
    pantallaHoyManana(BASE, MARCA, DATOS as never, { hora, fechaHora }, 'Abg. Prueba'),
    pantallaHoyManana(BASE, MARCA, SIN_PRECIOS as never, { hora, fechaHora }, 'Abg. Prueba'),
    pantallaHoyManana(
      BASE,
      MARCA,
      { dias: [{ dia: 'd', etiqueta: 'Hoy', citas: [] }], bandeja: [] } as never,
      { hora, fechaHora },
      'Abg. Prueba',
    ),
    pantallaMetricas(BASE, MARCA, INFORME as never, 'Abg. Prueba'),
    pantallaMetricas(
      BASE,
      MARCA,
      {
        ...INFORME,
        abandono: [],
        porcentajes: {
          citasPorCien: null,
          consultasPorCien: null,
          atascadasPorCien: null,
          ausenciasPorCien: null,
        },
      } as never,
      'Abg. Prueba',
    ),
    pantallaCalendarios(
      BASE,
      MARCA,
      [
        { id: 'ab-1', nombre: 'Abg. Una', calendarId: 'una@estudio.ec' },
        { id: 'ab-2', nombre: 'Abg. Otra', calendarId: null },
      ] as never,
      'Abg. Prueba',
      'Un aviso.',
    ),
    pantallaAcceso(BASE, MARCA, 'Un mensaje.'),
    pantallaAlta(BASE, MARCA, 'tok', 'Abg. Prueba'),
    pantallaAltaUsada(BASE, MARCA),
    pantallaAltaHecha(BASE, MARCA),
    fichaContacto(BASE, FICHA as never, fechaHora),
    fichaContacto(BASE, { ...FICHA, bloqueado: true, nombre: null } as never, fechaHora),
    resultadosBusqueda(BASE, [{ id: 'c-1', nombre: 'Hallado', waId: '5939', proximaCitaAt: null }], 'hall', fechaHora),
    resultadosBusqueda(BASE, [], 'nadie', fechaHora),
    avisoCancelada(BASE, 'a', 10),
    formularioAgendar(BASE, {
      conversacionId: 'cv-1',
      contacto: 'Ana Pérez',
      modalidad: 'presencial',
      ventanaAbierta: true,
      dias: [{ id: '2026-10-20', titulo: 'martes 20 de octubre' }],
      diaElegido: '2026-10-20',
      horas: [{ id: 's-1', titulo: '09:00' }],
    }),
    formularioAgendar(
      BASE,
      {
        conversacionId: 'cv-2',
        contacto: '593990000000',
        modalidad: null,
        ventanaAbierta: false,
        dias: [{ id: '2026-10-20', titulo: 'martes 20 de octubre' }],
        diaElegido: '2026-10-20',
        horas: [],
      },
      'Ese horario se acaba de ocupar. Elija otro.',
    ),
    formularioAgendar(BASE, {
      conversacionId: 'cv-3',
      contacto: 'Sin huecos',
      modalidad: 'virtual',
      ventanaAbierta: true,
      dias: [],
      diaElegido: null,
      horas: [],
    }),
    filaAsistencia('a', true),
  ];
  return (await Promise.all(piezas)).map(String).join('\n');
}

interface Regla {
  selector: string;
  cuerpo: string;
  /** `false` para lo que vive dentro de un `@media`, que redefine a propósito lo de fuera. */
  raiz: boolean;
}

/** Un recorrido de llaves. Basta: la hoja no anida nada más que `@media`. */
function reglasDe(css: string, raiz = true): Regla[] {
  const reglas: Regla[] = [];

  let i = 0;
  while (i < css.length) {
    const abre = css.indexOf('{', i);
    if (abre === -1) break;
    const selector = css.slice(i, abre).trim();

    let profundidad = 1;
    let j = abre + 1;
    while (j < css.length && profundidad > 0) {
      if (css[j] === '{') profundidad += 1;
      if (css[j] === '}') profundidad -= 1;
      j += 1;
    }

    const cuerpo = css.slice(abre + 1, j - 1);
    if (selector.startsWith('@')) reglas.push(...reglasDe(cuerpo, false));
    else reglas.push({ selector, cuerpo, raiz });
    i = j;
  }

  return reglas;
}

const REGLAS = reglasDe(ESTILOS.replace(/\/\*[\s\S]*?\*\//g, ''));

describe('el honorario', () => {
  it('no enseña «$0» al despacho que aún no puso precios', async () => {
    // Cero no significa «gratis», significa «aún no lo hemos decidido». Enseñarlo es peor
    // que callarlo, porque parece un dato.
    const html = await todoElHtml();

    expect(html).not.toContain('$0');
    // Y el que sí tiene precio se sigue viendo.
    expect(html).toContain('$250');
  });
});

describe('la marca es la del despacho', () => {
  it('ninguna pantalla pone «Providencia» por su cuenta', async () => {
    // La marca vive en `tenants` y no en `tenant_config` porque la página de acceso tiene
    // que pintarla antes de que exista una sesión. Tenía valor por defecto en `pagina()`, y
    // por eso tres pantallas —entre ellas la de acceso— enseñaban «Providencia» a un
    // despacho con marca propia. Sin el valor por defecto, cada pantalla la exige.
    const html = await todoElHtml();

    expect(html).toContain(MARCA);
    expect(html).not.toContain('Providencia');
  });
});

describe('hoja de estilos del panel', () => {
  it('define toda clase que el HTML servido usa', async () => {
    const html = await todoElHtml();

    const usadas = new Set<string>();
    for (const coincidencia of html.matchAll(/class="([^"]*)"/g)) {
      for (const clase of (coincidencia[1] ?? '').split(/\s+/)) if (clase !== '') usadas.add(clase);
    }

    const definidas = new Set<string>();
    // Aquí cuentan también las de dentro de un `@media`: `.ocultable` solo existe en el
    // teléfono, y no por eso está sin definir.
    for (const { selector } of REGLAS) {
      for (const coincidencia of selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
        if (coincidencia[1] !== undefined) definidas.add(coincidencia[1]);
      }
    }

    // Una clase suelta en el HTML no da error: simplemente no pinta nada.
    expect([...usadas].filter((c) => !definidas.has(c))).toEqual([]);
    expect(usadas.size).toBeGreaterThan(20);
  });

  it('ninguna clase recibe `display` desde dos reglas distintas', () => {
    const porClase = new Map<string, string[]>();

    for (const { selector, cuerpo, raiz } of REGLAS) {
      if (!raiz) continue;
      // Solo las reglas de una clase a secas: `.pill.espera` redefine a `.pill` a propósito.
      const suelta = /^\.([a-zA-Z][\w-]*)$/.exec(selector.trim());
      if (suelta === null) continue;

      const display = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(cuerpo);
      if (display === null) continue;

      const previos = porClase.get(suelta[1]!) ?? [];
      previos.push(display[1]!.trim());
      porClase.set(suelta[1]!, previos);
    }

    const chocan = [...porClase.entries()].filter(([, valores]) => valores.length > 1);
    expect(chocan).toEqual([]);
  });
});
