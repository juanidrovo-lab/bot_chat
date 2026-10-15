/**
 * El alta de un despacho, en lo que no necesita base de datos.
 *
 * Lo que se prueba aquí es el formato de los números de WhatsApp. Es el error que más tarda
 * en aparecer de todo el alta: un `+593 99 013 7819` se guarda sin protestar —es un `string`
 * y `jsonb` acepta cualquier cosa— y el fallo sale meses después, la primera vez que entra
 * una consulta de verdad y Meta rechaza el aviso sin decir nada.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Configuracion } from '../../scripts/esquemaDespacho.ts';

const DEMO = fileURLToPath(new URL('../../demo/', import.meta.url));

describe('el número de WhatsApp', () => {
  const base = {
    slug: 'x',
    nombre: 'X',
    waPhoneNumberId: 'p',
    waWabaId: 'w',
    tarifario: { consulta: { titulo: 'Consulta', honorarioUsd: '0.00' } },
    horarios: { '2': [{ desde: '09:00', hasta: '13:00' }] },
    abogados: [{ nombre: 'Abg. X', materias: ['consulta'] }],
    usuarios: [],
  };
  const con = (waId: string) =>
    Configuracion.safeParse({ ...base, avisoAbogado: { waId, plantilla: 'aviso_consulta' } });

  it('acepta el formato internacional, solo dígitos', () => {
    expect(con('593990137819').success).toBe(true);
  });

  it('rechaza lo que un humano escribe y Meta no acepta', () => {
    // Todas estas se guardaban tal cual y fallaban en silencio al primer aviso.
    for (const malo of ['+593990137819', '593 99 013 7819', '0990137819', '593-99-013-7819', '']) {
      expect(con(malo).success, malo).toBe(false);
    }
  });

  it('el mensaje dice cómo se escribe, no solo que está mal', () => {
    const r = con('+593 99 013 7819');
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain('593990137819');
  });
});

describe('los JSON de despacho del repositorio', () => {
  /**
   * Validar los ficheros que se versionan, no solo el esquema: un número mal escrito en
   * `demo/aseleb.json` es exactamente el fallo que este esquema existe para evitar, y
   * nadie lo ve hasta que alguien corre el alta.
   */
  it.each(['despacho.json', 'aseleb.json'])('%s es válido', async (fichero) => {
    const r = Configuracion.safeParse(JSON.parse(await readFile(DEMO + fichero, 'utf8')));
    expect(r.error?.issues ?? []).toEqual([]);
    expect(r.success).toBe(true);
  });
});
