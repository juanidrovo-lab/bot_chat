/**
 * Las vistas del panel, en HTML servido.
 *
 * **Por qué `hono/html` y no Hono JSX.** El proyecto corre TypeScript sin paso de
 * compilación, y la elisión de tipos de Node borra anotaciones: no transforma JSX. Un
 * `.tsx` obligaría a meter un bundler para tres pantallas, que es exactamente lo que §2
 * quería evitar. El `html` etiquetado es la misma biblioteca, escapa por defecto y no
 * necesita nada más.
 *
 * HTMX se carga desde `/panel/estatico/htmx.js`, servido por el propio proceso: un panel
 * con datos de clientes no tiene por qué pedirle un script a una CDN de terceros, y así la
 * cabecera `Content-Security-Policy` puede quedarse en `self`.
 */
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type {
  CitaDelDia,
  ContactoEncontrado,
  ConversacionEnBandeja,
  FichaContacto,
} from '../../../app/puertos/RepoPanel.ts';
import type { HoyManana } from '../../../app/panel.ts';
import type { Informe } from '../../../app/metricas.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const MOTIVOS: Readonly<Record<string, string>> = {
  peticion_usuario: 'Pidió hablar con una persona',
  tres_fallos: 'Se trabó tres veces',
  error_sistema: 'Error del sistema',
};

/**
 * Los estilos van en línea y cabe todo aquí: son cuarenta reglas. Densidad alta, tabla y
 * buscador arriba, como pide §9; contraste AA y foco visible, que es lo que hace que el
 * panel se pueda usar con el teclado mientras se atiende el teléfono.
 */
const ESTILOS = `
  :root {
    color-scheme: light dark;
    --fondo: #ffffff; --texto: #16181d; --tenue: #5b6270;
    --linea: #d8dce4; --acento: #1b4d8f; --alerta: #8c2f14; --suave: #f4f6fa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fondo: #14161a; --texto: #eceef2; --tenue: #a0a7b4;
      --linea: #2c3038; --acento: #7fb0ef; --alerta: #f0a58c; --suave: #1c1f25;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--fondo); color: var(--texto);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap;
    padding: .75rem 1rem; border-bottom: 1px solid var(--linea);
  }
  header h1 { font-size: 1.05rem; margin: 0; }
  header .quien { color: var(--tenue); font-size: .85rem; margin-left: auto; }
  main { padding: 1rem; max-width: 72rem; }
  h2 { font-size: .95rem; text-transform: uppercase; letter-spacing: .04em; color: var(--tenue); margin: 1.5rem 0 .5rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--linea); vertical-align: top; }
  th { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--tenue); }
  tr:hover td { background: var(--suave); }
  .hora { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .vacio { color: var(--tenue); padding: .6rem; }
  button, .boton {
    font: inherit; padding: .25rem .6rem; border: 1px solid var(--linea);
    border-radius: .3rem; background: var(--fondo); color: var(--texto); cursor: pointer;
  }
  button:hover { background: var(--suave); }
  button.peligro { color: var(--alerta); border-color: var(--alerta); }
  :focus-visible { outline: 2px solid var(--acento); outline-offset: 2px; }
  input[type=search] { font: inherit; padding: .35rem .5rem; border: 1px solid var(--linea); border-radius: .3rem; width: 18rem; background: var(--fondo); color: var(--texto); }
  .ficha { background: var(--suave); }
  .ficha dl { display: grid; grid-template-columns: auto 1fr; gap: .2rem .8rem; margin: 0; }
  .ficha dt { color: var(--tenue); }
  .aviso {
    display: flex; gap: .8rem; align-items: center; margin: .6rem 0;
    padding: .5rem .8rem; border: 1px solid var(--acento); border-radius: .3rem;
  }
  .oculto { display: none; }
  .tenue { color: var(--tenue); }
`;

/**
 * Todas las rutas cuelgan de `base` —`/panel/<slug>`—: el despacho va en la URL igual que
 * el `phone_number_id` va en el cuerpo del webhook, porque la página de acceso tiene que
 * saber de qué estudio es **antes** de que exista una sesión de la que deducirlo.
 */
export function pagina(base: string, titulo: string, contenido: Html, usuario?: string): Html {
  return html`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${titulo} · Providencia</title>
    <style>${raw(ESTILOS)}</style>
    <script src="/panel/estatico/htmx.js" defer></script>
  </head>
  <body>
    <header>
      <h1>Providencia</h1>
      ${usuario === undefined ? '' : html`<span class="quien">${usuario} · <a href="${base}/salir">salir</a></span>`}
    </header>
    <main>${contenido}</main>
  </body>
</html>`;
}

