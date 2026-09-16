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
 *
 * **Cómo se decide qué se ve.** Quien abre esto es un abogado entre dos llamadas. Lo que
 * necesita saber sin buscarlo es: a qué hora es la próxima cita, quién viene, y quién está
 * esperando a que le contesten. Todo lo demás —métricas, calendarios— está a un clic de la
 * barra, no enterrado al final de la página. Los estilos viven en `estilos.ts`.
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
import type { AbogadoConCalendario } from '../../../app/puertos/RepoCalendarios.ts';
import { ESTILOS } from './estilos.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const MOTIVOS: Readonly<Record<string, string>> = {
  peticion_usuario: 'Pidió hablar con una persona',
  tres_fallos: 'Se trabó tres veces',
  error_sistema: 'Error del sistema',
};

/**
 * Los estados de la máquina, en castellano.
 *
 * `ELEGIR_HORA` es correcto y no significa nada para quien lee el informe. La tabla cae de
 * vuelta al identificador si aparece un estado nuevo: un guion que crece no puede dejar una
 * fila en blanco.
 */
const ETAPAS: Readonly<Record<string, string>> = {
  INICIO: 'Recién llegadas',
  CONSENTIMIENTO: 'Sin aceptar el aviso de datos',
  MENU: 'En el menú',
  TRIAJE: 'Describiendo el caso',
  TARIFA: 'Al ver el honorario',
  CITA_EXISTENTE: 'Con una cita ya hecha',
  MODALIDAD: 'Eligiendo modalidad',
  ELEGIR_DIA: 'Eligiendo día',
  ELEGIR_HORA: 'Eligiendo hora',
  DATOS: 'Dando sus datos',
  CONFIRMAR: 'Sin confirmar',
  CITA_OK: 'Con cita hecha',
  CANCELAR_CITA: 'Cancelando',
  CIERRE_SIN_CITA: 'Cerradas sin cita',
  DESPEDIDA: 'Despedidas',
  DERIVADA: 'Derivadas a una persona',
};

/** Las citas se enseñan con la palabra que usa el estudio, no con la del enum. */
const ESTADOS_CITA: Readonly<Record<string, string>> = {
  reservada: 'Reservada',
  confirmada: 'Confirmada',
  cancelada: 'Cancelada',
  atendida: 'Vino',
  ausente: 'Faltó',
};

/**
 * Los iconos son marcas, no información: cada uno va junto a su texto. Están en línea y no
 * en un archivo porque son cuatro trazos y una petición más por pantalla no compensa.
 */
const LUPA = raw(
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
);

const iconoDe = (trazos: string): HtmlEscapedString =>
  raw(
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      trazos +
      '</svg>',
  );

const VISTO = iconoDe('<path d="M20 6L9 17l-5-5"/>');
const CRUZ = iconoDe('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>');

/**
 * Las iniciales de quien está dentro, para el corro de la barra.
 *
 * Se saltan las abreviaturas —«Abg. María Cordero» es MC, no AM—: el tratamiento lo
 * comparten todos los del estudio y no distingue a nadie.
 */
function iniciales(nombre: string): string {
  const palabras = nombre.split(/\s+/).filter((p) => p.length > 0 && !p.endsWith('.'));
  const letras = (palabras.length === 0 ? nombre.split(/\s+/) : palabras)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
  return letras === '' ? '·' : letras;
}

const NAVEGACION = [
  { clave: 'agenda', ruta: '', texto: 'Hoy y mañana' },
  { clave: 'metricas', ruta: '/metricas', texto: 'Métricas' },
  { clave: 'calendario', ruta: '/calendario', texto: 'Calendarios' },
] as const;

/** Qué apartado de la barra va marcado. */
export type Apartado = (typeof NAVEGACION)[number]['clave'];

function documento(titulo: string, cuerpo: Html, claseCuerpo = ''): Html {
  return html`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${titulo} · Providencia</title>
    <style>${raw(ESTILOS)}</style>
    <script src="/panel/estatico/htmx.js" defer></script>
  </head>
  <body class="${claseCuerpo}">${cuerpo}</body>
</html>`;
}

