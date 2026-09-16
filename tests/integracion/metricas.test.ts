/**
 * Las consultas de las métricas, contra Postgres real.
 *
 * Aquí lo que importa es que cuenten lo que dicen contar. Una métrica que suma mal no falla
 * en ningún sitio: sale un número, alguien lo mira, y decide con él.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearRepoMetricas } from '../../src/adapters/postgres/metricasProducto.ts';
import { crearRepoPanel } from '../../src/adapters/postgres/panel.ts';
import { crearRepoCitas } from '../../src/adapters/postgres/reservas.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { abrirApp, limpiar, sembrarContacto, sembrarDespacho, type Despacho } from './ayuda.ts';

const db = abrirApp();
const metricas = crearRepoMetricas(db);
const panel = crearRepoPanel(db);
const citas = crearRepoCitas(db);

const DIA_MS = 86_400_000;
const DESDE = Date.now() - 30 * DIA_MS;
const HASTA = Date.now() + DIA_MS;

let a: Despacho;
let b: Despacho;

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
  b = await sembrarDespacho('despacho-b');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

async function conversacion(
  d: Despacho,
  contactoId: string,
  estado: string,
  derivada = false,
): Promise<string> {
  return enTenant(db, d.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversaciones
        (tenant_id, contacto_id, estado, flow_version, expira_at, derivada_at, derivada_motivo)
      VALUES (${d.tenantId}::uuid, ${contactoId}::uuid, ${estado}, 1,
              now() + interval '24 hours',
              ${derivada ? sql`now()` : sql`NULL`},
              ${derivada ? sql`'peticion_usuario'::motivo_derivacion` : sql`NULL`})
      RETURNING id
    `);
    return rows[0]!.id;
  });
}

function haceHoras(horas: number): Date {
  const d = new Date(Date.now() - horas * 3600_000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

async function reservar(d: Despacho, contactoId: string, inicia: Date): Promise<string> {
  const cita = await citas.reservar({
    tenantId: d.tenantId,
    abogadoId: d.abogadoId,
    contactoId,
    materia: 'laboral',
    modalidad: 'presencial',
    iniciaAt: inicia,
    terminaAt: new Date(inicia.getTime() + 45 * 60_000),
    honorarioUsd: '40.00',
    consumeCupo: false,
  });
  return cita.id;
}

describe('conversaciones y derivaciones', () => {
  it('cuenta las del periodo y separa las derivadas', async () => {
    const otro = await sembrarContacto(db, a.tenantId, '593991111111');
    await conversacion(a, a.contactoId, 'CITA_OK');
    await conversacion(a, otro, 'MENU', true);

    const resumen = await metricas.resumen(a.tenantId, DESDE, HASTA);

    expect(resumen.conversaciones).toBe(2);
    expect(resumen.derivadas).toBe(1);
  });

  it('no cuenta las de otro despacho', async () => {
    await conversacion(a, a.contactoId, 'MENU');
    await conversacion(b, b.contactoId, 'MENU');

    expect((await metricas.resumen(b.tenantId, DESDE, HASTA)).conversaciones).toBe(1);
  });

  it('no cuenta las de fuera del periodo', async () => {
    await conversacion(a, a.contactoId, 'MENU');

    const resumen = await metricas.resumen(a.tenantId, Date.now() + DIA_MS, Date.now() + 2 * DIA_MS);

    expect(resumen.conversaciones).toBe(0);
  });
});

describe('abandono', () => {
  it('agrupa por estado y deja fuera los finales legítimos', async () => {
    const dos = await sembrarContacto(db, a.tenantId, '593992222222');
    const tres = await sembrarContacto(db, a.tenantId, '593993333333');
    const cuatro = await sembrarContacto(db, a.tenantId, '593994444444');
    await conversacion(a, a.contactoId, 'ELEGIR_HORA');
    await conversacion(a, dos, 'ELEGIR_HORA');
    await conversacion(a, tres, 'TARIFA');
    // Quien dijo «solo consultaba» no abandonó el flujo: lo terminó.
    await conversacion(a, cuatro, 'CIERRE_SIN_CITA');

    const { abandono } = await metricas.resumen(a.tenantId, DESDE, HASTA);

    expect(abandono).toEqual([
      { estado: 'ELEGIR_HORA', total: 2 },
      { estado: 'TARIFA', total: 1 },
    ]);
  });

  it('una derivada no es un abandono: se cuenta aparte', async () => {
    await conversacion(a, a.contactoId, 'MENU', true);

    const resumen = await metricas.resumen(a.tenantId, DESDE, HASTA);

    expect(resumen.abandono).toEqual([]);
    expect(resumen.derivadas).toBe(1);
  });
});

describe('citas', () => {
  it('una conversación que llegó a reservar cuenta como con cita', async () => {
    await conversacion(a, a.contactoId, 'CITA_OK');
    await reservar(a, a.contactoId, haceHoras(2));

    expect((await metricas.resumen(a.tenantId, DESDE, HASTA)).conCita).toBe(1);
  });

  it('separa las marcadas de las que nadie tocó', async () => {
    const dos = await sembrarContacto(db, a.tenantId, '593992222222');
    const tres = await sembrarContacto(db, a.tenantId, '593993333333');

    const vino = await reservar(a, a.contactoId, haceHoras(3));
    const falto = await reservar(a, dos, haceHoras(2));
    await reservar(a, tres, haceHoras(1));

    await panel.marcarAsistencia(a.tenantId, vino, true);
    await panel.marcarAsistencia(a.tenantId, falto, false);

    const resumen = await metricas.resumen(a.tenantId, DESDE, HASTA);

    expect(resumen.citasMarcadas).toBe(2);
    expect(resumen.citasAusentes).toBe(1);
    // La tercera ya pasó y nadie la tocó: sin esto, la tasa de ausencias sería una opinión
    // sobre las dos que sí se marcaron.
    expect(resumen.citasSinMarcar).toBe(1);
  });

  it('una cita futura no está «sin marcar»: está por ocurrir', async () => {
    const manana = new Date(Date.now() + DIA_MS / 2);
    manana.setUTCMinutes(0, 0, 0);
    await reservar(a, a.contactoId, manana);

    expect((await metricas.resumen(a.tenantId, DESDE, HASTA)).citasSinMarcar).toBe(0);
  });

  it('una cancelada no cuenta ni como marcada ni como pendiente', async () => {
    const citaId = await reservar(a, a.contactoId, haceHoras(2));
    await panel.cancelarConGracia(a.tenantId, citaId, 0);

    const resumen = await metricas.resumen(a.tenantId, DESDE, HASTA);

    expect(resumen.citasMarcadas).toBe(0);
    expect(resumen.citasSinMarcar).toBe(0);
  });
});