function horaDe(fecha: Date, formatearHora: (ms: number) => string): string {
  return formatearHora(fecha.getTime());
}

/**
 * Una cita que ya empezó ofrece marcar asistencia; una futura, cancelar.
 *
 * Es la misma columna porque son la misma decisión en momentos distintos, y así el abogado
 * no tiene que buscar el botón: a las nueve de la mañana la fila dice «cancelar» y a las
 * diez dice «vino / faltó».
 */
const yaEmpezo = (c: CitaDelDia): boolean => c.iniciaAt.getTime() <= Date.now();

export function tablaCitas(
  base: string,
  citas: readonly CitaDelDia[],
  formatearHora: (ms: number) => string,
): Html {
  if (citas.length === 0) return html`<p class="vacio">Sin citas.</p>`;

  return html`<table>
    <thead>
      <tr><th>Hora</th><th>Contacto</th><th>Materia</th><th>Abogado</th><th>Estado</th><th></th></tr>
    </thead>
    <tbody>
      ${citas.map(
        (c) => html`<tr id="cita-${c.id}">
          <td class="hora">${horaDe(c.iniciaAt, formatearHora)}</td>
          <td>
            <button
              type="button"
              hx-get="${base}/contactos/${c.contactoId}"
              hx-target="#ficha-${c.contactoId}"
              hx-swap="innerHTML"
              aria-expanded="false"
            >${c.contactoNombre ?? c.contactoWaId}</button>
          </td>
          <td>${c.materia} · ${c.modalidad}</td>
          <td>${c.abogadoNombre}</td>
          <td>${c.estado}</td>
          <td>
            ${yaEmpezo(c)
              ? html`<button
                    type="button"
                    hx-post="${base}/citas/${c.id}/asistencia?vino=si"
                    hx-target="#cita-${c.id}"
                    hx-swap="outerHTML"
                  >Vino</button>
                  <button
                    type="button"
                    hx-post="${base}/citas/${c.id}/asistencia?vino=no"
                    hx-target="#cita-${c.id}"
                    hx-swap="outerHTML"
                  >Faltó</button>`
              : html`<button
                  type="button"
                  class="peligro"
                  hx-post="${base}/citas/${c.id}/cancelar"
                  hx-target="#cita-${c.id}"
                  hx-swap="outerHTML"
                >Cancelar</button>`}
          </td>
        </tr>
        <tr class="ficha"><td colspan="6" id="ficha-${c.contactoId}"></td></tr>`,
      )}
    </tbody>
  </table>`;
}

/**
 * Deshacer en vez de «¿está seguro?» (§9). El aviso se borra solo a los diez segundos
 * —`hx-trigger="load delay:10s"` sobre sí mismo— porque pasado el plazo el deshacer ya no
 * puede funcionar y dejar el botón puesto sería prometer algo que no se cumple.
 */
export function avisoCancelada(base: string, citaId: string, segundos: number): Html {
  return html`<tr id="cita-${citaId}">
    <td colspan="6">
      <div class="aviso" role="status">
        <span>Cita cancelada.</span>
        <button
          type="button"
          hx-post="${base}/citas/${citaId}/deshacer"
          hx-target="#cita-${citaId}"
          hx-swap="outerHTML"
        >Deshacer</button>
        <span
          hx-get="${base}/vacio"
          hx-trigger="load delay:${segundos}s"
          hx-target="#cita-${citaId}"
          hx-swap="outerHTML"
        ></span>
      </div>
    </td>
  </tr>`;
}

export function filaRestaurada(base: string, citaId: string): Html {
  return html`<tr id="cita-${citaId}">
    <td colspan="6">
      <div class="aviso" role="status">
        <span>Cita restaurada. <a href="${base}">Recargar</a> para verla en su sitio.</span>
      </div>
    </td>
  </tr>`;
}

export function filaNoSePudo(citaId: string, motivo: string): Html {
  return html`<tr id="cita-${citaId}">
    <td colspan="6"><div class="aviso" role="status"><span>${motivo}</span></div></td>
  </tr>`;
}

