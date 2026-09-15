/**
 * Cola sobre el mismo Postgres (D6). Sin Redis, sin un contenedor más.
 *
 * Vive en `adapters/` y no en `platform/` por el mismo motivo que `db.ts`: implementa un
 * puerto de `app/`, y `platform` es hoja.
 */
import { PgBoss, type Job } from 'pg-boss';
import type { Cola } from '../../app/puertos/Cola.ts';

/**
 * Política de cada cola.
 *
 *  - `key_strict_fifo` exige `singletonKey` en **todos** los trabajos, así que solo vale
 *    para los mensajes entrantes, que se ordenan por conversación.
 *  - `exclusive` es la de los trabajos programados: un solo trabajo en cola o activo. Si
 *    una pasada tarda más que el intervalo del cron, las siguientes no se apilan.
 */
export type PoliticaCola = 'key_strict_fifo' | 'exclusive';

export interface EspecificacionCola {
  nombre: string;
  politica: PoliticaCola;
}

export interface ColaPgBoss extends Cola {
  arrancar(colas: readonly EspecificacionCola[]): Promise<void>;
  /** Registra un cron. Idempotente: volver a programar la misma clave la sustituye. */
  programar(cola: string, cron: string, zona: string): Promise<void>;
  /**
   * Quita el cron de una cola. Un trabajo programado que se retira del código pero se deja
   * en `pgboss.schedule` sigue disparándose contra una cola que ya nadie atiende.
   */
  desprogramar(cola: string): Promise<void>;
  /** Descarta los trabajos pendientes de una cola. Solo para tests. */
  vaciar(cola: string): Promise<void>;
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
      for (const { nombre, politica } of colas) {
        /**
         * `key_strict_fifo` es la garantía de D10 puesta en la cola en vez de en el
         * programador: los trabajos con la misma `singletonKey` se entregan en orden de
         * llegada, y uno activo retiene a sus sucesores de esa clave sin frenar a las
         * demás conversaciones. El `SELECT ... FOR UPDATE` del trabajador sigue estando
         * como segunda línea: protege también del despliegue con dos procesos solapados.
         */
        await boss.createQueue(nombre, { policy: politica });
      }
    },

    async programar(cola, cron, zona) {
      /**
       * `missed: 'once'` y no `'skip'`: si el despliegue estuvo caído a las 09:00, los
       * recordatorios del día no pueden perderse sin más. Se manda una sola puesta al día,
       * no una por cada ocurrencia perdida.
       */
      await boss.schedule(cola, cron, null, { tz: zona, missed: 'once' });
    },

    async desprogramar(cola) {
      await boss.unschedule(cola);
    },

    async vaciar(cola) {
      await boss.deleteQueuedJobs(cola);
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
