/**
 * Todo error propio tiene que decir cómo se llama.
 *
 * No es cosmético. El mensaje de un error se redacta antes de llegar al log o a Sentry
 * —puede traer los parámetros de una consulta, y ahí va el texto de una consulta jurídica—,
 * así que `name` es lo único que sobrevive para saber qué pasó. Varios sitios del proyecto
 * registran exactamente eso: `relayOutbox`, `importarBloqueos`, `refrescarMedia` y la
 * envoltura que anota los mensajes salientes.
 *
 * Una subclase que no lo fije se registra como «Error» y no dice nada.
 */
import { describe, expect, it } from 'vitest';
import { LimiteMensualError, SlotTomadoError, YaTieneCitaError } from '../../src/domain/agenda/errores.ts';
import { CifradoInvalidoError } from '../../src/platform/crypto.ts';
import { AccesoDenegado } from '../../src/app/autenticar.ts';
import { ContactoDesconocidoError } from '../../src/app/exportarDatosContacto.ts';
import { FalloPermanente } from '../../src/app/relayOutbox.ts';
import { VerificacionFallida } from '../../src/app/puertos/Passkeys.ts';
import { OrigenInvalido } from '../../src/adapters/webauthn/passkeys.ts';
import { ValorInesperadoError } from '../../src/adapters/postgres/tipos.ts';
import { TenantInvalidoError } from '../../src/adapters/postgres/tenantContext.ts';
import { MediaDesconocidoError } from '../../src/adapters/whatsapp/media.ts';
import { ErrorWhatsApp } from '../../src/adapters/whatsapp/cliente.ts';

const CLASES = [
  SlotTomadoError,
  YaTieneCitaError,
  LimiteMensualError,
  CifradoInvalidoError,
  AccesoDenegado,
  ContactoDesconocidoError,
  FalloPermanente,
  VerificacionFallida,
  OrigenInvalido,
  ValorInesperadoError,
  TenantInvalidoError,
  MediaDesconocidoError,
];

describe('errores propios', () => {
  it.each(CLASES.map((C) => [C.name, C] as const))('%s se identifica por su nombre', (esperado, Clase) => {
    const error = new (Clase as new (motivo: string) => Error)('motivo');

    expect(error.name).toBe(esperado);
    expect(error).toBeInstanceOf(Error);
  });

  it('el de WhatsApp también, aunque su constructor tenga otra forma', () => {
    expect(new ErrorWhatsApp(429, 'demasiadas peticiones', true).name).toBe('ErrorWhatsApp');
  });
});
