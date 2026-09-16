/**
 * Acceso al panel con passkeys (§2).
 *
 * La criptografía la hace el puerto `Passkeys`. Lo que decide este caso de uso es lo otro,
 * que es donde se cometen los fallos de verdad:
 *
 *  - **El reto es de un solo uso y vive en la base.** En memoria, con dos procesos, el
 *    acceso empezaría en uno y terminaría en el otro; sin consumirlo, una respuesta
 *    capturada se puede repetir.
 *  - **El contador del autenticador tiene que avanzar.** Si llega igual o menor, la
 *    credencial está duplicada: es la única señal que da WebAuthn de que alguien clonó la
 *    llave, y descartarla es tirar la defensa.
 *  - **La cookie lleva un testigo aleatorio; la base guarda su hash.** Una copia de la base
 *    no puede bastar para entrar al panel, igual que no basta con una tabla de contraseñas.
 *  - **Un usuario inactivo no entra aunque su passkey sea válida.** Dar de baja a alguien
 *    no puede exigir además borrarle la credencial.
 */
import type { Passkeys } from './puertos/Passkeys.ts';
import { VerificacionFallida } from './puertos/Passkeys.ts';
import type { RepoAuth, SesionPanel, UsuarioPanel } from './puertos/RepoAuth.ts';
import type { Reloj } from './puertos/Reloj.ts';
import type { Auditoria } from './puertos/Auditoria.ts';

/** El reto caduca pronto: es el tiempo de tocar un lector de huella, no el de un café. */
export const VIDA_RETO_MS = 2 * 60_000;
/** Una jornada. Más allá, volver a tocar la huella cuesta dos segundos. */
export const VIDA_SESION_MS = 12 * 60 * 60_000;

export interface DependenciasAuth {
  repo: RepoAuth;
  passkeys: Passkeys;
  reloj: Reloj;
  auditoria: Auditoria;
  /** Testigo de sesión, en hexadecimal. Se inyecta para poder fijarlo en los tests. */
  generarToken: () => string;
  /** Hash del testigo. El adaptador usa SHA-256; `app` no puede importar `platform`. */
  hashear: (token: string) => string;
}

export class AccesoDenegado extends Error {
  constructor(motivo: string) {
    super(motivo);
    // El `name` no es cosmético: el mensaje se redacta antes de llegar al log —puede traer
    // los parámetros de una consulta— y esto es lo único que sobrevive para saber qué pasó.
    this.name = 'AccesoDenegado';
  }
}

/**
 * Un despliegue sin WebAuthn configurado no puede dejar entrar a nadie, y tampoco puede
 * responder con un 500 que parezca una caída: es una negativa, y como tal se trata.
 */
async function conCeremonia<T>(hacer: () => Promise<T>): Promise<T> {
  try {
    return await hacer();
  } catch (error) {
    if (error instanceof VerificacionFallida) throw new AccesoDenegado('no se pudo iniciar');
    throw error;
  }
}

export interface Acceso {
  token: string;
  expiraAt: Date;
  usuario: UsuarioPanel;
}

/**
 * Alta de la primera passkey, contra una invitación de un solo uso.
 *
 * No se da de alta por correo a propósito: un formulario que acepta una dirección y
 * responde distinto según exista o no es un comprobador de quién trabaja en el estudio. El
 * administrador acuña el testigo y lo entrega; quien lo tenga puede registrar **una**
 * credencial, y por eso caduca y se quema.
 */
export async function iniciarRegistro(
  deps: DependenciasAuth,
  peticion: { tenantId: string; invitacion: string },
): Promise<unknown> {
  const usuario = await deps.repo.usuarioPorInvitacion(
    peticion.tenantId,
    deps.hashear(peticion.invitacion),
  );
  if (usuario === null) throw new AccesoDenegado('no se puede registrar');

  const existentes = await deps.repo.credencialesDe(peticion.tenantId, usuario.id);

  const { opciones, reto } = await conCeremonia(() =>
    deps.passkeys.opcionesDeRegistro({
      id: usuario.id,
      email: usuario.email,
      nombre: usuario.nombre,
      credencialesExistentes: existentes.map((c) => c.credencialId),
    }),
  );

  await deps.repo.guardarReto(
    peticion.tenantId,
    reto,
    'registro',
    usuario.id,
    new Date(deps.reloj.ahoraMs() + VIDA_RETO_MS),
  );

  return opciones;
}

