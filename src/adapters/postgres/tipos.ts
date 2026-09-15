/**
 * Conversión de lo que devuelve `tx.execute`.
 *
 * Drizzle instala sus propios analizadores en node-postgres y desactiva los que traen por
 * defecto, así que en una consulta cruda **`timestamptz` llega como string** («2026-09-17
 * 04:30:00+00») y `numeric` también. Tipar esas columnas como `Date` compila igual de bien
 * y revienta en la primera llamada a `.getTime()`, en producción y no en el test.
 *
 * Regla del proyecto: toda columna de fecha leída con SQL crudo pasa por `aInstante`, y
 * toda comparación de tiempo que pueda hacerse en SQL se hace en SQL —además de evitar
 * este problema, elimina la deriva entre el reloj de la aplicación y el de la base—.
 */
export class ValorInesperadoError extends Error {
  constructor(motivo: string) {
    super(motivo);
    // El `name` no es cosmético: el mensaje se redacta antes de llegar al log —puede traer
    // los parámetros de una consulta— y esto es lo único que sobrevive para saber qué pasó.
    this.name = 'ValorInesperadoError';
  }
}

export function aInstante(valor: unknown): Date {
  if (valor instanceof Date) return valor;
  if (typeof valor === 'string') {
    const fecha = new Date(valor);
    if (Number.isNaN(fecha.getTime())) {
      throw new ValorInesperadoError(`No se pudo leer «${valor}» como instante`);
    }
    return fecha;
  }
  throw new ValorInesperadoError(`Se esperaba una fecha y llegó ${typeof valor}`);
}

export function aInstanteOpcional(valor: unknown): Date | null {
  return valor === null || valor === undefined ? null : aInstante(valor);
}
