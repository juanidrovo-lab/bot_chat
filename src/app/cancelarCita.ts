import type { QuienCancela, RepoCitas } from './puertos/RepoCitas.ts';

/**
 * Cancela una cita y libera su horario.
 *
 * Devuelve `false` si ya no estaba activa. Cancelar dos veces no es un error: el botón del
 * recordatorio y el panel del estudio pueden llegar a la vez, y el segundo simplemente no
 * encuentra nada que cancelar. El borrado del evento de Google lo deja escrito el
 * repositorio en `outbox`, dentro de la misma transacción.
 */
export async function cancelarCita(
  repo: RepoCitas,
  tenantId: string,
  citaId: string,
  por: QuienCancela = 'contacto',
): Promise<boolean> {
  return repo.cancelar(tenantId, citaId, por);
}