export async function terminarRegistro(
  deps: DependenciasAuth,
  peticion: { tenantId: string; reto: string; respuesta: unknown; apodo?: string },
): Promise<void> {
  const consumido = await deps.repo.consumirReto(peticion.tenantId, peticion.reto, 'registro');
  if (!consumido.valido || consumido.usuarioId === null) {
    throw new AccesoDenegado('el reto no es válido');
  }

  let credencial;
  try {
    credencial = await deps.passkeys.verificarRegistro(peticion.respuesta, peticion.reto);
  } catch (error) {
    if (error instanceof VerificacionFallida) throw new AccesoDenegado('el registro no cuadra');
    throw error;
  }

  await deps.repo.guardarCredencial(
    peticion.tenantId,
    consumido.usuarioId,
    credencial,
    peticion.apodo ?? null,
  );

  // La invitación se quema **después** de guardar la credencial: al revés, un fallo al
  // guardar dejaría al abogado sin passkey y sin forma de volver a intentarlo.
  await deps.repo.consumirInvitacion(peticion.tenantId, consumido.usuarioId);

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: `usuario:${consumido.usuarioId}`,
    tipo: 'passkey.registrada',
    entidad: 'usuario',
    entidadId: consumido.usuarioId,
  });
}

export async function iniciarAcceso(
  deps: DependenciasAuth,
  peticion: { tenantId: string },
): Promise<unknown> {
  const { opciones, reto } = await conCeremonia(() => deps.passkeys.opcionesDeAcceso());

  await deps.repo.guardarReto(
    peticion.tenantId,
    reto,
    'acceso',
    null,
    new Date(deps.reloj.ahoraMs() + VIDA_RETO_MS),
  );

  return opciones;
}

export async function terminarAcceso(
  deps: DependenciasAuth,
  peticion: { tenantId: string; reto: string; credencialId: string; respuesta: unknown },
): Promise<Acceso> {
  const consumido = await deps.repo.consumirReto(peticion.tenantId, peticion.reto, 'acceso');
  if (!consumido.valido) throw new AccesoDenegado('el reto no es válido');

  const credenciales = await deps.repo.credencialesDelDespacho(peticion.tenantId);
  const credencial = credenciales.find((c) => c.credencialId === peticion.credencialId);
  if (credencial === undefined) throw new AccesoDenegado('credencial desconocida');

  let verificado;
  try {
    verificado = await deps.passkeys.verificarAcceso(peticion.respuesta, peticion.reto, credencial);
  } catch (error) {
    if (error instanceof VerificacionFallida) throw new AccesoDenegado('la firma no cuadra');
    throw error;
  }

  /**
   * El contador tiene que avanzar. Un autenticador que devuelve siempre 0 no lo lleva —y es
   * legítimo, muchas passkeys sincronizadas no cuentan—, pero uno que sí lo lleva y repite
   * un valor ya visto está duplicado.
   */
  if (verificado.contador !== 0 && verificado.contador <= credencial.contador) {
    await deps.auditoria.registrar({
      tenantId: peticion.tenantId,
      actor: `usuario:${credencial.usuarioId}`,
      tipo: 'passkey.contador_sospechoso',
      entidad: 'usuario',
      entidadId: credencial.usuarioId,
      payload: { visto: credencial.contador, recibido: verificado.contador },
    });
    throw new AccesoDenegado('el contador del autenticador no avanzó');
  }

  const sesion = await abrirSesion(deps, peticion.tenantId, credencial.usuarioId);

  await deps.repo.anotarUso(peticion.tenantId, credencial.credencialId, verificado.contador);

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: `usuario:${credencial.usuarioId}`,
    tipo: 'sesion.abierta',
    entidad: 'usuario',
    entidadId: credencial.usuarioId,
  });

  return sesion;
}

