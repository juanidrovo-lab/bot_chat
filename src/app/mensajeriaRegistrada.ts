/**
 * Envoltura de `Mensajeria` que deja rastro de cada envío.
 *
 * Va aquí y no dentro del cliente de WhatsApp porque el rastro es del **turno**: necesita
 * saber a qué conversación pertenece el envío, y eso el cliente HTTP no lo sabe ni tiene
 * por qué. El caso de uso, que sí lo sabe, envuelve una vez por turno.
 *
 * Anotar **no puede** hacer fallar un envío que sí salió: si la anotación revienta, el
 * mensaje ya está en el teléfono del usuario y propagar el error haría que el turno se
 * reintentara y lo mandara dos veces. Por eso el fallo al anotar se traga, avisando.
 */
import type { Mensajeria } from './puertos/Mensajeria.ts';
import type { RegistroSalientes } from './puertos/RegistroSalientes.ts';

export interface ContextoRegistro {
  tenantId: string;
  conversacionId: string;
  registro: { warn(datos: object, mensaje: string): void };
}

export function registrando(
  mensajeria: Mensajeria,
  salientes: RegistroSalientes,
  ctx: ContextoRegistro,
): Mensajeria {
  async function anotar(tipo: string, waMessageId: string | null, error: unknown): Promise<void> {
    try {
      await salientes.anotar({
        tenantId: ctx.tenantId,
        conversacionId: ctx.conversacionId,
        tipo,
        waMessageId,
        // Solo el nombre: el cuerpo de una respuesta de Meta puede traer el número o el
        // nombre del contacto.
        error: error === null ? null : error instanceof Error ? error.name : 'desconocido',
      });
    } catch (fallo) {
      ctx.registro.warn(
        { tenantId: ctx.tenantId, tipo, err: fallo instanceof Error ? fallo.name : 'desconocido' },
        'no se pudo anotar el mensaje saliente',
      );
    }
  }

  function envolver<A extends unknown[]>(
    tipo: string,
    metodo: (...args: A) => Promise<string>,
  ): (...args: A) => Promise<string> {
    return async (...args) => {
      try {
        const waMessageId = await metodo(...args);
        await anotar(tipo, waMessageId, null);
        return waMessageId;
      } catch (error) {
        await anotar(tipo, null, error);
        // El envío sí falla: quien llama tiene que enterarse.
        throw error;
      }
    };
  }

  return {
    enviarTexto: envolver('texto', (d: string, t: string) => mensajeria.enviarTexto(d, t)),
    enviarLista: envolver('lista', (d, l) => mensajeria.enviarLista(d, l)),
    enviarBotones: envolver('botones', (d, b) => mensajeria.enviarBotones(d, b)),
    enviarAudio: envolver('audio', (d: string, m: string) => mensajeria.enviarAudio(d, m)),
    enviarImagen: envolver('imagen', (d: string, m: string, p: string) =>
      mensajeria.enviarImagen(d, m, p),
    ),
    enviarUbicacion: envolver('ubicacion', (d, u) => mensajeria.enviarUbicacion(d, u)),
    enviarPlantilla: envolver('plantilla', (d, p) => mensajeria.enviarPlantilla(d, p)),
    enviarFlow: envolver('formulario', (d, f) => mensajeria.enviarFlow(d, f)),
  };
}
