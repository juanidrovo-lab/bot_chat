/**
 * El simulador del panel.
 *
 * Lo que importa probar no es que pinte bonito, sino las dos propiedades que lo hacen
 * honesto: que ejecute **la máquina de verdad** —de modo que el flujo nuevo aparezca aquí
 * sin tocar nada— y que **no escriba**: si la demostración guardara conversaciones, el
 * informe del mes del propio panel dejaría de ser cierto.
 */
import { describe, expect, it } from 'vitest';
import { CONTENIDO_BASE, contenidoDe } from '../../src/app/content.ts';
import { OPCION } from '../../src/domain/conversacion/acciones.ts';
import { simularPaso, type DependenciasSimulador } from '../../src/app/simularConversacion.ts';
import type { Catalogos, PeticionCatalogo } from '../../src/app/puertos/Catalogos.ts';

const TENANT = 'despacho-a';

const OFICINA = { direccion: 'Av. Solano 1-23, Cuenca', latitud: -2.9, longitud: -79 };

function entorno(opciones: { sinOficina?: boolean; sinFlow?: boolean; sinImagen?: boolean } = {}) {
  /** Qué se le pidió al catálogo, y con qué contacto. */
  const pedidos: { catalogo: string; contactoId: string }[] = [];

  const catalogos: Catalogos = {
    async opciones(catalogo, peticion: PeticionCatalogo) {
      pedidos.push({ catalogo, contactoId: peticion.contactoId });
      if (catalogo === 'dias') return [{ id: '2026-09-21', titulo: 'lunes 21' }];
      if (catalogo === 'horas') return [{ id: 'slot-1', titulo: '09:00' }];
      return [];
    },
    async preguntasTriaje() {
      return 0;
    },
    async materiaPorDefecto() {
      return 'consulta';
    },
    async citaActiva() {
      return null;
    },
    async datosDeTexto() {
      return {
        estudio: 'Aseleb',
        abogado: 'el Abg. Darío Bermejo',
        direccion: OFICINA.direccion,
        honorario: 'USD 40.00',
        fecha: 'lunes 21 de septiembre, 09:00',
        modalidad: 'presencial',
      };
    },
  };

  const contenido = contenidoDe();
  if (opciones.sinOficina !== true) contenido.oficina = OFICINA;
  if (opciones.sinFlow !== true) contenido.flowDatos = { flowId: 'f-1', cta: 'Completar' };
  if (opciones.sinImagen !== true) contenido.imagenDeposito = 'deposito';

  const deps: DependenciasSimulador = { catalogos, contenido: async () => contenido };
  return { deps, pedidos };
}

/** Recorre el guion paso a paso, arrastrando el estado como hace el formulario del panel. */
async function recorrer(deps: DependenciasSimulador, ids: readonly string[]) {
  let paso = await simularPaso(deps, {
    tenantId: TENANT,
    estado: 'INICIO',
    contexto: {},
    fallos: 0,
    evento: { tipo: 'inicio' },
  });
  const todos = [...paso.mensajes];

  for (const id of ids) {
    paso = await simularPaso(deps, {
      tenantId: TENANT,
      estado: paso.estado,
      contexto: paso.contexto,
      fallos: paso.fallos,
      evento:
        id === '__formulario'
          ? { tipo: 'formulario', datos: { nombre: 'Ana Pérez', email: 'ana@ejemplo.ec' } }
          : { tipo: 'opcion', id },
    });
    todos.push(...paso.mensajes);
  }

  return { paso, todos };
}

const PRESENCIAL = [
  OPCION.acepto,
  OPCION.agendar,
  OPCION.presencial,
  '2026-09-21',
  'slot-1',
  '__formulario',
  OPCION.confirmar,
];

