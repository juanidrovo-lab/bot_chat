-- Un final normal no es una incidencia.
--
-- Con el guion de toma de datos, toda consulta completa acaba en manos del abogado: el bot
-- recoge el caso y es él quien agenda. Esa derivación se marcaba con `peticion_usuario`, así
-- que la bandeja decía «pidió hablar con una persona» en cada consulta nueva y el informe
-- contaba como derivaciones lo que eran éxitos del guion.
--
-- `ALTER TYPE ... ADD VALUE` sí corre dentro de una transacción desde Postgres 12, siempre
-- que el valor nuevo no se use en la misma transacción. Aquí solo se añade.

ALTER TYPE motivo_derivacion ADD VALUE IF NOT EXISTS 'consulta_lista' BEFORE 'peticion_usuario';
