/**
 * El sistema visual del panel.
 *
 * Va en su propio archivo porque dejó de ser «cuarenta reglas»: son los tokens, la
 * tipografía, la rejilla y los componentes de todas las pantallas. Mezclarlo con las vistas
 * hacía ilegibles las dos cosas.
 *
 * **Para quién es esto.** Tres abogados y una secretaria, mirándolo entre llamada y
 * llamada. No es un tablero para contemplar: es una herramienta de consulta rápida. De ahí
 * las decisiones que parecerían austeras en otro producto —sin degradados, sin sombras
 * grandes, sin animaciones de entrada— y las que no son negociables: densidad alta, la hora
 * legible de un vistazo, y el estado de cada cita en una sola mirada.
 *
 * **Sin recursos externos.** Ni tipografías ni scripts de terceros: la
 * `Content-Security-Policy` del panel se queda en `self`, y un panel con datos de clientes
 * no le cuenta a nadie de fuera quién lo abre y cuándo. La pila de sistema se ve nativa en
 * cada máquina, que además es lo que uno espera de una herramienta de trabajo.
 */

/**
 * Los tokens.
 *
 * El acento es azul y no el verde o el morado de turno: es el color que un estudio jurídico
 * reconoce como suyo sin que nadie lo comente, y deja los verdes y rojos libres para lo que
 * de verdad significa algo —que alguien vino o faltó—.
 *
 * El modo oscuro se **elige**, no se invierte: cada token tiene su propio valor pensado
 * contra la superficie oscura, porque voltear una paleta clara da grises sucios y acentos
 * que vibran.
 */
const TOKENS = `
  :root {
    color-scheme: light dark;

    /* Superficies, de atrás hacia adelante. */
    --fondo: #f6f6f4;
    --panel: #fcfcfb;
    --panel-alto: #ffffff;
    --suave: #f0f1f4;

    /* Tinta. Tres niveles bastan; un cuarto solo diluye la jerarquía. */
    --texto: #16181d;
    --tenue: #5b6270;
    --apenas: #8a91a0;

    --linea: #e3e5ea;
    --linea-fuerte: #cfd3db;

    /* Acento: el azul 550 de la paleta de referencia. */
    --acento: #1c5cab;
    --acento-suave: #eaf1fb;
    --acento-linea: #b7d3f6;

    /* Estado. Nunca van solos: siempre con su etiqueta al lado. */
    --bien: #0ca30c;
    --bien-suave: #e7f6e7;
    --aviso: #fab219;
    --aviso-suave: #fdf3dd;
    --grave: #d03b3b;
    --grave-suave: #fbeaea;

    --radio: 10px;
    --radio-chico: 6px;
    --sombra: 0 1px 2px rgb(16 24 40 / 6%), 0 1px 3px rgb(16 24 40 / 4%);
    --sombra-alta: 0 4px 12px rgb(16 24 40 / 8%), 0 1px 3px rgb(16 24 40 / 6%);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --fondo: #141416;
      --panel: #1a1a19;
      --panel-alto: #222225;
      --suave: #232329;

      --texto: #eceef2;
      --tenue: #a0a7b4;
      --apenas: #767d8b;

      --linea: #2c3038;
      --linea-fuerte: #3b414c;

      /* El 350, no el 550: sobre fondo oscuro el azul profundo desaparece. */
      --acento: #5598e7;
      --acento-suave: #172436;
      --acento-linea: #2a4a6b;

      --bien: #46c246;
      --bien-suave: #16260f;
      --aviso: #fab219;
      --aviso-suave: #2a220d;
      --grave: #e86a6a;
      --grave-suave: #2d1414;

      --sombra: 0 1px 2px rgb(0 0 0 / 40%);
      --sombra-alta: 0 4px 12px rgb(0 0 0 / 45%);
    }
  }
`;

