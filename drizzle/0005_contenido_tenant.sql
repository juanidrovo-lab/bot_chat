-- Contenido por despacho · cierra la regla de §8 que el código no cumplía.
--
-- `textos` lleva solo lo que ese despacho reescribe: una clave que no toque se queda con la
-- de `content.ts`, así que añadir un texto nuevo al guion nunca deja a un cliente sin él.
--
-- `flow_datos` es lo que de verdad bloqueaba. Sin el Flow configurado, la conversación
-- llegaba a pedir los datos y se quedaba esperando una respuesta de formulario que no iba a
-- llegar: el usuario fallaba tres veces contra una puerta cerrada y acababa derivado.

ALTER TABLE tenant_config
  ADD COLUMN IF NOT EXISTS textos jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tenant_config
  ADD COLUMN IF NOT EXISTS flow_datos jsonb;