/**
 * Todas las rutas cuelgan de `base` —`/panel/<slug>`—: el despacho va en la URL igual que
 * el `phone_number_id` va en el cuerpo del webhook, porque la página de acceso tiene que
 * saber de qué estudio es **antes** de que exista una sesión de la que deducirlo.
 *
 * Sin `usuario` no hay sesión, y entonces tampoco hay barra: las cuatro pantallas de entrada
 * se sirven centradas y sin navegación, porque ninguno de esos enlaces llevaría a ningún
 * sitio.
 */
export function pagina(
  base: string,
  titulo: string,
  contenido: Html,
  usuario?: string,
  apartado?: Apartado,
): Html {
  if (usuario === undefined) return paginaEntrada(titulo, contenido);

  return documento(
    titulo,
    html`
      <div class="cabecera">
        <span class="marca"><span class="sello">P</span>Providencia</span>
        <nav class="nav">
          ${NAVEGACION.map(
            (n) => html`<a
              href="${base}${n.ruta}"
              ${n.clave === apartado ? raw('aria-current="page"') : ''}
            >${n.texto}</a>`,
          )}
        </nav>
        <span class="quien">
          <span class="avatar" aria-hidden="true">${iniciales(usuario)}</span>
          <span class="nombre">${usuario}</span>
          <a href="${base}/salir">Salir</a>
        </span>
      </div>
      <main>${contenido}</main>
    `,
  );
}

/** La tarjeta centrada del acceso y del alta. */
function paginaEntrada(titulo: string, contenido: Html): Html {
  return documento(
    titulo,
    html`<main class="entrada-caja">
      <span class="marca"><span class="sello">P</span>Providencia</span>
      ${contenido}
    </main>`,
    'entrada',
  );
}

function encabezado(titulo: string, sub?: string): Html {
  return html`<div class="titulo">
    <h2>${titulo}</h2>
    ${sub === undefined ? '' : html`<span class="sub">${sub}</span>`}
  </div>`;
}

function vacio(titular: string, detalle: string): Html {
  return html`<p class="vacio"><strong>${titular}</strong>${detalle}</p>`;
}

function horaDe(fecha: Date, formatearHora: (ms: number) => string): string {
  return formatearHora(fecha.getTime());
}

/** `40.00` se lee peor que `$40`: los centavos de un honorario redondo son ruido. */
function dinero(valor: string): string {
  return `$${valor.replace(/\.00$/, '')}`;
}

