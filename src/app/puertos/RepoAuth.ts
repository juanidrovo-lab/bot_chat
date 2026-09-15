import type { CredencialGuardada } from './Passkeys.ts';

export interface UsuarioPanel {
  id: string;
  email: string;
  nombre: string;
  rol: 'abogado' | 'secretaria';
  abogadoId: string | null;
  activo: boolean;
}

export interface SesionPanel {
  id: string;
  tenantId: string;
  usuario: UsuarioPanel;
}

export interface RepoAuth {
  usuarioPorEmail(tenantId: string, email: string): Promise<UsuarioPanel | null>;

  credencialesDe(tenantId: string, usuarioId: string): Promise<CredencialGuardada[]>;

  /** Todas las del despacho: en el acceso aún no se sabe quién dice ser. */
  credencialesDelDespacho(tenantId: string): Promise<(CredencialGuardada & { usuarioId: string })[]>;

  /** Guarda el reto con su caducidad. */
  guardarReto(
    tenantId: string,
    reto: string,
    proposito: 'registro' | 'acceso',
    usuarioId: string | null,
    expiraAt: Date,
  ): Promise<void>;

  /**
   * Consume el reto: lo borra y dice si era válido. De un solo uso y en una sola sentencia,
   * porque leerlo y borrarlo por separado deja la ventana que permite repetir una respuesta
   * capturada.
   */
  consumirReto(
    tenantId: string,
    reto: string,
    proposito: 'registro' | 'acceso',
  ): Promise<{ valido: boolean; usuarioId: string | null }>;

  guardarCredencial(
    tenantId: string,
    usuarioId: string,
    credencial: CredencialGuardada,
    apodo: string | null,
  ): Promise<void>;

  /** Anota el contador nuevo y el uso. */
  anotarUso(tenantId: string, credencialId: string, contador: number): Promise<void>;

  /** Crea la sesión guardando el hash del testigo, nunca el testigo. */
  crearSesion(
    tenantId: string,
    usuarioId: string,
    tokenHash: string,
    expiraAt: Date,
  ): Promise<string>;

  /** `null` si no existe, caducó o el usuario está inactivo. */
  sesionPorHash(tenantId: string, tokenHash: string): Promise<SesionPanel | null>;

  cerrarSesion(tenantId: string, tokenHash: string): Promise<void>;

  /** Limpia retos vencidos y sesiones caducadas. Lo llama el job de retención. */
  purgar(tenantId: string): Promise<{ retos: number; sesiones: number }>;
}
