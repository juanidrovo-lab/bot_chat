export interface GestorMedia {
  /** Devuelve un `media_id` vigente para esa clave, resubiendo el audio si hace falta. */
  asegurarMediaFresco(tenantId: string, clave: string): Promise<string>;
}

/** Fábrica por despacho: el token de subida es de cada uno. */
export type MediaDe = (tenantId: string) => Promise<GestorMedia | null>;
