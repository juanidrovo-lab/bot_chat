/**
 * Rastro de lo que sale hacia WhatsApp.
 *
 * Existe por dos motivos, y ninguno es «por si acaso»:
 *
 *  - **La alerta 3 de §9** —tasa de error de la API por encima del 5% en diez minutos— no
 *    se puede calcular sin saber cuántos envíos hubo y cuántos fallaron. Un token rotado o
 *    un número suspendido no tumban el proceso: simplemente todo empieza a fallar en
 *    silencio.
 *  - **Las métricas de producto** de §9 necesitan saber en qué estado se quedó cada
 *    conversación, y eso son los turnos, no solo los mensajes que llegaron.
 *
 * Lo que **no** se guarda es el texto que salió. Es el mismo para todos, sale de
 * `content.ts` y se reconstruye con `flow_version`: guardarlo otra vez multiplicaría los
 * datos en reposo sin añadir nada que no se pueda deducir.
 */
export interface SalienteAnotado {
  tenantId: string;
  conversacionId: string;
  /** `texto`, `lista`, `botones`, `audio`, `plantilla`, `formulario`. */
  tipo: string;
  /** El que devuelve Meta, o `null` si el envío falló. */
  waMessageId: string | null;
  /** Nombre del error, ya sin cuerpo de respuesta: puede traer PII. */
  error: string | null;
}

export interface RegistroSalientes {
  anotar(saliente: SalienteAnotado): Promise<void>;
}
