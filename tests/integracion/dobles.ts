import { crearCatalogos } from '../../src/adapters/postgres/catalogos.ts';
import { crearRepoCitas } from '../../src/adapters/postgres/reservas.ts';
import { crearRegistroSalientes } from '../../src/adapters/postgres/metricas.ts';
import { crearReloj } from '../../src/adapters/reloj.ts';
import { POLITICA } from '../../src/domain/agenda/politicas.ts';
import { crearRepoConversaciones } from '../../src/adapters/postgres/repoConversaciones.ts';
import type { BaseDatos } from '../../src/adapters/postgres/db.ts';
import { contenidoDe } from '../../src/app/content.ts';
import type { DependenciasProcesar } from '../../src/app/procesarMensajeEntrante.ts';
import type { Clasificador } from '../../src/app/puertos/Clasificador.ts';
import type { MediaDe } from '../../src/app/puertos/Media.ts';
import type { Mensajeria } from '../../src/app/puertos/Mensajeria.ts';
import { FLOW_VERSION } from '../../src/domain/conversacion/version.ts';

export interface Envio {
  tipo: 'texto' | 'lista' | 'botones' | 'audio' | 'plantilla' | 'flow';
  destino: string;
  cuerpo: string;
  opciones: string[];
}

export interface MensajeriaFalsa {
  puerto: Mensajeria;
  envios: Envio[];
  /** Cuerpos enviados, para aserciones legibles. */
  cuerpos(): string[];
}

/** `demoraMs` sirve para comprobar solapamientos: el envío ocurre dentro del bloqueo. */
export function mensajeriaFalsa(demoraMs = 0): MensajeriaFalsa {
  const envios: Envio[] = [];
  const registrar = async (envio: Envio): Promise<string> => {
    if (demoraMs > 0) await new Promise((r) => setTimeout(r, demoraMs));
    envios.push(envio);
    return `wamid.out.${envios.length}`;
  };

  return {
    envios,
    cuerpos: () => envios.map((e) => e.cuerpo),
    puerto: {
      enviarTexto: (destino, texto) => registrar({ tipo: 'texto', destino, cuerpo: texto, opciones: [] }),
      enviarLista: (destino, lista) =>
        registrar({
          tipo: 'lista',
          destino,
          cuerpo: lista.cuerpo,
          opciones: lista.secciones.flatMap((s) => s.filas.map((f) => f.id)),
        }),
      enviarBotones: (destino, botones) =>
        registrar({
          tipo: 'botones',
          destino,
          cuerpo: botones.cuerpo,
          opciones: botones.botones.map((b) => b.id),
        }),
      enviarAudio: (destino, mediaId) =>
        registrar({ tipo: 'audio', destino, cuerpo: mediaId, opciones: [] }),
      enviarPlantilla: (destino, plantilla) =>
        registrar({ tipo: 'plantilla', destino, cuerpo: plantilla.nombre, opciones: [] }),
      enviarFlow: (destino, flow) =>
        registrar({ tipo: 'flow', destino, cuerpo: flow.cuerpo, opciones: [flow.flowId] }),
    },
  };
}

/** Clasificador que siempre devuelve lo mismo. El modelo real no entra en los tests. */
export function clasificadorFijo(respuesta: string | null): Clasificador {
  return { async clasificar() { return respuesta; } };
}

export const REGISTRO_SILENCIOSO = { warn: () => {} };

/** El Flow estático que un despacho tiene publicado en Meta tras la fase 0. */
export const FLOW_DE_PRUEBA = { flowId: 'flow-de-prueba', cta: 'Completar datos' };

/** `ahora` fijo permite probar la antelación mínima sin depender del reloj real. */
export function dependencias(
  db: BaseDatos,
  mensajeria: Mensajeria,
  clasificador: Clasificador = clasificadorFijo(null),
  ahoraMs?: number,
  mediaDe: MediaDe = async () => null,
): DependenciasProcesar {
  const reloj = crearReloj(ahoraMs === undefined ? Date.now : () => ahoraMs);
  const repoCitas = crearRepoCitas(db);
  return {
    repo: crearRepoConversaciones(db),
    mensajeria: async () => mensajeria,
    clasificador,
    catalogos: crearCatalogos({ db, repo: repoCitas, reloj, politica: POLITICA }),
    // El registro real: así los tests de flujo comprueban de paso que cada turno deja su
    // rastro de salientes, que es lo que sostiene la alerta de §9.
    salientes: crearRegistroSalientes(db),
    // Por defecto sin gestor de media: los tests del guion no suben ficheros, y el caso de
    // uso tiene que seguir contestando igual. Quien quiera comprobar la voz pasa el suyo.
    mediaDe,
    /**
     * Con Flow configurado: es como queda un despacho después de la fase 0. Sin él, la
     * conversación se deriva a una persona en cuanto llega a pedir los datos, que es el
     * comportamiento que prueba `maquina.test.ts`.
     */
    contenido: async () => ({ ...contenidoDe(), flowDatos: FLOW_DE_PRUEBA }),
    repoCitas,
    politica: POLITICA,
    flowVersion: FLOW_VERSION,
    registro: REGISTRO_SILENCIOSO,
  };
}

/**
 * Gestor de media que canjea la clave por un `media_id` de mentira, y anota qué le
 * pidieron. Lo que importa comprobar es que el caso de uso **canjea**: mandarle a WhatsApp
 * la clave en vez del identificador es un rechazo seguro, y silencioso.
 */
export function gestorMediaFalso(fallaCon?: Error) {
  const pedidos: string[] = [];
  const mediaDe: MediaDe = async () => ({
    async asegurarMediaFresco(_tenantId, clave) {
      pedidos.push(clave);
      if (fallaCon !== undefined) throw fallaCon;
      return `media-de-${clave}`;
    },
  });
  return { mediaDe, pedidos };
}
