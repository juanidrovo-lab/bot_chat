/**
 * Los casos de uso del panel.
 *
 * Lo que distingue a estos de los del bot: **cada lectura de datos personales se audita**.
 * No es una sobrecarga defensiva, es el requisito de la LOPDP que hace que «quién vio la
 * ficha de esta persona» tenga respuesta. Por eso la ficha se pide por un caso de uso y no
 * leyendo el repositorio desde la ruta HTTP: si la auditoría fuera opcional, algún día se
 * olvidaría.
 */
import type { Auditoria } from './puertos/Auditoria.ts';
import type { Reloj } from './puertos/Reloj.ts';
import type {
  CitaDelDia,
  ContactoEncontrado,
  ConversacionEnBandeja,
  FichaContacto,
  RepoPanel,
} from './puertos/RepoPanel.ts';

export interface DependenciasPanel {
  repo: RepoPanel;
  auditoria: Auditoria;
  reloj: Reloj;
}

export interface Peticion {
  tenantId: string;
  actor: string;
}

export interface HoyManana {
  dias: { dia: string; etiqueta: string; citas: CitaDelDia[] }[];
  bandeja: ConversacionEnBandeja[];
}

/**
 * La pantalla principal. Devuelve los dos días **siempre**, aunque estén vacíos: una tabla
 * que aparece y desaparece según haya citas obliga a mirar dos veces para saber si «mañana»
 * está libre o si la consulta falló.
 */
export async function hoyManana(deps: DependenciasPanel, peticion: Peticion): Promise<HoyManana> {
  const [hoy, manana] = deps.reloj.diasDesdeHoy(2);
  if (hoy === undefined || manana === undefined) throw new Error('el reloj no devolvió dos días');

  const desdeMs = deps.reloj.instanteLocal(hoy, 0);
  const hastaMs = deps.reloj.instanteLocal(manana, 24 * 60);

  const [citas, bandeja] = await Promise.all([
    deps.repo.citasEntre(peticion.tenantId, desdeMs, hastaMs),
    deps.repo.bandeja(peticion.tenantId, LIMITE_BANDEJA),
  ]);

  return {
    // El día local de cada cita lo resuelve el reloj, no la consulta: `adapters/postgres`
    // no sabe qué zona horaria es la del despacho, y no tiene por qué saberlo.
    dias: [hoy, manana].map((dia) => ({
      dia,
      etiqueta: deps.reloj.formatearDia(dia),
      citas: citas.filter((c) => deps.reloj.diaLocal(c.iniciaAt.getTime()) === dia),
    })),
    bandeja,
  };
}

/** Cabe en una pantalla; si hay más, el problema no es de paginación. */
export const LIMITE_BANDEJA = 50;

export async function verFicha(
  deps: DependenciasPanel,
  peticion: Peticion & { contactoId: string },
): Promise<FichaContacto | null> {
  const ficha = await deps.repo.ficha(peticion.tenantId, peticion.contactoId);
  // Un contacto que no existe no es un acceso a datos personales: no hay dato al que
  // acceder. Auditarlo solo serviría para llenar la tabla probando identificadores.
  if (ficha === null) return null;

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: 'contacto.visto',
    entidad: 'contacto',
    entidadId: peticion.contactoId,
  });

  return ficha;
}

/** Cabe en la caja del buscador sin convertirse en un volcado de la agenda. */
export const LIMITE_BUSQUEDA = 10;
/** Por debajo de esto no se busca: una sola letra devuelve medio despacho. */
export const MINIMO_BUSQUEDA = 2;

/**
 * Buscar contactos por nombre o número.
 *
 * Es la única pantalla que alcanza a quien no tiene cita hoy ni mañana, que es justo la
 * llamada que entra: «habló el señor Pérez, ¿cuándo viene?».
 *
 * **Se audita, pero no la consulta.** Una búsqueda que devuelve resultados revela nombres,
 * así que es acceso a datos personales y deja rastro; lo que queda registrado es cuántos
 * contactos se expusieron, nunca el texto tecleado — que suele ser, precisamente, el nombre
 * de una persona.
 */
export async function buscarContactos(
  deps: DependenciasPanel,
  peticion: Peticion & { texto: string },
): Promise<ContactoEncontrado[]> {
  const texto = peticion.texto.trim();
  if (texto.length < MINIMO_BUSQUEDA) return [];

  const encontrados = await deps.repo.buscarContactos(peticion.tenantId, texto, LIMITE_BUSQUEDA);
  // Una búsqueda sin resultados no expuso a nadie. Auditarla solo llenaría la tabla de
  // ruido con cada tecla que se pulsa.
  if (encontrados.length === 0) return encontrados;

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: 'contactos.buscados',
    payload: { resultados: encontrados.length },
  });

  return encontrados;
}

/**
 * El abogado marca si el contacto vino o no.
 *
 * Sin esto la **tasa de ausencias** no existe, y es la métrica con la que el estudio va a
 * decidir si renueva: es la que justifica que el bot mande recordatorios con botones.
 */
export async function marcarAsistencia(
  deps: DependenciasPanel,
  peticion: Peticion & { citaId: string; vino: boolean },
): Promise<boolean> {
  const marcada = await deps.repo.marcarAsistencia(peticion.tenantId, peticion.citaId, peticion.vino);
  if (!marcada) return false;

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: peticion.vino ? 'cita.atendida' : 'cita.ausente',
    entidad: 'cita',
    entidadId: peticion.citaId,
  });

  return true;
}

export async function cerrarConversacion(
  deps: DependenciasPanel,
  peticion: Peticion & { conversacionId: string },
): Promise<boolean> {
  const cerrada = await deps.repo.cerrarConversacion(peticion.tenantId, peticion.conversacionId);
  if (!cerrada) return false;

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: 'conversacion.cerrada',
    entidad: 'conversacion',
    entidadId: peticion.conversacionId,
  });

  return true;
}

/**
 * Deshacer en vez de «¿está seguro?» (§9).
 *
 * El modal de confirmación castiga a quien acierta —que es casi siempre— para protegerlo
 * de la vez que se equivoca; el deshacer hace lo contrario. Pero solo funciona si lo que se
 * deshace no salió ya del sistema: por eso la cancelación se comete de inmediato y lo que
 * se aplaza diez segundos son los efectos irreversibles, el aviso al contacto y el borrado
 * del evento en Google.
 */
export const GRACIA_MS = 10_000;

export async function cancelarDesdePanel(
  deps: DependenciasPanel,
  peticion: Peticion & { citaId: string },
): Promise<boolean> {
  const cancelada = await deps.repo.cancelarConGracia(peticion.tenantId, peticion.citaId, GRACIA_MS);
  if (!cancelada) return false;

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: 'cita.cancelada',
    entidad: 'cita',
    entidadId: peticion.citaId,
    payload: { graciaMs: GRACIA_MS },
  });

  return true;
}

export async function deshacerCancelacion(
  deps: DependenciasPanel,
  peticion: Peticion & { citaId: string },
): Promise<'restaurada' | 'plazo' | 'ocupado'> {
  const resultado = await deps.repo.deshacerCancelacion(
    peticion.tenantId,
    peticion.citaId,
    GRACIA_MS,
  );
  if (resultado !== 'restaurada') return resultado;

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: 'cita.restaurada',
    entidad: 'cita',
    entidadId: peticion.citaId,
  });

  return resultado;
}
