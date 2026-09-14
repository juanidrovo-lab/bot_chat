/**
 * Cola sobre el mismo Postgres (D6). Sin Redis, sin un contenedor más.
 *
 * Vive en `adapters/` y no en `platform/` por el mismo motivo que `db.ts`: implementa un
 * puerto de `app/`, y `platform` es hoja.
 */
import { PgBoss, type Job } from 'pg-boss';
import type { Cola } from '../../app/puertos/Cola.ts';

export interface ColaPgBoss extends Cola {
  arrancar(colas: readonly string[]): Promise<void>;
  parar(): Promise<void>;
}

export interface OpcionesCola {
  esquema?: string;
  /** Solo para tests: acelera el sondeo para no esperar el intervalo por defecto. */
  sondeoSegundos?: number;
}

export function crearCola(url: string, opciones: OpcionesCola = {}): ColaPgBoss {
  const boss = new PgBoss({
    connectionString: url,
    schema: opciones.esquema ?? 'pgboss',
    // El esquema lo crea la migración `0001_rls.sql` y pertenece a app_user. Crearlo aquí
    // exigiría CREATE sobre la base de datos, que es mucho más de lo que la aplicación
    // necesita: dentro de su propio esquema pg-boss ya puede hacer todo lo que le hace
    // falta.
    createSchema: false,
    ...(opciones.sondeoSegundos === undefined
      ? {}
      : { pollingIntervalSeconds: opciones.sondeoSegundos, notifyPollingIntervalSeconds: opciones.sondeoSegundos }),
  });

  return {
    async arrancar(colas) {
      await boss.start();
      for (const nombre of colas) {
        /**
         * `key_strict_fifo` es la garantía de D10 puesta en la cola en vez de en el
         * programador: los trabajos con la misma `singletonKey` se entregan en orden de
         * llegada, y uno activo retiene a sus sucesores de esa clave sin frenar a las
         * demás conversaciones. El `SELECT ... FOR UPDATE` del trabajador sigue estando
         * como segunda línea: protege también del despliegue con dos procesos solapados.
         */
        await boss.createQueue(nombre, { policy: 'key_strict_fifo' });
      }
    },

    async parar() {
      await boss.stop({ graceful: true });
    },

    async encolar(cola, datos, opciones) {
      return boss.send(cola, datos, { singletonKey: opciones.clave });
    },

    async trabajar<T>(cola: string, manejador: (datos: T) => Promise<void>) {
      // batchSize 1: el orden por clave lo garantiza la política de la cola, pero procesar
      // de uno en uno mantiene esa garantía también dentro del propio trabajador.
      await boss.work<T>(cola, { batchSize: 1 }, async (trabajos: Job<T>[]) => {
        for (const trabajo of trabajos) await manejador(trabajo.data);
      });
    },
  };
}