const BASE = `
  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--fondo);
    color: var(--texto);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  a { color: var(--acento); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { text-decoration-thickness: 2px; }

  /*
   * El foco visible no es un detalle de accesibilidad que se añade al final: es cómo se usa
   * este panel con una mano mientras la otra sostiene el teléfono.
   */
  :focus-visible {
    outline: 2px solid var(--acento);
    outline-offset: 2px;
    border-radius: var(--radio-chico);
  }

  h1, h2, h3 { margin: 0; font-weight: 600; letter-spacing: -0.01em; }

  .tenue { color: var(--tenue); }

  /*
   * Visible para el lector de pantalla y para nadie más. Las etiquetas de los campos que se
   * explican solos por su marcador de posición siguen existiendo: quitarlas del DOM sería
   * dejar el buscador sin nombre.
   */
  .oculto {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; border: 0;
  }
`;

/**
 * La barra superior: identidad, navegación y quién está dentro.
 *
 * Se llama `.cabecera` y no `.barra` porque `.barra` es la fila de la gráfica de abandono,
 * más abajo. Dos reglas con el mismo nombre en dos secciones de este archivo no chocan al
 * escribirlas ni al leerlas: chocan en el navegador, donde la última gana y convierte la
 * barra de navegación en una rejilla de tres columnas.
 */
const CABECERA = `
  .cabecera {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 1.5rem;
    padding: 0 1.25rem; height: 56px;
    background: var(--panel);
    border-bottom: 1px solid var(--linea);
  }
  .marca {
    display: flex; align-items: center; gap: .55rem;
    font-size: .95rem; font-weight: 600; letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .marca .sello {
    display: grid; place-items: center;
    width: 26px; height: 26px; border-radius: 7px;
    background: var(--acento); color: #fff;
    font-size: .8rem; font-weight: 700;
  }
  .nav { display: flex; gap: .25rem; margin-left: .5rem; }
  .nav a {
    padding: .4rem .7rem; border-radius: var(--radio-chico);
    color: var(--tenue); text-decoration: none; font-size: .9rem; font-weight: 500;
  }
  .nav a:hover { background: var(--suave); color: var(--texto); }
  .nav a[aria-current="page"] { background: var(--acento-suave); color: var(--acento); }

  .quien {
    margin-left: auto; display: flex; align-items: center; gap: .6rem;
    color: var(--tenue); font-size: .85rem; white-space: nowrap;
  }
  .quien .avatar {
    display: grid; place-items: center;
    width: 26px; height: 26px; border-radius: 50%;
    background: var(--suave); color: var(--tenue);
    font-size: .72rem; font-weight: 600;
  }

  main { max-width: 74rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }

  .titulo { display: flex; align-items: baseline; gap: .75rem; margin-bottom: 1.25rem; }
  .titulo h2 { font-size: 1.35rem; }
  .titulo .sub { color: var(--tenue); font-size: .9rem; }
`;

/** Tarjetas y secciones: lo que agrupa cada bloque de la pantalla. */
const TARJETAS = `
  .tarjeta {
    background: var(--panel);
    border: 1px solid var(--linea);
    border-radius: var(--radio);
    box-shadow: var(--sombra);
    overflow: hidden;
  }
  .tarjeta + .tarjeta { margin-top: 1.25rem; }

  .tarjeta > header {
    display: flex; align-items: center; gap: .75rem;
    padding: .8rem 1rem;
    border-bottom: 1px solid var(--linea);
    background: var(--panel);
  }
  .tarjeta > header h3 { font-size: .95rem; }
  .tarjeta > header .cuenta {
    margin-left: auto;
    color: var(--tenue); font-size: .8rem;
    font-variant-numeric: tabular-nums;
  }
  .tarjeta > .cuerpo { padding: 1rem; }

  /* El día de hoy se distingue del de mañana sin necesidad de leer la fecha. */
  .tarjeta.hoy > header { background: var(--acento-suave); border-bottom-color: var(--acento-linea); }
  .tarjeta.hoy > header h3 { color: var(--acento); }
`;