export function fichaContacto(
  base: string,
  ficha: FichaContacto,
  formatearFechaHora: (ms: number) => string,
): Html {
  return html`<dl>
    <dt>WhatsApp</dt><dd>${ficha.waId}</dd>
    <dt>Nombre</dt><dd>${ficha.nombre ?? '—'}</dd>
    <dt>Correo</dt><dd>${ficha.email ?? '—'}</dd>
    <dt>Cédula</dt><dd>${ficha.cedula ?? '—'}</dd>
    <dt>Consentimiento</dt>
    <dd>
      ${ficha.consentRevocadoAt !== null
        ? 'revocado'
        : ficha.consentAt === null
          ? 'sin registrar'
          : formatearFechaHora(ficha.consentAt.getTime())}
    </dd>
    <dt>Historial</dt>
    <dd>
      ${ficha.citas.length === 0
        ? '—'
        : html`<ul>
            ${ficha.citas.map(
              (c) => html`<li>${formatearFechaHora(c.iniciaAt.getTime())} · ${c.materia} · ${c.estado}</li>`,
            )}
          </ul>`}
    </dd>
  </dl>
  <p>
    <a class="boton" href="${base}/contactos/${ficha.id}/export.json">Exportar datos (LOPDP)</a>
    <button
      type="button"
      class="${ficha.bloqueado ? '' : 'peligro'}"
      hx-post="${base}/contactos/${ficha.id}/bloqueo?bloquear=${ficha.bloqueado ? 'no' : 'si'}"
      hx-target="#ficha-${ficha.id}"
      hx-swap="innerHTML"
    >${ficha.bloqueado ? 'Desbloquear' : 'Bloquear'}</button>
    ${ficha.bloqueado ? html`<span class="tenue">El bot no le contesta.</span>` : ''}
  </p>`;
}

