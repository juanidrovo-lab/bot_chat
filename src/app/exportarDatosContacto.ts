/**
 * Portabilidad LOPDP: todo lo que el sistema sabe de un contacto, en JSON.
 *
 * El derecho de acceso obliga a entregar el dato, no a explicarlo, así que esto es un
 * volcado y no un informe. Dos decisiones que sí importan:
 *
 *  - **La exportación se audita.** Entregar el expediente de una persona es el acceso a
 *    datos personales más amplio que permite el sistema; si algo tiene que quedar
 *    registrado, es esto.
 *  - **Los secretos del despacho no salen.** El export es del contacto, no del estudio: ni
 *    tokens, ni identificadores de calendario, ni el `wa_message_id` de Meta.
 */
import type { Auditoria } from './puertos/Auditoria.ts';
import type { RepoExportacion, ExpedienteContacto } from './puertos/RepoExportacion.ts';

export interface DependenciasExportar {
  repo: RepoExportacion;
  auditoria: Auditoria;
}

export class ContactoDesconocidoError extends Error {}

export async function exportarDatosContacto(
  deps: DependenciasExportar,
  peticion: { tenantId: string; contactoId: string; actor: string },
): Promise<ExpedienteContacto> {
  const expediente = await deps.repo.expedienteDe(peticion.tenantId, peticion.contactoId);
  if (expediente === null) {
    throw new ContactoDesconocidoError(`No hay contacto ${peticion.contactoId}`);
  }

  await deps.auditoria.registrar({
    tenantId: peticion.tenantId,
    actor: peticion.actor,
    tipo: 'datos.exportados',
    entidad: 'contacto',
    entidadId: peticion.contactoId,
    // Cuántas filas salieron, no cuáles: la auditoría no puede ser una segunda copia.
    payload: {
      mensajes: expediente.mensajes.length,
      citas: expediente.citas.length,
      conversaciones: expediente.conversaciones.length,
    },
  });

  return expediente;
}
