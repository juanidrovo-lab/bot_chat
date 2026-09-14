import { Hono } from 'hono';
import { FLOW_VERSION } from '../../domain/conversacion/version.ts';
import { COLA_MENSAJE_ENTRANTE, type Cola, type TrabajoMensajeEntrante } from '../../app/puertos/Cola.ts';
import type { BaseDatos } from '../postgres/db.ts';
import { registrarEntrante } from '../postgres/inbox.ts';
import { credencialesDe, resolverPorPhoneNumberId } from '../postgres/tenants.ts';
import { enTenant } from '../postgres/tenantContext.ts';
import { phoneNumberIdDe, Webhook } from '../whatsapp/esquemas.ts';
import { verificarFirma } from '../whatsapp/firma.ts';
import { logger } from '../../platform/logger.ts';

export interface DependenciasWebhook {
  db: BaseDatos;
  cola: Cola;
  claveCifradoHex: string;
  verifyToken: string;
}

export const RUTA = '/webhook/whatsapp';

/**
 * Webhook de WhatsApp.
 *
 * Responde 200 en menos de un segundo y encola: Meta reintenta agresivamente y procesar
 * dentro del handler es la causa número uno de respuestas duplicadas (D5).
 *
 * **Sobre el orden de la verificación de firma.** El secreto de la app está guardado por
 * despacho, así que hay que saber de qué despacho es el mensaje antes de poder verificar
 * nada. Eso obliga a mirar el cuerpo todavía no autenticado para sacar el
 * `phone_number_id`. Es seguro porque de ese cuerpo solo se lee ese campo, con un esquema
 * diminuto (`Enrutamiento`), y **no se escribe nada** hasta que la firma cuadra: lo único
 * que puede provocar un desconocido es una búsqueda por índice en `tenants`.
 */
export function crearWebhook(deps: DependenciasWebhook): Hono {
  const app = new Hono();

  // Verificación del webhook (GET hub.challenge).
  app.get(RUTA, (c) => {
    const modo = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const reto = c.req.query('hub.challenge');

    if (modo === 'subscribe' && token === deps.verifyToken && reto !== undefined) {
      return c.text(reto, 200);
    }
    return c.text('forbidden', 403);
  });

  app.post(RUTA, async (c) => {
    // Los bytes exactos que envió Meta: el HMAC es sobre ellos, no sobre el JSON
    // reserializado.
    const crudo = Buffer.from(await c.req.arrayBuffer());

    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(crudo.toString('utf8'));
    } catch {
      return c.json({ error: 'json invalido' }, 400);
    }

    const phoneNumberId = phoneNumberIdDe(cuerpo);
    if (phoneNumberId === null) return c.json({ error: 'sin phone_number_id' }, 400);

    const tenant = await resolverPorPhoneNumberId(deps.db, phoneNumberId);
    if (tenant === null) return c.json({ error: 'despacho desconocido' }, 404);

    const credenciales = await credencialesDe(deps.db, tenant.id, phoneNumberId, deps.claveCifradoHex);
    if (credenciales === null) {
      logger.error({ tenantId: tenant.id }, 'despacho sin credenciales configuradas');
      return c.json({ error: 'despacho sin configurar' }, 500);
    }

    if (!verificarFirma(crudo, c.req.header('x-hub-signature-256'), credenciales.appSecret)) {
      logger.warn({ tenantId: tenant.id }, 'firma del webhook invalida');
      return c.json({ error: 'firma invalida' }, 401);
    }

    // A partir de aquí el cuerpo está autenticado.
    const validado = Webhook.safeParse(cuerpo);
    if (!validado.success) {
      // Una forma que no modelamos no es motivo para que Meta reintente eternamente.
      logger.warn({ tenantId: tenant.id }, 'webhook con forma no reconocida');
      return c.json({ recibido: true }, 200);
    }

    let encolados = 0;
    let duplicados = 0;

    for (const entrada of validado.data.entry) {
      for (const cambio of entrada.changes) {
        for (const mensaje of cambio.value.messages ?? []) {
          const registro = await enTenant(deps.db, tenant.id, (tx) =>
            registrarEntrante(tx, {
              tenantId: tenant.id,
              waId: mensaje.from,
              waMessageId: mensaje.id,
              tipo: mensaje.type,
              payload: mensaje,
              flowVersion: FLOW_VERSION,
            }),
          );

          if (registro.duplicado) {
            duplicados++;
            continue;
          }

          const trabajo: TrabajoMensajeEntrante = {
            tenantId: tenant.id,
            conversacionId: registro.conversacionId,
            contactoId: registro.contactoId,
            waMessageId: mensaje.id,
          };
          // La clave es la conversación: dos mensajes seguidos del mismo usuario se
          // procesan en orden y nunca a la vez.
          await deps.cola.encolar(COLA_MENSAJE_ENTRANTE, trabajo, { clave: registro.conversacionId });
          encolados++;
        }
      }
    }

    // Nunca se registra el payload: lleva consultas jurídicas.
    logger.info({ tenantId: tenant.id, encolados, duplicados }, 'webhook procesado');
    return c.json({ recibido: true }, 200);
  });

  return app;
}