function pildoraCita(estado: string): Html {
  return html`<span class="pill ${estado}"
    ><span class="punto" aria-hidden="true"></span>${ESTADOS_CITA[estado] ?? estado}</span
  >`;
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
  if (citas.length === 0) {
    return vacio('Sin citas', 'El día está libre. Nada que preparar.');
  }

  return html`<table>
    <thead>
      <tr>
        <th>Hora</th>
        <th>Contacto</th>
        <th>Materia</th>
        <th class="ocultable">Abogado</th>
        <th>Estado</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${citas.map(
        (c) => html`<tr id="cita-${c.id}">
          <td class="hora">
            ${horaDe(c.iniciaAt, formatearHora)}
            <div class="secundario">a ${horaDe(c.terminaAt, formatearHora)}</div>
          </td>
          <td>
            <button
              type="button"
              class="enlace"
              hx-get="${base}/contactos/${c.contactoId}"
              hx-target="#ficha-${c.contactoId}"
              hx-swap="innerHTML"
              aria-expanded="false"
            >${c.contactoNombre ?? c.contactoWaId}</button>
            ${c.contactoNombre === null ? '' : html`<div class="secundario">${c.contactoWaId}</div>`}
          </td>
          <td>
            <div class="principal">${c.materia}</div>
            <div class="secundario">${c.modalidad} · ${dinero(c.honorarioUsd)}</div>
          </td>
          <td class="ocultable">${c.abogadoNombre}</td>
          <td>${pildoraCita(c.estado)}</td>
          <td class="acciones">
            ${yaEmpezo(c)
              ? html`<button
                    type="button"
                    hx-post="${base}/citas/${c.id}/asistencia?vino=si"
                    hx-target="#cita-${c.id}"
                    hx-swap="outerHTML"
                  >${VISTO}Vino</button>
                  <button
                    type="button"
                    hx-post="${base}/citas/${c.id}/asistencia?vino=no"
                    hx-target="#cita-${c.id}"
                    hx-swap="outerHTML"
                  >${CRUZ}Faltó</button>`
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

/** El aviso que sustituye a una fila entera: siempre ocupa las seis columnas. */
function filaAviso(citaId: string, dentro: Html): Html {
  return html`<tr id="cita-${citaId}">
    <td colspan="6"><div class="aviso" role="status">${dentro}</div></td>
  </tr>`;
}

/**
 * Deshacer en vez de «¿está seguro?» (§9). El aviso se borra solo a los diez segundos
 * —`hx-trigger="load delay:10s"` sobre sí mismo— porque pasado el plazo el deshacer ya no
 * puede funcionar y dejar el botón puesto sería prometer algo que no se cumple.
 */
export function avisoCancelada(base: string, citaId: string, segundos: number): Html {
  return filaAviso(
    citaId,
    html`<span>Cita cancelada.</span>
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
      ></span>`,
  );
}

export function filaRestaurada(base: string, citaId: string): Html {
  return filaAviso(
    citaId,
    html`<span>Cita restaurada. <a href="${base}">Recargar</a> para verla en su sitio.</span>`,
  );
}

export function filaNoSePudo(citaId: string, motivo: string): Html {
  return filaAviso(citaId, html`<span>${motivo}</span>`);
}

export function filaAsistencia(citaId: string, vino: boolean): Html {
  return filaAviso(
    citaId,
    html`<span class="pill ${vino ? 'atendida' : 'ausente'}"
        ><span class="punto" aria-hidden="true"></span>${vino ? 'Vino' : 'Faltó'}</span
      >
      <span>Queda anotado.</span>`,
  );
}

export function fichaContacto(
  base: string,
  ficha: FichaContacto,
  formatearFechaHora: (ms: number) => string,
): Html {
  return html`<div class="ficha-cuerpo">
    <dl>
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
                (c) => html`<li>${formatearFechaHora(c.iniciaAt.getTime())} · ${c.materia} · ${ESTADOS_CITA[c.estado] ?? c.estado}</li>`,
              )}
            </ul>`}
      </dd>
    </dl>
    <div class="acciones" style="text-align: left">
      <a class="boton" href="${base}/contactos/${ficha.id}/export.json">Exportar datos (LOPDP)</a>
      <button
        type="button"
        class="${ficha.bloqueado ? '' : 'peligro'}"
        hx-post="${base}/contactos/${ficha.id}/bloqueo?bloquear=${ficha.bloqueado ? 'no' : 'si'}"
        hx-target="#ficha-${ficha.id}"
        hx-swap="innerHTML"
      >${ficha.bloqueado ? 'Desbloquear' : 'Bloquear'}</button>
      ${ficha.bloqueado ? html`<span class="tenue">El bot no le contesta.</span>` : ''}
    </div>
  </div>`;
}

export function tablaBandeja(
  base: string,
  conversaciones: readonly ConversacionEnBandeja[],
  formatearFechaHora: (ms: number) => string,
): Html {
  if (conversaciones.length === 0) {
    return vacio('Nadie esperando', 'El bot está respondiendo todas las conversaciones.');
  }

  return html`<table>
    <thead>
      <tr><th>Desde</th><th>Contacto</th><th>Motivo</th><th class="ocultable">Se quedó en</th><th></th></tr>
    </thead>
    <tbody>
      ${conversaciones.map(
        (cv) => html`<tr id="conv-${cv.id}">
          <td class="hora">${formatearFechaHora(cv.derivadaAt.getTime())}</td>
          <td>
            <div class="principal">${cv.contactoNombre ?? cv.contactoWaId}</div>
            ${cv.contactoNombre === null ? '' : html`<div class="secundario">${cv.contactoWaId}</div>`}
          </td>
          <td>${MOTIVOS[cv.motivo] ?? cv.motivo}</td>
          <td class="ocultable">
            <span class="pill espera"
              ><span class="punto" aria-hidden="true"></span>${ETAPAS[cv.estado] ?? cv.estado}</span
            >
          </td>
          <td class="acciones">
            <button
              type="button"
              hx-post="${base}/conversaciones/${cv.id}/cerrar"
              hx-target="#conv-${cv.id}"
              hx-swap="outerHTML"
            >${VISTO}Atendida</button>
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
  const total = datos.dias.reduce((suma, d) => suma + d.citas.length, 0);

  return pagina(
    base,
    'Hoy y mañana',
    html`
      ${encabezado(
        'Agenda',
        total === 1 ? '1 cita entre hoy y mañana' : `${total} citas entre hoy y mañana`,
      )}

      <div class="buscador">
        <label for="buscador" class="oculto">Buscar contacto</label>
        ${LUPA}
        <input id="buscador" type="search" placeholder="Buscar por nombre o número"
               hx-get="${base}/buscar" hx-trigger="input changed delay:300ms"
               hx-target="#resultados" name="q" autocomplete="off" />
      </div>
      <div id="resultados"></div>

      ${datos.dias.map(
        (d, i) => html`<section class="tarjeta ${i === 0 ? 'hoy' : ''}">
          <header>
            <h3>${d.etiqueta}</h3>
            <span class="cuenta">${d.citas.length === 1 ? '1 cita' : `${d.citas.length} citas`}</span>
          </header>
          ${tablaCitas(base, d.citas, formatos.hora)}
        </section>`,
      )}

      <section class="tarjeta">
        <header>
          <h3>Esperando a una persona</h3>
          <span class="cuenta">${datos.bandeja.length}</span>
        </header>
        ${tablaBandeja(base, datos.bandeja, formatos.fechaHora)}
      </section>
    `,
    usuario,
    'agenda',
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
      <button type="button" class="primario" id="registrar">Registrar este dispositivo</button>
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
      <a class="boton" href="${base}">Ir al acceso</a>
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
      <a class="boton primario" href="${base}">Entrar al panel</a>
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
      <button type="button" class="primario" id="entrar">Entrar</button>
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

  if (encontrados.length === 0) {
    return html`<section class="tarjeta">
      ${vacio('Nadie con ese nombre ni ese número', 'Pruebe con el número completo.')}
    </section>`;
  }

  return html`<section class="tarjeta">
    <header>
      <h3>Resultados</h3>
      <span class="cuenta">${encontrados.length}</span>
    </header>
    <table>
      <thead><tr><th>Contacto</th><th>WhatsApp</th><th>Próxima cita</th></tr></thead>
      <tbody>
        ${encontrados.map(
          (c) => html`<tr>
            <td>
              <button
                type="button"
                class="enlace"
                hx-get="${base}/contactos/${c.id}"
                hx-target="#ficha-busqueda-${c.id}"
                hx-swap="innerHTML"
              >${c.nombre ?? '(sin nombre)'}</button>
            </td>
            <td>${c.waId}</td>
            <td class="hora">
              ${c.proximaCitaAt === null
                ? html`<span class="tenue">—</span>`
                : formatearFechaHora(c.proximaCitaAt.getTime())}
            </td>
          </tr>
          <tr class="ficha"><td colspan="3" id="ficha-busqueda-${c.id}"></td></tr>`,
        )}
      </tbody>
    </table>
  </section>`;
}

/**
 * Las cinco métricas de §9, como tarjetas de cifra.
 *
 * **No son gráficos porque no hay nada que graficar**: son cinco números sueltos, y una
 * barra de una sola barra es un número con adornos encima. Lo que sí es comparación de
 * magnitudes es dónde se quedan las conversaciones que no acaban, y eso va en barras
 * horizontales de un solo tono —una sola serie, un solo color— ordenadas de mayor a menor.
 *
 * Un porcentaje sin denominador es propaganda, así que cada uno lleva el suyo debajo. Y
 * cuando la muestra es pequeña no se enseña el número: se dice que no hay datos suficientes,
 * que es la verdad y evita que alguien tome una decisión sobre tres citas.
 */
export function pantallaMetricas(base: string, informe: Informe, usuario: string): Html {
  const cifra = (
    etiqueta: string,
    valor: number | null,
    sufijo: string,
    sobre: string,
    destacada = false,
  ): Html => html`<div class="cifra ${destacada ? 'destacada' : ''}">
    <div class="etiqueta">${etiqueta}</div>
    <div class="valor ${valor === null ? 'nulo' : ''}">
      ${valor === null ? 'Sin datos' : `${valor}${sufijo}`}
    </div>
    <div class="sobre">${sobre}</div>
  </div>`;

  const mayor = informe.abandono.reduce((max, a) => Math.max(max, a.total), 0);

  return pagina(
    base,
    'Métricas',
    html`
      ${encabezado('Métricas del periodo', `Del ${informe.desde} al ${informe.hasta}`)}

      ${informe.advertencias.length === 0
        ? ''
        : html`<div class="aviso sereno" role="status">
            <span>${informe.advertencias.join(' ')}</span>
          </div>`}

      <div class="cifras">
        ${cifra('Conversaciones', informe.conversaciones, '', 'en el periodo', true)}
        ${cifra(
          'Citas por cada 100 conversaciones',
          informe.porcentajes.citasPorCien,
          '',
          `${informe.conCita} de ${informe.conversaciones}`,
        )}
        ${cifra(
          'Derivadas a una persona',
          informe.porcentajes.derivacionesPorCien,
          '%',
          `${informe.derivadas} de ${informe.conversaciones}`,
        )}
        ${cifra(
          'Ausencias',
          informe.porcentajes.ausenciasPorCien,
          '%',
          `${informe.citasAusentes} de ${informe.citasMarcadas} marcadas`,
        )}
        ${cifra(
          'Citas pasadas sin marcar',
          informe.citasSinMarcar,
          '',
          informe.citasSinMarcar === 0 ? 'todas marcadas' : 'la tasa de ausencias no las ve',
        )}
      </div>

      <section class="tarjeta">
        <header><h3>Dónde se quedan las que no acaban</h3></header>
        ${informe.abandono.length === 0
          ? vacio('Ninguna quedó a medias', 'Todas las conversaciones del periodo se cerraron.')
          : html`<div class="cuerpo">
              <div class="barras">
                ${informe.abandono.map(
                  (a) => html`<div class="barra">
                    <span class="nombre">${ETAPAS[a.estado] ?? a.estado}</span>
                    <span class="via">
                      <span
                        class="relleno"
                        style="width: ${mayor === 0 ? 0 : Math.round((a.total / mayor) * 100)}%"
                      ></span>
                    </span>
                    <span class="total">${a.total}</span>
                  </div>`,
                )}
              </div>
            </div>`}
      </section>
    `,
    usuario,
    'metricas',
  );
}

/**
 * Conexión del Google Calendar de cada abogado.
 *
 * El aviso de qué se pierde sin conectar no es relleno: sin el calendario del abogado, el
 * bot solo evita las citas que él mismo agendó, y puede ofrecer la hora de una audiencia.
 */
export function pantallaCalendarios(
  base: string,
  abogados: readonly AbogadoConCalendario[],
  usuario: string,
  aviso?: string,
): Html {
  const faltan = abogados.filter((a) => a.calendarId === null).length;

  return pagina(
    base,
    'Calendarios',
    html`
      ${encabezado(
        'Google Calendar',
        faltan === 0
          ? 'Todos los abogados conectados'
          : faltan === 1
            ? '1 abogado sin conectar'
            : `${faltan} abogados sin conectar`,
      )}

      ${aviso === undefined ? '' : html`<div class="aviso" role="alert"><span>${aviso}</span></div>`}

      <section class="tarjeta">
        <header><h3>Abogados</h3></header>
        <table>
          <thead><tr><th>Abogado</th><th>Cuenta conectada</th><th></th></tr></thead>
          <tbody>
            ${abogados.map(
              (a) => html`<tr>
                <td class="principal">${a.nombre}</td>
                <td>${a.calendarId ?? html`<span class="tenue">sin conectar</span>`}</td>
                <td class="acciones">
                  ${a.calendarId === null
                    ? html`<a class="boton primario" href="${base}/calendario/${a.id}/conectar">Conectar</a>`
                    : html`<form method="post" class="enlinea" action="${base}/calendario/${a.id}/desconectar">
                        <button type="submit" class="peligro">Desconectar</button>
                      </form>`}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </section>

      <p class="tenue">
        Conectar el calendario de un abogado hace dos cosas: refleja allí las citas que
        agenda el bot, y —sobre todo— impide que el bot ofrezca horas en las que ya tiene
        algo apuntado. Mientras no conecte, el bot solo evita las citas que él mismo agendó.
      </p>
    `,
    usuario,
    'calendario',
  );
}
