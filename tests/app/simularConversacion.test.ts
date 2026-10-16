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

const OFICINA = { direccion: 'Av. Solano 1-23, Cuenca', punto: { latitud: -2.9, longitud: -79 } };

function entorno(
  opciones: { sinOficina?: boolean; sinPunto?: boolean; sinFlow?: boolean; sinImagen?: boolean } = {},
) {
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
        abogado: 'el Abg. Darío Bermeo',
        direccion: OFICINA.direccion,
        honorario: 'USD 40.00',
        fecha: 'lunes 21 de septiembre, 09:00',
        modalidad: 'presencial',
      };
    },
  };

  const contenido = contenidoDe();
  if (opciones.sinOficina !== true) {
    contenido.oficina = opciones.sinPunto === true ? { direccion: OFICINA.direccion } : OFICINA;
  }
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
        id === '__texto'
          ? { tipo: 'textoLibre' }
          : id === '__formulario'
            ? { tipo: 'formulario', datos: { nombre: 'Ana Pérez', email: 'ana@ejemplo.ec' } }
            : { tipo: 'opcion', id },
    });
    todos.push(...paso.mensajes);
  }

  return { paso, todos };
}

/** El guion entero: aceptar, contar el caso, responder los antecedentes y elegir cómo. */
const PRESENCIAL = [OPCION.acepto, '__texto', '__texto', OPCION.presencial];
const LLAMADA = [OPCION.acepto, '__texto', '__texto', OPCION.virtual];

describe('simulador · el guion completo', () => {
  it('la cita presencial termina avisando al abogado, sin agendar nada', async () => {
    // Nada de días ni horas: el bot recoge el caso y el abogado pone la hora.
    const { deps } = entorno();

    const { paso, todos } = await recorrer(deps, PRESENCIAL);

    expect(todos.map((m) => m.tipo)).toContain('ubicacion');
    expect(paso.estado).toBe('DERIVADA');
    expect(paso.derivada).toBe(true);
    expect(todos.some((m) => m.tipo === 'nota' && m.texto.includes('avisa al abogado'))).toBe(true);
    // El texto de cierre nombra a quien va a escribir.
    expect(todos.some((m) => m.tipo === 'texto' && m.texto.includes('Darío Bermeo'))).toBe(true);
  });

  it('la llamada no manda ubicación: no hay a dónde ir', async () => {
    const { deps } = entorno();

    const { paso, todos } = await recorrer(deps, LLAMADA);

    expect(paso.estado).toBe('DERIVADA');
    expect(todos.some((m) => m.tipo === 'ubicacion')).toBe(false);
  });

  it('el relato y los antecedentes piden una caja de texto, no opciones', async () => {
    const { deps } = entorno();

    const tras = await recorrer(deps, [OPCION.acepto]);
    // Quién decide que toca escribir es el dominio: la pantalla solo lo obedece.
    expect(tras.paso.estado).toBe('RELATO');
    expect(tras.paso.controles.tipo).toBe('texto');

    const luego = await recorrer(deps, [OPCION.acepto, '__texto']);
    expect(luego.paso.estado).toBe('ANTECEDENTES');
    expect(luego.paso.controles.tipo).toBe('texto');
  });

  it('nunca consulta el catálogo con un contacto real', async () => {
    const { deps, pedidos } = entorno();

    await recorrer(deps, PRESENCIAL);

    // El uuid nulo es lo que garantiza que la demostración no lee la agenda de nadie.
    for (const p of pedidos) {
      expect(p.contactoId).toBe('00000000-0000-0000-0000-000000000000');
    }
  });

  it('la modalidad son dos botones, y ninguno dice «virtual»', async () => {
    const { deps } = entorno();

    const { paso } = await recorrer(deps, [OPCION.acepto, '__texto', '__texto']);

    expect(paso.controles.tipo).toBe('botones');
    const titulos =
      paso.controles.tipo === 'botones' ? paso.controles.opciones.map((o) => o.titulo) : [];
    expect(titulos).toEqual(['Cita presencial', 'Llamada']);
  });
});

describe('simulador · lo que falta configurar se dice, no se inventa', () => {
  it('sin oficina no manda una ubicación cualquiera: lo avisa', async () => {
    const { deps } = entorno({ sinOficina: true });

    const { todos } = await recorrer(deps, PRESENCIAL);

    expect(todos.some((m) => m.tipo === 'ubicacion')).toBe(false);
    expect(todos.some((m) => m.tipo === 'nota' && m.texto.includes('oficina'))).toBe(true);
  });

  it('con oficina pero sin punto manda la dirección y NO promete el mapa', async () => {
    // Una dirección de esquina no siempre tiene un punto exacto a mano, y el despacho no
    // puede quedarse sin poner su dirección por eso. Lo que no puede pasar es prometer un
    // mapa que no llega: el contacto se queda esperando un mensaje que no existe.
    const { deps } = entorno({ sinPunto: true });

    const { todos } = await recorrer(deps, PRESENCIAL);
    const textos = todos.filter((m) => m.tipo === 'texto').map((m) => m.texto);

    expect(todos.some((m) => m.tipo === 'ubicacion')).toBe(false);
    expect(textos.some((t) => t.includes(OFICINA.direccion))).toBe(true);
    expect(textos.some((t) => t.includes('mapa'))).toBe(false);
  });

  it('todas las claves de texto que el simulador pinta existen en el catálogo', () => {
    // Un texto que no existiera saldría como `undefined` en pantalla, sin error en ninguna
    // parte. El catálogo es exhaustivo por tipo, pero esto lo fija también para el guion nuevo.
    for (const clave of ['relato', 'antecedentes', 'agendar', 'enCamino', 'ubicacion'] as const) {
      expect(CONTENIDO_BASE.textos[clave]).toBeTruthy();
    }
  });
});
