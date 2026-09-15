/**
 * La lista de despachos, para los trabajos programados.
 *
 * Existe porque bajo RLS **no hay** una consulta que vea las filas de todos: cada job tiene
 * que recorrerlos y fijar `app.tenant_id` en cada vuelta. `tenants` es la única tabla sin
 * RLS, y justamente por eso no guarda ningún secreto.
 */
export interface Despachos {
  /** Ids de los despachos activos. */
  activos(): Promise<string[]>;
}
