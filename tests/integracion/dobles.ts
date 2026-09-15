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

/** `ahora` fijo permite probar la antelación mínima sin depender del reloj real. */
export function dependencias(
  db: BaseDatos,
  mensajeria: Mensajeria,
  clasificador: Clasificador = clasificadorFijo(null),
  ahoraMs?: number,
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
    contenido: async () => contenidoDe(),
    repoCitas,
    politica: POLITICA,
    flowVersion: FLOW_VERSION,
    registro: REGISTRO_SILENCIOSO,
  };
}
