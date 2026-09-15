# Activos del panel

HTMX vendorizado, no pedido a una CDN: un panel con datos de clientes no tiene por qué
darle a un tercero la lista de quién lo abre y cuándo, y así la `Content-Security-Policy`
puede quedarse en `script-src 'self'` sin excepciones.

| Archivo | Origen | Versión |
|---|---|---|
| `htmx.min.js` | `npm pack htmx.org@2.0.7`, `dist/htmx.min.js` | 2.0.7 |

Para actualizarlo:

```bash
npm pack htmx.org@<version>
tar xzf htmx.org-<version>.tgz package/dist/htmx.min.js package/LICENSE
cp package/dist/htmx.min.js estatico/htmx.min.js
cp package/LICENSE estatico/htmx.LICENSE
```

`acceso.js` sí es nuestro: son las dos llamadas a `navigator.credentials`, que no pueden
hacerse desde el servidor.
