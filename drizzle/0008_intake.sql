-- El guion pasa a ser una toma de datos: el bot recoge el caso y el abogado agenda.
--
-- `aviso_abogado` dice a qué número avisar cuando entra una consulta y con qué plantilla
-- aprobada. Va por plantilla y no por texto porque ese número nunca escribió al bot: su
-- ventana de 24 h está cerrada desde siempre, y un texto libre sería un rechazo de Meta.
-- Sin esto el bot no avisa a nadie, y la consulta queda solo en la bandeja del panel — que
-- basta, pero obliga a que alguien se acuerde de mirarla.

ALTER TABLE tenant_config ADD COLUMN IF NOT EXISTS aviso_abogado jsonb;
