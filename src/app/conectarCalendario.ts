/**
 * Conectar el Google Calendar de un abogado.
 *
 * Lo que decide este caso de uso, y no la biblioteca de Google:
 *
 *  - **El `state` es de un solo uso y vive en la base.** Es lo único que impide que alguien
 *    le haga abrir a un abogado un enlace que conecte *su* calendario a la cuenta del
 *    atacante —o al revés—. Con dos procesos, además, la vuelta de Google puede caer en uno
 *    distinto del que empezó.
 *  - **El `state` dice a qué abogado pertenece**, y eso no se acepta de la URL de vuelta:
 *    si viniera de fuera, cualquiera con sesión podría conectar su calendario al nombre de
 *    otro.
 *  - **El refresh token se cifra antes de tocar la base**, como el resto de secretos.
 */
import type { Auditoria } from './puertos/Auditoria.ts';
import type { OAuthGoogle } from './puertos/OAuthGoogle.ts';
import { ConexionGoogleFallida } from './puertos/OAuthGoogle.ts';
import type { RepoCalendarios } from './puertos/RepoCalendarios.ts';
import type { Reloj } from './puertos/Reloj.ts';

/** Lo que tarda un abogado en elegir cuenta y darle a aceptar, con margen. */
export const VIDA_STATE_MS = 10 * 60_000;

export interface DependenciasCalendario {
  repo: RepoCalendarios;
  oauth: OAuthGoogle;
  reloj: Reloj;
  auditoria: Auditoria;
  /** Aleatorio, en hexadecimal. Se inyecta para poder fijarlo en los tests. */
  generarState: () => string;
  /** El secreto se guarda cifrado; esto lo cifra. */
  cifrar: (valor: string) => string;
}

export class ConexionInvalida extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'ConexionInvalida';
  }
}

export async function iniciarConexion(
  deps: DependenciasCalendario,
  peticion: { tenantId: string; abogadoId: string; redirectUri: string },
): Promise<string> {
  // Que el abogado exista en ESTE despacho se comprueba antes de mandar a nadie a Google:
  // si no, la vuelta traería un id que no es de aquí.
  const abogado = await deps.repo.abogado(peticion.tenantId, peticion.abogadoId);
  if (abogado === null) throw new ConexionInvalida('ese abogado no es de este despacho');

  const state = deps.generarState();
  await deps.repo.guardarState(
    peticion.tenantId,
    state,
    peticion.abogadoId,
    new Date(deps.reloj.ahoraMs() + VIDA_STATE_MS),
  );

  try {
    return deps.oauth.urlDeAutorizacion(state, peticion.redirectUri);
  } catch (error) {
    // Un despliegue sin Google configurado es una negativa, no una caída: la pantalla lo
    // dice y el resto del panel sigue funcionando.
    if (error instanceof ConexionGoogleFallida) throw new ConexionInvalida(error.message);
    throw error;
  }
}

export interface Conectado {
  abogadoId: string;
  calendarId: string;
}

export async function terminarConexion(
  deps: DependenciasCalendario,
  peticion: {
    tenantId: string;
    state: string;
    codigo: string;
    actor: string;
    /** El mismo con el que se pidió la autorización, o Google rechaza el canje. */
    redirectUri: string;
  },
): Promise<Conectado> {
  /**
   * Se consume **antes** de hablar con Google: si el canje falla, el `state` ya no vale y
   * hay que empezar de nuevo. Es lo correcto — un `state` que sobrevive a un intento fallido
   * se puede reutilizar.
   */
  const consumido = await deps.repo.consumirState(peticion.tenantId, peticion.state);
  if (consumido === null) throw new ConexionInvalida('el enlace de conexión ya no vale');

  let conectado;
  try {
    conectado = await deps.oauth.canjear(peticion.codigo, peticion.redirectUri);
  } catch (error) {
    if (error instanceof ConexionGoogleFallida) throw new ConexionInvalida(error.message);
    throw error;
  }

  await deps.repo.guardarCalendario(
    peticion.tenantId,
    consumido.abogadoId,
    conectado.calendarId,
    deps.cifrar(conectado.refreshToken),
  );

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: 'calendario.conectado',
    entidad: 'abogado',
    entidadId: consumido.abogadoId,
  });

  return { abogadoId: consumido.abogadoId, calendarId: conectado.calendarId };
}

/**
 * Desconectar borra el token, no los bloqueos ya importados.
 *
 * Vaciarlos convertiría una desconexión en horarios ocupados ofrecidos como libres, que es
 * justo lo que la importación existe para evitar. Envejecen solos: la siguiente pasada del
 * sincronizador ya no los renueva.
 */
export async function desconectar(
  deps: DependenciasCalendario,
  peticion: { tenantId: string; abogadoId: string; actor: string },
): Promise<void> {
  await deps.repo.olvidarCalendario(peticion.tenantId, peticion.abogadoId);

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: 'calendario.desconectado',
    entidad: 'abogado',
    entidadId: peticion.abogadoId,
  });
}