export function tablaBandeja(
  base: string,
  conversaciones: readonly ConversacionEnBandeja[],
  formatearFechaHora: (ms: number) => string,
): Html {
  if (conversaciones.length === 0) return html`<p class="vacio">Nadie esperando.</p>`;

  return html`<table>
    <thead><tr><th>Desde</th><th>Contacto</th><th>Motivo</th><th>Estado</th><th></th></tr></thead>
    <tbody>
      ${conversaciones.map(
        (cv) => html`<tr id="conv-${cv.id}">
          <td class="hora">${formatearFechaHora(cv.derivadaAt.getTime())}</td>
          <td>${cv.contactoNombre ?? cv.contactoWaId}</td>
          <td>${MOTIVOS[cv.motivo] ?? cv.motivo}</td>
          <td>${cv.estado}</td>
          <td>
            <button
              type="button"
              hx-post="${base}/conversaciones/${cv.id}/cerrar"
              hx-target="#conv-${cv.id}"
              hx-swap="outerHTML"
            >Atendida</button>
          </td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

export function pantallaHoyManana(
  base: string,
  datos: HoyManana,
  formatos: { hora: (ms: number) => string; fechaHora: (ms: number) => string },
  usuario: string,
): Html {
  return pagina(
    base,
    'Hoy y mañana',
    html`
      <label for="buscador" class="oculto">Buscar</label>
      <input id="buscador" type="search" placeholder="Buscar por nombre o número"
             hx-get="${base}/buscar" hx-trigger="input changed delay:300ms"
             hx-target="#resultados" name="q" />
      <div id="resultados"></div>

      ${datos.dias.map(
        (d) => html`<h2>${d.etiqueta}</h2>${tablaCitas(base, d.citas, formatos.hora)}`,
      )}

      <h2>Esperando a una persona</h2>
      ${tablaBandeja(base, datos.bandeja, formatos.fechaHora)}

      <p><a href="${base}/metricas">Ver métricas del mes</a></p>
    `,
    usuario,
  );
}

/**
 * Alta de la primera passkey. El testigo viaja en la URL, y por eso la política de
 * `Referrer-Policy: no-referrer` de `rutas.ts` no es decorativa: sin ella, cualquier enlace
 * que el abogado pulsara después se llevaría la invitación en la cabecera.
 */
export function pantallaAlta(base: string, invitacion: string, nombre: string): Html {
  return pagina(
    base,
    'Registrar passkey',
    html`
      <h2>Hola, ${nombre}</h2>
      <p class="aviso" role="alert" id="aviso"></p>
      <p>Registre este dispositivo para entrar al panel. No habrá contraseña.</p>
      <button type="button" id="registrar">Registrar este dispositivo</button>
      <script
        src="/panel/estatico/acceso.js"
        data-base="${base}"
        data-invitacion="${invitacion}"
        defer
      ></script>
    `,
  );
}

export function pantallaAltaUsada(base: string): Html {
  return pagina(
    base,
    'Registrar passkey',
    html`
      <h2>Esa invitación ya no sirve</h2>
      <p>Se usó o caducó. Pida una nueva al administrador del estudio.</p>
      <p><a href="${base}">Ir al acceso</a></p>
    `,
  );
}

export function pantallaAltaHecha(base: string): Html {
  return pagina(
    base,
    'Registrar passkey',
    html`
      <h2>Listo</h2>
      <p>Ya puede entrar con la huella o la cara de este dispositivo.</p>
      <p><a href="${base}">Entrar al panel</a></p>
    `,
  );
}

export function pantallaAcceso(base: string, mensaje?: string): Html {
  return pagina(
    base,
    'Entrar',
    html`
      <h2>Entrar al panel</h2>
      <p class="aviso" role="alert" id="aviso">${mensaje ?? ''}</p>
      <p>Se entra con la huella o la cara del dispositivo. No hay contraseña que robar.</p>
      <button type="button" id="entrar">Entrar</button>
      <script src="/panel/estatico/acceso.js" data-base="${base}" defer></script>
    `,
  );
}

/** Resultados del buscador, dentro de `#resultados`. */
export function resultadosBusqueda(
  base: string,
  encontrados: readonly ContactoEncontrado[],
  texto: string,
  formatearFechaHora: (ms: number) => string,
): Html {
  if (texto.trim().length < 2) return html``;
  if (encontrados.length === 0) return html`<p class="vacio">Nadie con ese nombre ni ese número.</p>`;

  return html`<table>
    <thead><tr><th>Contacto</th><th>WhatsApp</th><th>Próxima cita</th></tr></thead>
    <tbody>
      ${encontrados.map(
        (c) => html`<tr>
          <td>
            <button
              type="button"
              hx-get="${base}/contactos/${c.id}"
              hx-target="#ficha-busqueda-${c.id}"
              hx-swap="innerHTML"
            >${c.nombre ?? '(sin nombre)'}</button>
          </td>
          <td>${c.waId}</td>
          <td class="hora">
            ${c.proximaCitaAt === null ? '—' : formatearFechaHora(c.proximaCitaAt.getTime())}
          </td>
        </tr>
        <tr class="ficha"><td colspan="3" id="ficha-busqueda-${c.id}"></td></tr>`,
      )}
    </tbody>
  </table>`;
}

export function filaAsistencia(citaId: string, vino: boolean): Html {
  return html`<tr id="cita-${citaId}">
    <td colspan="6">
      <div class="aviso" role="status">
        <span>${vino ? 'Marcada como atendida.' : 'Marcada como ausente.'}</span>
      </div>
    </td>
  </tr>`;
}

/**
 * Las cinco métricas de §9.
 *
 * Un porcentaje sin denominador es propaganda, así que cada uno lleva el suyo al lado. Y
 * cuando la muestra es pequeña no se enseña el número: se dice que no hay datos suficientes,
 * que es la verdad y evita que alguien tome una decisión sobre tres citas.
 */
export function pantallaMetricas(base: string, informe: Informe, usuario: string): Html {
  const dato = (valor: number | null, sufijo = '%'): string =>
    valor === null ? '—' : `${valor}${sufijo}`;

  return pagina(
    base,
    'Métricas',
    html`
      <p><a href="${base}">← Hoy y mañana</a></p>
      <h2>Del ${informe.desde} al ${informe.hasta}</h2>

      ${informe.advertencias.length === 0
        ? ''
        : html`<div class="aviso" role="status">
            <span>${informe.advertencias.join(' ')}</span>
          </div>`}

      <table>
        <thead><tr><th>Métrica</th><th>Valor</th><th>Sobre</th></tr></thead>
        <tbody>
          <tr>
            <td>Conversaciones</td>
            <td class="hora">${informe.conversaciones}</td>
            <td></td>
          </tr>
          <tr>
            <td>Citas por cada 100 conversaciones</td>
            <td class="hora">${dato(informe.porcentajes.citasPorCien, '')}</td>
            <td>${informe.conCita} de ${informe.conversaciones}</td>
          </tr>
          <tr>
            <td>Derivadas a una persona</td>
            <td class="hora">${dato(informe.porcentajes.derivacionesPorCien)}</td>
            <td>${informe.derivadas} de ${informe.conversaciones}</td>
          </tr>
          <tr>
            <td>Ausencias</td>
            <td class="hora">${dato(informe.porcentajes.ausenciasPorCien)}</td>
            <td>${informe.citasAusentes} de ${informe.citasMarcadas} marcadas</td>
          </tr>
        </tbody>
      </table>

      <h2>Dónde se quedan las que no acaban</h2>
      ${informe.abandono.length === 0
        ? html`<p class="vacio">Ninguna conversación quedó a medias.</p>`
        : html`<table>
            <thead><tr><th>Estado</th><th>Conversaciones</th></tr></thead>
            <tbody>
              ${informe.abandono.map(
                (a) => html`<tr><td>${a.estado}</td><td class="hora">${a.total}</td></tr>`,
              )}
            </tbody>
          </table>`}
    `,
    usuario,
  );
}
