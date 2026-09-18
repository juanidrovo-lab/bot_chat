/**
 * La demostración del chatbot, dentro del panel.
 *
 * Lo que se ve aquí sale de `app/simularConversacion.ts`, que corre **la máquina de verdad**
 * con los textos y la agenda del despacho. No hay guion duplicado: si mañana cambia el
 * flujo, esta pantalla cambia con él sin que nadie la toque.
 *
 * El estado de la conversación viaja en campos escondidos del formulario. La máquina es una
 * función pura, así que cabe en la petición, y así la demostración **no escribe nada**: ni
 * una conversación, ni una cita, ni un mensaje. Guardarlas contaminaría las métricas del
 * panel con gente que nunca escribió.
 */
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Controles, MensajeSimulado, Paso } from '../../../app/simularConversacion.ts';
import { inicialDe, pagina, type Apartado } from './vistas.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const ICONO_MAPA = raw(
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1116 0z"/><circle cx="12" cy="10" r="3"/></svg>',
);

const ICONO_IMAGEN = raw(
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/>' +
    '<path d="M21 16l-5-5-9 9"/></svg>',
);

const ICONO_VOZ = raw(
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0"/>' +
    '<path d="M12 18v3"/></svg>',
);

/** El estado que viaja de vuelta. Va como JSON porque el contexto es un objeto abierto. */
export interface EstadoSerializado {
  estado: string;
  contexto: string;
  fallos: string;
}

function camposOcultos(paso: Paso): Html {
  return html`<input type="hidden" name="estado" value="${paso.estado}" />
    <input type="hidden" name="contexto" value="${JSON.stringify(paso.contexto)}" />
    <input type="hidden" name="fallos" value="${String(paso.fallos)}" />`;
}

/** Los mensajes de un paso, tal como se ven en el chat. */
function burbujas(mensajes: readonly MensajeSimulado[]): Html {
  return html`${mensajes.map((m) => {
    switch (m.tipo) {
      case 'texto':
        return html`<div class="burbuja">${m.texto}</div>`;
      case 'audio':
        return html`<div class="burbuja">${ICONO_VOZ} Nota de voz «${m.clave}»</div>`;
      case 'nota':
        // Marcado distinto a propósito: esto no es un mensaje, es lo que pasa por detrás.
        return html`<div class="tras-bambalinas">${m.texto}</div>`;
      case 'ubicacion':
        return html`<div class="adjunto">
          <div class="lamina">
            ${ICONO_MAPA}<strong>Ubicación</strong>
            <span class="que">${m.latitud}, ${m.longitud}</span>
          </div>
          <div class="pie">${m.direccion}</div>
        </div>`;
      case 'imagen':
        return html`<div class="adjunto">
          <div class="lamina">
            ${ICONO_IMAGEN}<strong>Imagen</strong>
            <span class="que">${m.imagen}</span>
          </div>
          <div class="pie">${m.pie}</div>
        </div>`;
    }
  })}`;
}

/** Lo que el contacto puede tocar ahora. Es lo que se reemplaza en cada paso. */
function teclado(base: string, paso: Paso): Html {
  const enviar = (extra: Html): Html => html`<form
    hx-post="${base}/simulador"
    hx-target="#conversacion"
    hx-swap="beforeend"
    class="datos"
  >
    ${camposOcultos(paso)}${extra}
  </form>`;

  if (paso.cerrada || paso.derivada) {
    return html`<div class="opciones">
      <p class="pista">
        ${paso.derivada
          ? 'El bot se calló. En WhatsApp, esta conversación estaría ahora en la bandeja.'
          : 'La conversación terminó.'}
      </p>
      <form hx-post="${base}/simulador/reiniciar" hx-target="#simulador" hx-swap="outerHTML">
        <button type="submit" class="primario">Empezar de nuevo</button>
      </form>
    </div>`;
  }

  switch (paso.controles.tipo) {
    case 'botones':
    case 'lista':
      return html`<div class="opciones">
        ${paso.controles.opciones.map(
          // El título viaja con la opción para que la burbuja del contacto diga «Presencial»
          // y no `presencial`, ni el uuid del horario, que es lo que la máquina recibe.
          (o) => enviar(html`<input type="hidden" name="opcion" value="${o.id}" />
            <input type="hidden" name="titulo" value="${o.titulo}" />
            <button type="submit">${o.titulo}</button>`),
        )}
        <p class="pista">
          ${paso.controles.tipo === 'lista' ? 'Lista de WhatsApp' : 'Botones de respuesta'}
        </p>
      </div>`;

    case 'formulario':
      return html`<div class="opciones">
        ${enviar(html`<input type="hidden" name="opcion" value="__formulario" />
          <input name="nombre" placeholder="Nombre y apellido" value="Jorge Andrade" required />
          <input name="email" type="email" placeholder="Correo" value="jandrade@correo.ec" required />
          <input name="cedula" placeholder="Cédula (opcional)" value="0102030405" />
          <button type="submit" class="primario">Enviar el formulario</button>`)}
        <p class="pista">Formulario de Meta (Flow)</p>
      </div>`;

    case 'ninguno':
      return html`<p class="pista">El bot está esperando otra cosa.</p>`;
  }
}

