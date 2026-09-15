/**
 * Lo que este test protege no es un formato: es que el texto de una consulta de familia no
 * salga del proceso. Cada caso de aquí es una forma real en que ha escapado antes.
 */
import { describe, expect, it } from 'vitest';
import { CENSURA, redactar, redactarTexto } from '../../src/platform/redaccion.ts';

describe('redactar', () => {
  it('borra las claves prohibidas a cualquier profundidad', () => {
    const evento = {
      extra: { contexto: { contacto: { nombre: 'Ana Pérez', cedula: '0102030405' } } },
      request: { headers: { authorization: 'Bearer abc', 'x-hub-signature-256': 'sha256=…' } },
    };

    const limpio = redactar(evento);

    expect(limpio.extra.contexto.contacto.nombre).toBe(CENSURA);
    expect(limpio.extra.contexto.contacto.cedula).toBe(CENSURA);
    expect(limpio.request.headers.authorization).toBe(CENSURA);
    expect(limpio.request.headers['x-hub-signature-256']).toBe(CENSURA);
  });

  it('no distingue mayúsculas: `Authorization` filtra igual que `authorization`', () => {
    expect(redactar({ Authorization: 'Bearer abc' }).Authorization).toBe(CENSURA);
  });

  it('conserva lo que no es dato personal: sin eso el error deja de servir', () => {
    const limpio = redactar({ tenantId: 'despacho-a', estado: 'ELEGIR_HORA', intentos: 3 });

    expect(limpio).toEqual({ tenantId: 'despacho-a', estado: 'ELEGIR_HORA', intentos: 3 });
  });

  it('corta los parámetros que Drizzle pega al mensaje de una consulta fallida', () => {
    // Así es exactamente como el texto de un mensaje de WhatsApp acaba en un `Error.message`
    // sin que ninguna clave se llame `payload`.
    const mensaje =
      'Failed query: INSERT INTO mensajes ...\nparams: 3f8b,{"texto":"me despidieron sin liquidación"}';

    const limpio = redactarTexto(mensaje);

    expect(limpio).toContain('Failed query: INSERT INTO mensajes');
    expect(limpio).not.toContain('despidieron');
    expect(limpio).toContain(CENSURA);
  });

  it('aguanta un evento con ciclos sin colgarse', () => {
    const a: Record<string, unknown> = { nivel: 1 };
    a['yo'] = a;

    expect(() => redactar(a)).not.toThrow();
    expect(redactar(a)['yo']).toBe(CENSURA);
  });

  it('recorta la profundidad en vez de recorrer un árbol sin fondo', () => {
    let hoja: Record<string, unknown> = { fin: 'aquí' };
    for (let i = 0; i < 40; i++) hoja = { dentro: hoja };

    expect(() => redactar(hoja)).not.toThrow();
  });
});

describe('el logger', () => {
  it('redacta el mensaje y la pila del error, no solo los campos del objeto', async () => {
    const { Writable } = await import('node:stream');
    const { pino } = await import('pino');
    const { serializarError } = await import('../../src/platform/logger.ts');

    let salida = '';
    const destino = new Writable({
      write(trozo, _codificacion, hecho) {
        salida += String(trozo);
        hecho();
      },
    });

    // El serializador real, con el destino desviado: el logger del proyecto escribe a
    // stdout y el test no podría leerlo.
    const registro = pino({ serializers: { err: serializarError } }, destino);

    registro.error(
      { err: new Error('Failed query: INSERT INTO mensajes\nparams: 1,{"texto":"mi divorcio"}') },
      'falló',
    );

    // La pila repite el mensaje: redactar solo `message` dejaba la consulta en el log igual.
    expect(salida).not.toContain('divorcio');
    expect(salida).toContain('Failed query');
  });
});

describe('el reportador de errores', () => {
  it('sin DSN no se enciende, y eso no es un fallo', async () => {
    const { iniciarReporteErrores } = await import('../../src/platform/errores.ts');
    const dichos: string[] = [];

    const activo = iniciarReporteErrores({
      dsn: undefined,
      entorno: 'test',
      registro: { info: (_d, m) => dichos.push(m) },
    });

    // Un despliegue sin Sentry es válido: los errores siguen en el log.
    expect(activo).toBe(false);
    expect(dichos[0]).toContain('SENTRY_DSN');
  });

  it('el filtro que se le pasa a Sentry es el mismo que se prueba aquí', async () => {
    const { filtrarEvento } = await import('../../src/platform/errores.ts');

    // Si fueran dos, la regla probada y la aplicada podrían divergir sin que nadie lo note.
    const limpio = filtrarEvento({
      extra: { contacto: { nombre: 'Ana Pérez' } },
      message: 'Failed query: SELECT\nparams: {"texto":"mi despido"}',
    });

    expect(limpio.extra.contacto.nombre).toBe(CENSURA);
    expect(limpio.message).not.toContain('despido');
  });
});
