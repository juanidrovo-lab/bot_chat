-- Alta de la primera passkey · fase 7.
--
-- Sin esto nadie puede registrar una credencial y el panel, que falla cerrado, no lo abre
-- nunca nadie. Hacerlo por correo sería un oráculo —cualquiera podría comprobar quién
-- trabaja en el estudio—, así que el administrador acuña un testigo y lo entrega en mano.
--
-- Se guarda el hash y no el testigo, por lo mismo que con la sesión: una copia de la base
-- no puede bastar para darse de alta en el panel.

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS invitacion_hash text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS invitacion_expira_at timestamptz;

-- Único dentro del despacho, como todo lo demás: un índice global se evaluaría por debajo
-- de la RLS y el choque con la fila de otro estudio sería invisible.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_invitacion_unica
  ON usuarios (tenant_id, invitacion_hash)
  WHERE invitacion_hash IS NOT NULL;
