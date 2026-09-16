/**
 * Las métricas de producto de §9.
 *
 * Lo que se prueba aquí no es la aritmética —dividir es fácil— sino cuándo el informe se
 * calla. Un porcentaje sobre una muestra ridícula suena igual de autoritario que uno sobre
 * mil, y es con esos números con los que alguien decide cambiar el guion o no renovar.
 */
import { describe, expect, it } from 'vitest';
import { crearReloj } from '../../src/adapters/reloj.ts';
import { MINIMO_MUESTRA, informeDelPeriodo } from '../../src/app/metricas.ts';
import type { Metricas, RepoMetricas } from '../../src/app/puertos/RepoMetricas.ts';

const TENANT = 'despacho-a';
const AHORA = Date.parse('2026-09-16T19:00:00Z');
const reloj = crearReloj(() => AHORA);

function repo(parcial: Partial<Metricas> = {}): { repo: RepoMetricas; ventana: number[] } {
  const ventana: number[] = [];
  return {
    ventana,
    repo: {
      async resumen(_tenantId, desdeMs, hastaMs) {
        ventana.push(desdeMs, hastaMs);
        return {
          conversaciones: 0,
          conCita: 0,
          derivadas: 0,
          abandono: [],
          citasMarcadas: 0,
          citasAusentes: 0,
          citasSinMarcar: 0,
          ...parcial,
        };
      },
    },
  };
}

describe('la ventana', () => {
  it('son los últimos 30 días por defecto, y los días salen en hora local', async () => {
    const { repo: r, ventana } = repo();

    const informe = await informeDelPeriodo({ repo: r, reloj }, TENANT);

    expect(ventana[1]! - ventana[0]!).toBe(30 * 86_400_000);
    expect(informe.hasta).toBe('2026-09-16');
    expect(informe.desde).toBe('2026-08-17');
  });
});

describe('cuándo el informe se calla', () => {
  it('con muestra pequeña no da porcentajes y lo dice', async () => {
    const { repo: r } = repo({ conversaciones: 7, conCita: 3, derivadas: 1 });

    const informe = await informeDelPeriodo({ repo: r, reloj }, TENANT);

    // «43% de finalización» sobre siete conversaciones son tres citas: suena a dato y es
    // ruido, y es con eso con lo que alguien decide cambiar el guion.
    expect(informe.porcentajes.citasPorCien).toBeNull();
    expect(informe.porcentajes.derivacionesPorCien).toBeNull();
    expect(informe.advertencias.join(' ')).toContain('7 conversaciones');
  });

  it('con muestra suficiente sí los da', async () => {
    const { repo: r } = repo({ conversaciones: 100, conCita: 18, derivadas: 9 });

    const informe = await informeDelPeriodo({ repo: r, reloj }, TENANT);

    expect(informe.porcentajes.citasPorCien).toBe(18);
    expect(informe.porcentajes.derivacionesPorCien).toBe(9);
    expect(MINIMO_MUESTRA).toBeLessThanOrEqual(100);
  });

  it('la tasa de ausencias se mide sobre las citas MARCADAS, no sobre todas', async () => {
    const { repo: r } = repo({
      conversaciones: 100,
      citasMarcadas: 40,
      citasAusentes: 6,
      citasSinMarcar: 30,
    });

    const informe = await informeDelPeriodo({ repo: r, reloj }, TENANT);

    // 6 de 40, no 6 de 70: nadie sabe qué pasó con las otras treinta.
    expect(informe.porcentajes.ausenciasPorCien).toBe(15);
  });

  it('avisa de las citas pasadas que nadie marcó', async () => {
    const { repo: r } = repo({ conversaciones: 100, citasMarcadas: 40, citasSinMarcar: 30 });

    const informe = await informeDelPeriodo({ repo: r, reloj }, TENANT);

    // Sin este aviso, la tasa de ausencias es una opinión sobre la mitad que sí se marcó, y
    // así es como una métrica pasa de útil a engañosa sin que nadie lo note.
    expect(informe.advertencias.join(' ')).toContain('30 cita');
  });

  it('sin citas marcadas no inventa una tasa de ausencias', async () => {
    const { repo: r } = repo({ conversaciones: 100, citasMarcadas: 0, citasAusentes: 0 });

    const informe = await informeDelPeriodo({ repo: r, reloj }, TENANT);

    expect(informe.porcentajes.ausenciasPorCien).toBeNull();
  });

  it('un periodo limpio no genera advertencias', async () => {
    const { repo: r } = repo({ conversaciones: 100, conCita: 20, citasMarcadas: 20 });

    const informe = await informeDelPeriodo({ repo: r, reloj }, TENANT);

    expect(informe.advertencias).toEqual([]);
  });
});

describe('redondeo', () => {
  it('un decimal basta: dar más es fingir precisión que no hay', async () => {
    const { repo: r } = repo({ conversaciones: 300, conCita: 100 });

    const informe = await informeDelPeriodo({ repo: r, reloj }, TENANT);

    expect(informe.porcentajes.citasPorCien).toBe(33.3);
  });
});
