/**
 * Los cuatro trabajos programados de la fase 6, sin red ni base de datos.
 *
 * Lo que se prueba aquí no es que «funcionen»: es que **correrlos dos veces no haga daño**.
 * Un cron se ejecuta solo, sin nadie mirando, y pg-boss entrega al menos una vez; un job
 * que duplique recordatorios o que se caiga con un despacho a medio configurar se descubre
 * en producción o no se descubre.
 */
import { describe, expect, it } from 'vitest';
import { crearReloj } from '../../src/adapters/reloj.ts';
import { CLAVE_RECORDATORIO, enviarRecordatorios } from '../../src/app/enviarRecordatorios.ts';
import type { CitaRecordable, RepoRecordatorios } from '../../src/app/enviarRecordatorios.ts';
import { DIAS_REFRESCO, refrescarMedia } from '../../src/app/refrescarMedia.ts';
import { DIAS_MENSAJES, MESES_CONTACTOS, aplicarRetencion } from '../../src/app/retencion.ts';
import type { GestorMedia } from '../../src/app/puertos/Media.ts';
import type { RepoMantenimiento } from '../../src/app/puertos/RepoMantenimiento.ts';
import type { RepoOutbox } from '../../src/app/puertos/RepoOutbox.ts';

const TENANT = 'despacho-a';
const DIA_MS = 86_400_000;
/** Miércoles 16 de septiembre de 2026, 14:00 en Guayaquil. */
const AHORA = Date.parse('2026-09-16T19:00:00Z');

const reloj = crearReloj(() => AHORA);

const registroMudo = { warn: () => {} };

function outboxFalso() {
  const encolados: { tipo: string; payload: object; clave: string }[] = [];
  const claves = new Set<string>();

  const repo = {
    async encolar(_tenantId: string, tipo: string, payload: object, clave: string) {
      if (claves.has(clave)) return false;
      claves.add(clave);
      encolados.push({ tipo, payload, clave });
      return true;
    },
  } as unknown as RepoOutbox;

  return { repo, encolados };
}

describe('enviarRecordatorios', () => {
  function repoCon(citas: CitaRecordable[]) {
    const ventanas: { desdeMs: number; hastaMs: number }[] = [];
    const repo: RepoRecordatorios = {
      async citasEntre(_tenantId, desdeMs, hastaMs) {
        ventanas.push({ desdeMs, hastaMs });
        return citas;
      },
    };
    return { repo, ventanas };
  }

  it('pide justo el día siguiente en hora local, no «dentro de 24 horas»', async () => {
    const { repo, ventanas } = repoCon([]);
    const { repo: outbox } = outboxFalso();

    await enviarRecordatorios({ repo, outbox, reloj }, TENANT);

    const ventana = ventanas[0]!;
    // 17 de septiembre completo: de las 00:00 locales a las 00:00 del día siguiente.
    expect(reloj.diaLocal(ventana.desdeMs)).toBe('2026-09-17');
    expect(ventana.hastaMs - ventana.desdeMs).toBe(DIA_MS);
  });

  it('encola un recordatorio por cita, con clave estable', async () => {
    const { repo } = repoCon([{ id: 'cita-1' }, { id: 'cita-2' }]);
    const { repo: outbox, encolados } = outboxFalso();

    expect(await enviarRecordatorios({ repo, outbox, reloj }, TENANT)).toBe(2);
    expect(encolados.map((e) => e.clave)).toEqual([
      `${CLAVE_RECORDATORIO}:cita-1`,
      `${CLAVE_RECORDATORIO}:cita-2`,
    ]);
    expect(encolados[0]!.tipo).toBe('wa.recordatorio');
  });

  it('correrlo dos veces el mismo día no manda dos recordatorios', async () => {
    const { repo } = repoCon([{ id: 'cita-1' }]);
    const { repo: outbox, encolados } = outboxFalso();
    const deps = { repo, outbox, reloj };

    expect(await enviarRecordatorios(deps, TENANT)).toBe(1);
    expect(await enviarRecordatorios(deps, TENANT)).toBe(0);
    expect(encolados).toHaveLength(1);
  });
});