const TABLAS = `
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  thead th {
    padding: .5rem 1rem;
    text-align: left; font-size: .72rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em;
    color: var(--apenas);
    border-bottom: 1px solid var(--linea);
    background: var(--panel);
    white-space: nowrap;
  }
  tbody td { padding: .7rem 1rem; border-bottom: 1px solid var(--linea); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: var(--suave); }

  /* Horas y cantidades alineadas: en una columna, cada dígito ocupa lo mismo. */
  .hora, .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .hora { font-weight: 600; font-size: .95rem; }
  .num { text-align: right; }

  .principal { font-weight: 500; }
  .secundario { color: var(--tenue); font-size: .82rem; }
  .acciones { text-align: right; white-space: nowrap; }
  .acciones > * + * { margin-left: .35rem; }
`;

const CONTROLES = `
  button, .boton {
    display: inline-flex; align-items: center; gap: .35rem;
    font: inherit; font-size: .85rem; font-weight: 500;
    padding: .38rem .7rem;
    border: 1px solid var(--linea-fuerte); border-radius: var(--radio-chico);
    background: var(--panel-alto); color: var(--texto);
    cursor: pointer; text-decoration: none;
    transition: background .12s ease, border-color .12s ease;
  }
  button:hover, .boton:hover { background: var(--suave); border-color: var(--apenas); }
  button:active, .boton:active { transform: translateY(0.5px); }

  .primario {
    background: var(--acento); border-color: var(--acento); color: #fff;
  }
  .primario:hover { background: var(--acento); border-color: var(--acento); filter: brightness(1.08); }

  .peligro { color: var(--grave); border-color: var(--linea-fuerte); }
  .peligro:hover { background: var(--grave-suave); border-color: var(--grave); }

  .enlace {
    border: 0; background: none; padding: .1rem 0;
    color: var(--texto); font-weight: 500;
    text-align: left; text-decoration: underline;
    text-decoration-color: var(--linea-fuerte);
    text-underline-offset: 3px;
  }
  .enlace:hover { background: none; text-decoration-color: var(--acento); color: var(--acento); }

  form.enlinea { display: inline; }

  /* Buscador: arriba y ancho, como pide §9. */
  .buscador { position: relative; margin-bottom: 1.25rem; }
  .buscador input {
    width: 100%; font: inherit; font-size: .95rem;
    padding: .6rem .8rem .6rem 2.2rem;
    border: 1px solid var(--linea-fuerte); border-radius: var(--radio);
    background: var(--panel); color: var(--texto);
    box-shadow: var(--sombra);
  }
  .buscador input::placeholder { color: var(--apenas); }
  .buscador svg { position: absolute; left: .7rem; top: 50%; transform: translateY(-50%); color: var(--apenas); }
`;

/**
 * Píldoras de estado.
 *
 * Cada una lleva su texto: el color acompaña, nunca informa por su cuenta. Eso vale para
 * quien no distingue el rojo del verde y también para quien mira la pantalla de reojo.
 */
const ESTADOS = `
  .pill {
    display: inline-flex; align-items: center; gap: .3rem;
    padding: .15rem .5rem;
    border-radius: 999px;
    font-size: .75rem; font-weight: 600; white-space: nowrap;
    background: var(--suave); color: var(--tenue);
    border: 1px solid transparent;
  }
  .pill .punto { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

  .pill.confirmada, .pill.atendida { background: var(--bien-suave); color: var(--bien); }
  .pill.ausente { background: var(--grave-suave); color: var(--grave); }
  .pill.cancelada { background: var(--suave); color: var(--apenas); }
  .pill.reservada { background: var(--acento-suave); color: var(--acento); }
  .pill.espera { background: var(--aviso-suave); color: #8a6100; }
  @media (prefers-color-scheme: dark) { .pill.espera { color: var(--aviso); } }
`;

/** Avisos: lo que el panel dice cuando pasa algo. */
const AVISOS = `
  .aviso {
    display: flex; align-items: center; gap: .7rem;
    padding: .7rem .9rem; margin: 0 0 1rem;
    border: 1px solid var(--acento-linea); border-radius: var(--radio);
    background: var(--acento-suave); color: var(--texto);
    font-size: .9rem;
  }
  .aviso.sereno { border-color: var(--linea); background: var(--suave); }
  .aviso:empty { display: none; }

  .vacio {
    padding: 2rem 1rem; text-align: center;
    color: var(--tenue); font-size: .9rem;
  }
  .vacio strong { display: block; color: var(--texto); font-weight: 600; margin-bottom: .2rem; }
`;

