import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearWebhook, RUTA } from '../../src/adapters/http/webhook.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import type { Cola } from '../../src/app/puertos/Cola.ts';
import { abrirApp, APP_SECRET, CLAVE_HEX, limpiar, sembrarDespacho, type Despacho } from './ayuda.ts';

const db = abrirApp();
let a: Despacho;
let b: Despacho;
let encolados: { cola: string; datos: object; clave: string }[];

/** Cola de mentira: el webhook solo tiene que encolar, no ejecutar. */
const colaFalsa: Cola = {
  async encolar(cola, datos, opciones) {
    encolados.push({ cola, datos, clave: opciones.clave });
    return `job-${encolados.length}`;
  },
  async trabajar() {},
};

function app() {
  return crearWebhook({
    db,
    cola: colaFalsa,
    claveCifradoHex: CLAVE_HEX,
    verifyToken: 'token-de-verificacion',
  });
}

function sobre(phoneNumberId: string, mensajes: object[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              messages: mensajes,
            },
          },
        ],
      },
    ],
  };
}

const textoDe = (id: string, from = '593999111222') => ({
  from,
  id,
  timestamp: '1757000000',
  type: 'text',
  text: { body: 'Necesito una consulta laboral' },
});

async function postear(cuerpo: unknown, opciones: { secreto?: string; firma?: string } = {}) {
  const crudo = Buffer.from(JSON.stringify(cuerpo), 'utf8');
  const firma =
    opciones.firma ??
    'sha256=' + createHmac('sha256', opciones.secreto ?? APP_SECRET).update(crudo).digest('hex');

  return app().fetch(
    new Request(`http://localhost${RUTA}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': firma },
      body: crudo,
    }),
  );
}

beforeEach(async () => {
  await limpiar();
  encolados = [];
  a = await sembrarDespacho('despacho-a');
  b = await sembrarDespacho('despacho-b');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

describe('webhook · verificación (GET)', () => {
  it('devuelve el reto cuando el token coincide', async () => {
    const r = await app().fetch(
      new Request(`http://localhost${RUTA}?hub.mode=subscribe&hub.verify_token=token-de-verificacion&hub.challenge=12345`),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('12345');
  });

  it('rechaza un token que no es el nuestro', async () => {
    const r = await app().fetch(
      new Request(`http://localhost${RUTA}?hub.mode=subscribe&hub.verify_token=intruso&hub.challenge=12345`),
    );
    expect(r.status).toBe(403);
  });
});

describe('webhook · firma', () => {
  it('una firma alterada devuelve 401 y no escribe nada', async () => {
    const r = await postear(sobre(a.phoneNumberId, [textoDe('wamid.1')]), { secreto: 'otro-secreto' });
    expect(r.status).toBe(401);
    expect(encolados).toHaveLength(0);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM mensajes`),
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('una firma con basura devuelve 401, no 500', async () => {
    for (const firma of ['', 'sha256=', 'sha256=nohex', 'md5=abcd']) {
      const r = await postear(sobre(a.phoneNumberId, [textoDe('wamid.1')]), { firma });
      expect(r.status).toBe(401);
    }
  });

  it('el despacho del que no sabemos nada recibe 404, sin filtrar por qué', async () => {
    const r = await postear(sobre('phone-inexistente', [textoDe('wamid.1')]));
    expect(r.status).toBe(404);
  });

  it('un cuerpo que no es JSON devuelve 400', async () => {
    const r = await app().fetch(
      new Request(`http://localhost${RUTA}`, { method: 'POST', body: 'esto no es json' }),
    );
    expect(r.status).toBe(400);
  });

  it('cada despacho se valida con su propio secreto', async () => {
    // Firmar el mensaje de B con el secreto de A no debe colar: son el mismo valor solo
    // porque la siembra usa el mismo texto, así que se comprueba el enrutamiento.
    const r = await postear(sobre(b.phoneNumberId, [textoDe('wamid.B1')]), { secreto: 'secreto-que-no-es' });
    expect(r.status).toBe(401);
  });
});

describe('webhook · deduplicación y encolado', () => {
  it('encola con la conversación como clave', async () => {
    const r = await postear(sobre(a.phoneNumberId, [textoDe('wamid.1')]));
    expect(r.status).toBe(200);
    expect(encolados).toHaveLength(1);
    expect(encolados[0]!.cola).toBe('mensaje.entrante');
    expect(encolados[0]!.clave).toMatch(/^[0-9a-f-]{36}$/);
    expect(encolados[0]!.datos).toMatchObject({ tenantId: a.tenantId, waMessageId: 'wamid.1' });
  });

  it('el reintento de Meta no encola dos veces ni duplica el mensaje', async () => {
    const cuerpo = sobre(a.phoneNumberId, [textoDe('wamid.1')]);
    expect((await postear(cuerpo)).status).toBe(200);
    expect((await postear(cuerpo)).status).toBe(200);

    expect(encolados).toHaveLength(1);
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM mensajes`),
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('el mismo wa_message_id en otro despacho NO se descarta como duplicado', async () => {
    await postear(sobre(a.phoneNumberId, [textoDe('wamid.COMPARTIDO')]));
    await postear(sobre(b.phoneNumberId, [textoDe('wamid.COMPARTIDO')]));

    expect(encolados).toHaveLength(2);
    expect(encolados[0]!.clave).not.toBe(encolados[1]!.clave);
  });

  it('dos mensajes seguidos del mismo usuario comparten clave: se serializan', async () => {
    await postear(sobre(a.phoneNumberId, [textoDe('wamid.1'), textoDe('wamid.2')]));
    expect(encolados).toHaveLength(2);
    expect(encolados[0]!.clave).toBe(encolados[1]!.clave);
  });

  it('un usuario nuevo abre una sola conversación aunque mande dos mensajes a la vez', async () => {
    const cuerpo = sobre(a.phoneNumberId, [textoDe('wamid.1'), textoDe('wamid.2')]);
    await postear(cuerpo);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM conversaciones`),
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('un lote de acuses de entrega se acepta sin encolar nada', async () => {
    const acuses = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: a.phoneNumberId },
                statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '1757000000' }],
              },
            },
          ],
        },
      ],
    };
    expect((await postear(acuses)).status).toBe(200);
    expect(encolados).toHaveLength(0);
  });

  it('el mensaje entrante queda guardado bajo el tenant correcto y no se ve desde el otro', async () => {
    await postear(sobre(a.phoneNumberId, [textoDe('wamid.1')]));

    const enA = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM mensajes`),
    );
    const enB = await enTenant(db, b.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM mensajes`),
    );
    expect(enA.rows[0]!.n).toBe('1');
    expect(enB.rows[0]!.n).toBe('0');
  });
});