/**
 * Lo que devuelve cada paso: los mensajes se añaden al final del chat y el teclado se
 * reemplaza aparte, con un intercambio fuera de banda de HTMX. Sin eso, las opciones viejas
 * se quedarían pegadas debajo de las nuevas.
 */
export function pasoDelSimulador(base: string, paso: Paso, dicho?: string): Html {
  return html`${dicho === undefined ? '' : html`<div class="burbuja mia">${dicho}</div>`}
    ${burbujas(paso.mensajes)}
    <div id="teclado" class="teclado" hx-swap-oob="true">${teclado(base, paso)}</div>`;
}

/** El bloque completo, para la primera carga y para «empezar de nuevo». */
export function bloqueSimulador(base: string, marca: string, paso: Paso): Html {
  return html`<div id="simulador" class="telefono">
    <header>
      <span class="avatar" aria-hidden="true">${inicialDe(marca)}</span>
      ${marca}
    </header>
    <div id="conversacion" class="conversacion">${burbujas(paso.mensajes)}</div>
    <div id="teclado" class="teclado">${teclado(base, paso)}</div>
  </div>`;
}

const PASOS: readonly { que: string; detalle: string }[] = [
  {
    que: 'Se presenta y pide el consentimiento',
    detalle:
      'Antes de guardar un solo dato. Lo que responda queda registrado con la versión del texto que vio, que es lo que exige la LOPDP.',
  },
  {
    que: 'Dos opciones: cita o persona',
    detalle:
      'Nada de listas de materias. Quien no quiere agendar pasa directo a la bandeja del estudio, porque el bot no contesta consultas.',
  },
  {
    que: 'Presencial o virtual',
    detalle:
      'La presencial recibe la ubicación de la oficina antes de elegir horario; la virtual no agenda nada y avisa a una persona.',
  },
  {
    que: 'Día y hora, de los que están libres de verdad',
    detalle:
      'Salen de la agenda del despacho y de los calendarios conectados. Si dos personas eligen el mismo hueco, solo una lo consigue.',
  },
  {
    que: 'Confirma y recibe la cuenta',
    detalle:
      'La cita se reserva primero y el número de cuenta va después: cobrar antes dejaría el horario suelto mientras alguien revisa el comprobante.',
  },
];

export function pantallaSimulador(
  base: string,
  marca: string,
  paso: Paso,
  usuario: string,
): Html {
  return pagina(
    base,
    'Demostración',
    html`
      <div class="titulo">
        <h2>Cómo responde el bot</h2>
        <span class="sub">El guion real, sin WhatsApp</span>
      </div>

      <div class="aviso sereno" role="status">
        <span>
          Esta pantalla ejecuta el mismo guion que atenderá por WhatsApp, con los horarios
          libres de verdad. No guarda nada: ni la conversación ni la cita.
        </span>
      </div>

      <div class="sim">
        ${bloqueSimulador(base, marca, paso)}

        <section class="tarjeta">
          <header><h3>Lo que hace, paso a paso</h3></header>
          <div class="cuerpo">
            <div class="guion">
              ${PASOS.map(
                (p, i) => html`<div class="paso">
                  <span class="n" aria-hidden="true">${String(i + 1)}</span>
                  <p><strong>${p.que}</strong><br /><span class="que">${p.detalle}</span></p>
                </div>`,
              )}
            </div>
          </div>
        </section>
      </div>
    `,
    usuario,
    'simulador' as Apartado,
    marca,
  );
}

export type { Controles };