describe('aplicarRetencion', () => {
  function repoEspia() {
    const cortes: { mensajes?: number; contactos?: number } = {};
    const repo = {
      async borrarMensajesAntiguos(_t: string, antesDeMs: number) {
        cortes.mensajes = antesDeMs;
        return 7;
      },
      async anonimizarContactosInactivos(_t: string, antesDeMs: number) {
        cortes.contactos = antesDeMs;
        return 2;
      },
    } as unknown as RepoMantenimiento;
    return { repo, cortes };
  }

  it('borra mensajes a los 90 días y anonimiza contactos a los 12 meses', async () => {
    const { repo, cortes } = repoEspia();

    const resumen = await aplicarRetencion({ repo, reloj }, TENANT);

    expect(resumen).toEqual({ mensajesBorrados: 7, contactosAnonimizados: 2 });
    expect(AHORA - cortes.mensajes!).toBe(DIAS_MENSAJES * DIA_MS);
    expect(AHORA - cortes.contactos!).toBe(MESES_CONTACTOS * 30 * DIA_MS);
  });

  it('los mensajes se borran mucho antes que los contactos', async () => {
    // Si alguien invirtiera las constantes, el bot conservaría consultas jurídicas un año
    // y borraría la identidad a los tres meses: justo al revés de lo que pide la LOPDP.
    expect(DIAS_MENSAJES).toBeLessThan(MESES_CONTACTOS * 30);
  });
});

describe('refrescarMedia', () => {
  function gestorQueFalla(clavesMalas: readonly string[]) {
    const renovadas: string[] = [];
    const gestor: GestorMedia = {
      async asegurarMediaFresco(_tenantId, clave) {
        if (clavesMalas.includes(clave)) throw new Error('WhatsApp respondió 500');
        renovadas.push(clave);
        return `media-${clave}`;
      },
    };
    return { gestor, renovadas };
  }

  function repoCon(claves: readonly string[]) {
    const cortes: number[] = [];
    const repo = {
      async audiosParaRefrescar(_t: string, antesDeMs: number) {
        cortes.push(antesDeMs);
        return [...claves];
      },
    } as unknown as RepoMantenimiento;
    return { repo, cortes };
  }

  it('pide los audios subidos hace más de 25 días: el margen antes de los 30', async () => {
    const { repo, cortes } = repoCon([]);
    const { gestor } = gestorQueFalla([]);

    await refrescarMedia({ repo, mediaDe: async () => gestor, reloj, registro: registroMudo }, TENANT);

    expect(AHORA - cortes[0]!).toBe(DIAS_REFRESCO * DIA_MS);
    expect(DIAS_REFRESCO).toBeLessThan(30);
  });

  it('un audio que falla no deja sin renovar a los demás', async () => {
    const { repo } = repoCon(['bienvenida', 'tarifa', 'despedida']);
    const { gestor, renovadas } = gestorQueFalla(['tarifa']);

    const renovados = await refrescarMedia(
      { repo, mediaDe: async () => gestor, reloj, registro: registroMudo },
      TENANT,
    );

    expect(renovados).toBe(2);
    expect(renovadas).toEqual(['bienvenida', 'despedida']);
  });

  it('un despacho sin credenciales de WhatsApp no tumba el job', async () => {
    const { repo } = repoCon(['bienvenida']);

    await expect(
      refrescarMedia({ repo, mediaDe: async () => null, reloj, registro: registroMudo }, TENANT),
    ).resolves.toBe(0);
  });

  it('sin audios pendientes no pide credenciales siquiera', async () => {
    const { repo } = repoCon([]);
    let pedidas = 0;

    await refrescarMedia(
      {
        repo,
        mediaDe: async () => {
          pedidas++;
          return null;
        },
        reloj,
        registro: registroMudo,
      },
      TENANT,
    );

    expect(pedidas).toBe(0);
  });
});