describe('simulador · el guion completo', () => {
  it('la cita presencial llega hasta la cuenta del depósito', async () => {
    const { deps } = entorno();

    const { paso, todos } = await recorrer(deps, PRESENCIAL);

    const tipos = todos.map((m) => m.tipo);
    // La ubicación antes de elegir horario; la cuenta después de confirmar.
    expect(tipos).toContain('ubicacion');
    expect(tipos.lastIndexOf('imagen')).toBe(tipos.length - 1);
    expect(paso.estado).toBe('CITA_OK');
    expect(paso.cerrada).toBe(true);

    const imagen = todos.at(-1);
    expect(imagen).toMatchObject({ tipo: 'imagen', imagen: 'deposito' });
    // El pie lleva el honorario interpolado, no la plantilla.
    expect((imagen as { pie: string }).pie).toContain('USD 40.00');
  });

  it('la consulta virtual no agenda: queda esperando a una persona', async () => {
    const { deps } = entorno();

    const { paso, todos } = await recorrer(deps, [OPCION.acepto, OPCION.agendar, OPCION.virtual]);

    expect(paso.derivada).toBe(true);
    expect(paso.estado).toBe('DERIVADA');
    expect(todos.some((m) => m.tipo === 'texto' && m.texto.includes('Darío Bermejo'))).toBe(true);
    // No llegó a ofrecer días ni horas.
    expect(todos.some((m) => m.tipo === 'ubicacion')).toBe(false);
  });

  it('nunca consulta el catálogo con un contacto real', async () => {
    const { deps, pedidos } = entorno();

    await recorrer(deps, PRESENCIAL);

    // El uuid nulo es lo que garantiza que la demostración no lee ni escribe la agenda de
    // nadie: si algún día se colara un contacto de verdad, sus citas saldrían en pantalla.
    expect(pedidos.length).toBeGreaterThan(0);
    for (const p of pedidos) {
      expect(p.contactoId).toBe('00000000-0000-0000-0000-000000000000');
    }
  });

  it('el menú son dos botones, y ninguno es «sí» ni «no»', async () => {
    const { deps } = entorno();

    const { paso } = await recorrer(deps, [OPCION.acepto]);

    expect(paso.controles.tipo).toBe('botones');
    const titulos =
      paso.controles.tipo === 'botones' ? paso.controles.opciones.map((o) => o.titulo) : [];
    expect(titulos).toHaveLength(2);
    // §8: preguntas accionables. Un botón que dice «Sí» obliga a releer el cuerpo.
    for (const t of titulos) expect(['Sí', 'No']).not.toContain(t);
  });
});

describe('simulador · lo que falta configurar se dice, no se inventa', () => {
  it('sin oficina no manda una ubicación cualquiera: lo avisa', async () => {
    const { deps } = entorno({ sinOficina: true });

    const { todos } = await recorrer(deps, [OPCION.acepto, OPCION.agendar, OPCION.presencial]);

    expect(todos.some((m) => m.tipo === 'ubicacion')).toBe(false);
    expect(todos.some((m) => m.tipo === 'nota' && m.texto.includes('oficina'))).toBe(true);
  });

  it('sin el formulario de Meta, deriva — igual que el bot real', async () => {
    const { deps } = entorno({ sinFlow: true });

    const { paso } = await recorrer(deps, [
      OPCION.acepto,
      OPCION.agendar,
      OPCION.presencial,
      '2026-09-21',
      'slot-1',
    ]);

    // Sin Flow no hay forma de pedir nombre y cédula: se deriva en el acto en vez de dejar
    // al usuario fallar tres veces contra una puerta cerrada.
    expect(paso.estado).toBe('DERIVADA');
    expect(paso.derivada).toBe(true);
  });

  it('sin la imagen registrada, la cita se confirma igual', async () => {
    const { deps } = entorno({ sinImagen: true });

    const { paso, todos } = await recorrer(deps, PRESENCIAL);

    // La cita es lo que importa; la cuenta es un mensaje que falta, no una avería.
    expect(paso.estado).toBe('CITA_OK');
    expect(todos.some((m) => m.tipo === 'imagen')).toBe(false);
    expect(todos.some((m) => m.tipo === 'nota' && m.texto.includes('cuenta'))).toBe(true);
  });

  it('todas las claves de texto que el simulador pinta existen en el catálogo', () => {
    // Un texto que no existiera saldría como `undefined` en pantalla, sin error en ninguna
    // parte. El catálogo es exhaustivo por tipo, pero esto lo fija también para el guion nuevo.
    for (const clave of ['ubicacion', 'consultaVirtual', 'deposito'] as const) {
      expect(CONTENIDO_BASE.textos[clave]).toBeTruthy();
    }
  });
});
