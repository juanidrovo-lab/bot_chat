/**
 * Versión del guion conversacional.
 *
 * Se estampa en `conversaciones.flow_version` al abrir la conversación. Si no coincide con
 * esta constante, la conversación se reinicia limpiamente al menú (§4.5), nunca con error.
 *
 * Vive en el código y no en una columna de `tenants`: dos fuentes de verdad para lo mismo
 * es justo lo que este campo existe para evitar. **Súbela cada vez que cambien los estados
 * de la máquina de forma incompatible.**
 */
export const FLOW_VERSION = 2;