/**
 * Ficha del contacto, desplegada dentro de la tabla.
 *
 * Se abre en línea y no en una ventana porque el abogado está mirando la fila de la cita:
 * sacarlo de contexto para enseñarle el teléfono de esa misma persona es trabajo de más.
 *
 * Mientras nadie la ha abierto, la celda está vacía: sin relleno ni borde ocupa cero y la
 * fila no se ve. Apagarla con `display: none` rompería el recuento de columnas de la tabla.
 */
const FICHA = `
  tr.ficha > td { padding: 0; border: 0; background: var(--suave); }
  tr.ficha > td:not(:empty) { border-bottom: 1px solid var(--linea); }
  tr.ficha:hover > td { background: var(--suave); }

  .ficha-cuerpo { padding: 1rem 1rem 1rem 2rem; }
  .ficha-cuerpo dl {
    display: grid; grid-template-columns: max-content 1fr;
    gap: .35rem 1rem; margin: 0 0 .9rem;
    font-size: .88rem;
  }
  .ficha-cuerpo dt { color: var(--tenue); }
  .ficha-cuerpo dd { margin: 0; }
  .ficha-cuerpo ul { margin: .2rem 0 0; padding-left: 1.1rem; color: var(--tenue); }
`;

/**
 * Métricas: fila de tarjetas de cifra.
 *
 * No son gráficos porque no hay nada que graficar: son cinco números sueltos, y una barra
 * de una sola barra es un número con adornos. El detalle de abandono sí es comparación de
 * magnitudes, y ahí una barra horizontal por estado se lee de un vistazo.
 *
 * Las cifras grandes llevan las figuras proporcionales de la fuente: `tabular-nums` le da a
 * cada dígito el ancho de un cero, y a ese tamaño un «121» se ve suelto. Lo tabular es para
 * las columnas de una tabla, donde los dígitos tienen que alinearse entre filas.
 */
const METRICAS = `
  .cifras {
    display: grid; gap: 1rem; margin-bottom: 1.25rem;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  }
  .cifra {
    display: flex; flex-direction: column;
    padding: 1rem;
    background: var(--panel); border: 1px solid var(--linea);
    border-radius: var(--radio); box-shadow: var(--sombra);
  }
  /*
   * Dos renglones reservados para la etiqueta, la use o no: sin esto, la tarjeta cuyo
   * nombre ocupa dos líneas baja su cifra y la fila deja de leerse de un barrido.
   */
  .cifra .etiqueta { color: var(--tenue); font-size: .82rem; line-height: 1.3; min-height: 2.6em; }
  .cifra .valor { margin-top: .3rem; font-size: 2rem; font-weight: 600; letter-spacing: -0.02em; }
  .cifra .valor.nulo { color: var(--apenas); font-weight: 500; }
  .cifra .sobre { margin-top: .2rem; color: var(--apenas); font-size: .8rem; }
  /* Una sola por pantalla: si todas gritan, ninguna se oye. */
  .cifra.destacada { background: var(--acento-suave); border-color: var(--acento-linea); }
  .cifra.destacada .etiqueta { color: var(--acento); }
  .cifra.destacada .valor { font-size: 3rem; line-height: 1.05; }

  .barras { display: grid; gap: .6rem; }
  /*
   * La pista se corta a 30rem: estirada al ancho de la tarjeta, la diferencia entre 38 y 24
   * se reparte por media pantalla y hay que medirla con la vista en vez de verla.
   */
  .barra {
    display: grid; grid-template-columns: 11rem minmax(0, 30rem) 2.5rem;
    align-items: center; gap: .75rem;
  }
  .barra .nombre { font-size: .85rem; color: var(--tenue); }
  .barra .via { height: 10px; border-radius: 5px; background: var(--suave); overflow: hidden; }
  /*
   * El «display: block» no es de adorno: un span en línea no atiende ni a la anchura ni a la
   * altura, así que la barra se dibujaría con la pista vacía y ningún error en ninguna parte.
   *
   * Una sola serie: un solo tono. Más color aquí sería decir algo que el dato no dice.
   */
  .barra .relleno { display: block; height: 100%; border-radius: 5px; background: var(--acento); }
  .barra .total { font-size: .85rem; font-variant-numeric: tabular-nums; text-align: right; }
`;

