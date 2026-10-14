-- Identidad del contacto cuando WhatsApp deja de mandar el teléfono.
--
-- Quien adopta un nombre de usuario en WhatsApp puede ocultar su número. El webhook trae
-- entonces `user_id` —el Business-Scoped User ID, estable para este despacho— en lugar de
-- `from`. `wa_id` sigue siendo «la dirección a la que se contesta» (el teléfono cuando lo
-- hay, el BSUID cuando no) y esta columna guarda el BSUID aparte, que es lo único que
-- permite reconocer a la misma persona cuando el teléfono deja de venir.
--
-- Aquí solo se guarda: NO se funden filas ni se repunta `wa_id`. Fundir dos contactos es
-- irreversible y depende de un comportamiento de la API que hay que confirmar antes.
--
-- El índice es único por tenant y parcial: ningún UNIQUE cruza despachos (§6), y las filas
-- sin BSUID —hoy, todas— no compiten entre sí.

ALTER TABLE contactos ADD COLUMN IF NOT EXISTS bsuid text;

CREATE UNIQUE INDEX IF NOT EXISTS contactos_bsuid_unico
  ON contactos (tenant_id, bsuid)
  WHERE bsuid IS NOT NULL;
