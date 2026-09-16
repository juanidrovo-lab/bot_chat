-- Conexión del Google Calendar de cada abogado · cierra el punto 10 de §16.
--
-- Sin esto `gcal_calendar_id` y `gcal_refresh_token_enc` no los escribía nadie, así que
-- ningún abogado podía conectar su calendario. El sistema funciona igual —la agenda vive en
-- Postgres y Google es un espejo— pero se pierde la importación de bloqueos, y entonces
-- «horarios realmente libres» solo es cierto respecto de las citas del propio bot: puede
-- ofrecer la hora en que el abogado tiene una audiencia.
--
-- El `state` de OAuth se guarda en `retos`, que ya es una tabla de retos de un solo uso con
-- caducidad y bajo RLS. Le falta decir a qué abogado pertenece, y para eso va `datos`.

ALTER TYPE proposito_reto ADD VALUE IF NOT EXISTS 'google';

ALTER TABLE retos ADD COLUMN IF NOT EXISTS datos jsonb NOT NULL DEFAULT '{}'::jsonb;
