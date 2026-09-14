import type { Catalogo } from '../../domain/conversacion/acciones.ts';
import type { Contexto } from '../../domain/conversacion/estados.ts';

export interface OpcionCatalogo {
  id: string;
  titulo: string;
  descripcion?: string;
}

export interface PeticionCatalogo {
  tenantId: string;
  contactoId: string;
  contexto: Contexto;
}

/**
 * Lo que el dominio no sabe: qué materias atiende el despacho, qué preguntas tiene el
 * triaje de cada una, qué horarios quedan libres. La máquina emite «ofrece el catálogo X»
 * y esto lo rellena.
 */
export interface Catalogos {
  opciones(catalogo: Catalogo, peticion: PeticionCatalogo): Promise<readonly OpcionCatalogo[]>;
  /** Cuántas preguntas cerradas tiene el triaje de la materia elegida. */
  preguntasTriaje(tenantId: string, materia: string | undefined): Promise<number>;
  /** Datos para interpolar en los textos: honorario, materia, fecha elegida. */
  datosDeTexto(peticion: PeticionCatalogo): Promise<Readonly<Record<string, string>>>;
}
