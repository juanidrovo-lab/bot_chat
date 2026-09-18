-- El guion pasa a dos opciones: cita o persona. Lo que hacía falta guardar por despacho.
--
--  * `marca`: cómo se llama la aplicación para ese estudio. El panel decía «Providencia»
--    para todos; el primer cliente la quiere con su nombre. Nulo = la de serie.
--  * `abogado_principal`: quién atiende la consulta virtual. El texto promete que «le
--    escribirá en media hora», y prometerlo sin nombre suena a nadie.
--  * `oficina`: dirección y coordenadas. Sin esto el flujo presencial no manda ubicación —
--    no se la inventa— y el resto del guion sigue igual.
--  * `imagen_deposito`: qué imagen de la tabla `audios` lleva la cuenta bancaria. Es una
--    clave, no un `media_id`: el turno la canjea por uno vigente antes de enviar, porque
--    mandar la clave a Meta es un rechazo silencioso.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS marca text;

ALTER TABLE tenant_config ADD COLUMN IF NOT EXISTS abogado_principal text;
ALTER TABLE tenant_config ADD COLUMN IF NOT EXISTS oficina jsonb;
ALTER TABLE tenant_config ADD COLUMN IF NOT EXISTS imagen_deposito text;