/** Acceso y alta: una tarjeta centrada, sin barra de navegación que no lleva a ningún lado. */
const ENTRADA = `
  body.entrada { display: grid; place-items: center; min-height: 100dvh; padding: 1.25rem; }
  .entrada-caja {
    width: 100%; max-width: 24rem;
    padding: 1.75rem;
    background: var(--panel); border: 1px solid var(--linea);
    border-radius: 14px; box-shadow: var(--sombra-alta);
    text-align: center;
  }
  .entrada-caja .marca { justify-content: center; margin-bottom: 1.25rem; font-size: 1.05rem; }
  .entrada-caja h2 { font-size: 1.15rem; margin-bottom: .4rem; }
  .entrada-caja p { margin: 0 0 1.25rem; color: var(--tenue); font-size: .9rem; line-height: 1.55; }
  .entrada-caja button { width: 100%; justify-content: center; padding: .6rem; font-size: .95rem; }
`;

const RESPONSIVO = `
  @media (max-width: 720px) {
    /*
     * La barra pasa a dos filas: la marca y quién está dentro arriba, la navegación entera
     * abajo. Apretarla en una sola dejaba «Calendarios» fuera de la pantalla, que es la
     * misma avería que no tener navegación.
     */
    .cabecera { height: auto; flex-wrap: wrap; gap: .5rem 1rem; padding: .6rem 1rem; }
    .nav { order: 3; width: 100%; margin-left: 0; }
    .nav a { flex: 1; text-align: center; padding: .4rem .3rem; }
    .quien .nombre { display: none; }

    main { padding: 1rem .75rem 3rem; }

    /* En una sola columna no hay nada con lo que alinear: el renglón de más sobra. */
    .cifra .etiqueta { min-height: 0; }

    /* En un teléfono se mira el día, no la columna del abogado. */
    .ocultable { display: none; }

    /*
     * Cada fila pasa a ser un bloque. Una tabla de seis columnas en 390 píxeles no cabe de
     * ninguna manera: o se desplaza a lo ancho —y los botones quedan fuera de la vista, que
     * es donde nadie los busca— o deja de ser una tabla. Los encabezados se van porque cada
     * dato ya se explica solo cuando está debajo del nombre del contacto.
     */
    table, tbody, tbody tr, tbody td { display: block; width: 100%; }
    thead { display: none; }
    tbody tr { padding: .8rem 1rem; border-bottom: 1px solid var(--linea); }
    tbody tr:last-child { border-bottom: 0; }
    tbody td { padding: .1rem 0; border-bottom: 0; }
    tbody tr:hover td { background: none; }

    /* «09:00 a 09:45» en un renglón: dos líneas para una hora es desperdiciar la pantalla. */
    .hora .secundario { display: inline; }

    .acciones { text-align: left; margin-top: .6rem; }

    tr.ficha { padding: 0; border-bottom: 0; }
    .ficha-cuerpo { padding: 1rem; }
    .ficha-cuerpo dl { grid-template-columns: 1fr; gap: 0 0; }
    .ficha-cuerpo dt { margin-top: .5rem; font-size: .8rem; }

    .barra { grid-template-columns: 1fr 2.5rem; gap: .1rem .75rem; }
    .barra .via { grid-column: 1; }
    .barra .nombre { grid-column: 1; }
    .barra .total { grid-row: 1 / 3; grid-column: 2; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; animation: none !important; }
  }
`;

export const ESTILOS = [
  TOKENS,
  BASE,
  CABECERA,
  TARJETAS,
  TABLAS,
  CONTROLES,
  ESTADOS,
  AVISOS,
  FICHA,
  METRICAS,
  ENTRADA,
  RESPONSIVO,
].join('\n');