/**
 * Acceso con clave compartida, **solo para desarrollo**.
 *
 * Existe porque registrar una passkey en una máquina de desarrollo exige Windows Hello o un
 * autenticador virtual, y eso convierte «enseñar el panel» en media tarde de trámites. Pero
 * es exactamente lo que `CLAUDE.md` llama un «mientras tanto»: una segunda puerta que no
 * necesita dispositivo, y que si sobrevive al despliegue deja la agenda del estudio abierta
 * a quien encuentre la URL.
 *
 * Por eso no se apaga con un `if`, sino con la ausencia de una clave:
 *
 *  - **Sin `PANEL_CLAVE_DESARROLLO` la ruta no existe**, no es que responda 401. Un
 *    despliegue normal no tiene por dónde intentarlo.
 *  - **Con esa variable y `NODE_ENV=production`, el proceso no arranca.** Es la única forma
 *    de que no se despliegue por descuido: un aviso en el log lo lee quien mira el log.
 *  - **La comparación es en tiempo constante**, como la firma del webhook. Aunque sea de
 *    desarrollo, una clave que se puede adivinar carácter a carácter es una costumbre que se
 *    copia al siguiente sitio.
 *  - **Queda auditado con su propio tipo.** En `eventos` se distingue de una entrada
 *    legítima: si algún día aparece en la auditoría de un despacho real, eso es el incidente.
 */
export async function accesoPorClave(
  deps: DependenciasAuth,
  peticion: { tenantId: string; email: string; clave: string; esperada: string; iguales: (a: string, b: string) => boolean },
): Promise<Acceso> {
  if (peticion.esperada === '') throw new AccesoDenegado('no hay clave de desarrollo');
  if (!peticion.iguales(peticion.clave, peticion.esperada)) {
    throw new AccesoDenegado('la clave no cuadra');
  }

  const usuarios = await deps.repo.usuariosDelDespacho(peticion.tenantId);
  const usuario = usuarios.find((u) => u.email === peticion.email);
  if (usuario === undefined) throw new AccesoDenegado('ese usuario no es de este despacho');

  const sesion = await abrirSesion(deps, peticion.tenantId, usuario.id);

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: `usuario:${usuario.id}`,
    // Tipo propio, no `sesion.abierta`: esto no es una entrada legítima y el rastro tiene
    // que poder distinguirlas sin leer el código.
    tipo: 'sesion.abierta_con_clave_desarrollo',
    entidad: 'usuario',
    entidadId: usuario.id,
  });

  return sesion;
}

/** Los usuarios entre los que elegir en esa pantalla. Solo se llama en modo desarrollo. */
export async function usuariosParaClave(
  deps: DependenciasAuth,
  tenantId: string,
): Promise<UsuarioPanel[]> {
  return deps.repo.usuariosDelDespacho(tenantId);
}

async function abrirSesion(
  deps: DependenciasAuth,
  tenantId: string,
  usuarioId: string,
): Promise<Acceso> {
  const token = deps.generarToken();
  const hash = deps.hashear(token);
  const expiraAt = new Date(deps.reloj.ahoraMs() + VIDA_SESION_MS);

  await deps.repo.crearSesion(tenantId, usuarioId, hash, expiraAt);

  // Relectura en vez de construir el usuario aquí: la sesión que devolvemos es la que el
  // resto del panel va a leer, con las mismas condiciones —activo, no caducada—.
  const sesion = await deps.repo.sesionPorHash(tenantId, hash);
  if (sesion === null) throw new AccesoDenegado('la sesión no se pudo abrir');

  return { token, expiraAt, usuario: sesion.usuario };
}

/** Resuelve la cookie a una sesión viva. `null` si caducó, no existe o el usuario está de baja. */
export async function sesionDe(
  deps: DependenciasAuth,
  tenantId: string,
  token: string,
): Promise<SesionPanel | null> {
  return deps.repo.sesionPorHash(tenantId, deps.hashear(token));
}

export async function cerrarSesion(
  deps: DependenciasAuth,
  tenantId: string,
  token: string,
): Promise<void> {
  await deps.repo.cerrarSesion(tenantId, deps.hashear(token));
}
