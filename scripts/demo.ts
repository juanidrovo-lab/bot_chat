/**
 * Siembra datos de ejemplo en un despacho ya dado de alta, para poder enseñar el panel.
 *
 *   node --env-file-if-exists=.env scripts/demo.ts [slug]
 *
 * **No da de alta el despacho.** Eso sigue siendo `scripts/despacho.ts`, que es el único
 * camino: aquí solo se escriben contactos, conversaciones y citas, que es justo lo que aquel
 * no crea y sin lo cual el panel se ve vacío.
 *
 * **Borra y vuelve a escribir.** Es idempotente porque empieza limpiando lo del despacho que
 * se le indica: una demostración que acumula datos cada vez que se prepara acaba enseñando
 * treinta citas a la misma hora. Por eso mismo **se niega a correr con `NODE_ENV=production`**:
 * el borrado no distingue entre un contacto inventado y uno real.
 *
 * Las fechas se calculan con el reloj del proyecto, así que las citas caen en horas de
 * oficina de America/Guayaquil y no en la madrugada, que es lo que pasa al sembrar en UTC.
 *
 * **Los números tienen que ser creíbles o la demostración se vuelve en contra.** Dos
 * decisiones que salieron de mirar el informe que producía la primera versión:
 *
 *  - **Quien no reservó no puede tener una cita.** La métrica «citas por cada 100
 *    conversaciones» cruza `conversaciones` con `citas` por contacto. Reciclando quince
 *    contactos entre ochenta conversaciones, casi todas acababan emparejadas con alguna
 *    cita y el informe decía 78 de cada 100 — una cifra que ningún abogado se cree. Aquí hay
 *    dos grupos que no se mezclan: los que llegaron a reservar y los que se quedaron por el
 *    camino, que son la mayoría, como en la vida.
 *  - **Tiene que haber más de veinte citas marcadas.** Por debajo de `MINIMO_MUESTRA` el
 *    informe se niega a dar porcentajes —y hace bien—, así que una siembra escasa enseña la
 *    pantalla de métricas diciendo «Sin datos» en tres de sus cinco tarjetas.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { VERSION_CONSENTIMIENTO } from '../src/app/content.ts';
import { FLOW_VERSION } from '../src/domain/conversacion/version.ts';
import { crearReloj } from '../src/adapters/reloj.ts';
import { MINIMO_MUESTRA } from '../src/app/metricas.ts';
import { POLITICA, minutosDeHora } from '../src/domain/agenda/politicas.ts';

const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;
const MIN_MS = 60_000;

/** El periodo que cubren las métricas de §9. */
const DIAS_HISTORIA = 30;

/**
 * El reparto exacto de las citas ya pasadas. Se cuenta, no se sortea: dejarlo al azar hacía
 * que una preparación diera dos ausencias y otra nueve, y la tasa de ausencias es una de las
 * cinco cifras que se enseñan. Las cuatro sin marcar son las que hacen visible el aviso de
 * §9 de que la tasa no las cuenta.
 */
const PASADAS: Readonly<Record<string, number>> = {
  atendida: 24,
  ausente: 5,
  cancelada: 4,
  confirmada: 4,
};

interface Persona {
  nombre: string;
  email: string | null;
  cedula: string | null;
}

/**
 * Los que llegaron a reservar. Nombres cuencanos verosímiles: una demostración con
 * «Test User 3» no se puede poner delante de un cliente.
 */
const CLIENTES: Persona[] = [
  { nombre: 'Jorge Andrade Villacís', email: 'jandrade@correo.ec', cedula: '0102030405' },
  { nombre: 'Rosa Elena Pacheco', email: 'repacheco@correo.ec', cedula: '0103040506' },
  { nombre: 'Pedro Sangurima Ortega', email: null, cedula: '0104050607' },
  { nombre: 'Mercedes Auquilla', email: 'mauquilla@correo.ec', cedula: '0105060708' },
  { nombre: 'Inversiones Pumapungo S.A.', email: 'legal@pumapungo.ec', cedula: '0190123456001' },
  { nombre: 'Diego Peralta Moscoso', email: null, cedula: '0106070809' },
  { nombre: 'Carmen Lucía Bermeo', email: 'clbermeo@correo.ec', cedula: '0107080910' },
  { nombre: 'Fernando Ullauri Crespo', email: null, cedula: '0108091011' },
  { nombre: 'Verónica Idrovo Crespo', email: 'vidrovo@correo.ec', cedula: '0109101112' },
  { nombre: 'Manuel Guamán Tenesaca', email: null, cedula: '0110111213' },
  { nombre: 'Textiles del Azuay Cía. Ltda.', email: 'gerencia@textilazuay.ec', cedula: '0190654321001' },
  { nombre: 'Patricia Malo Zeas', email: 'pmalo@correo.ec', cedula: '0111121314' },
  { nombre: 'Esteban Vintimilla Arce', email: null, cedula: '0112131415' },
  { nombre: 'Gabriela Cobos Arteaga', email: 'gcobos@correo.ec', cedula: '0113141516' },
  { nombre: 'Andrés Sarmiento León', email: null, cedula: '0114151617' },
  { nombre: 'Lucía Astudillo Vega', email: 'lastudillo@correo.ec', cedula: '0115161718' },
  { nombre: 'Rodrigo Encalada Pesántez', email: null, cedula: '0116171819' },
  { nombre: 'Sonia Jaramillo Ochoa', email: 'sjaramillo@correo.ec', cedula: '0117181920' },
];

/**
 * Los que escribieron sin llegar a ser clientes.
 *
 * Casi todos tienen nombre, y no porque el bot lo pregunte —el guion de hoy no lo pregunta—
 * sino porque viene en el perfil de WhatsApp con el primer mensaje. El que no lo tiene es
 * quien tiene el perfil en blanco, que también pasa.
 *
 * Son muchos y distintos a propósito: se reparten sin repetir, porque dos «Nube Chuchuca»
 * seguidos en la bandeja es lo primero que se ve y lo primero que delata una siembra.
 */
const NOMBRES_SUELTOS = [
  'Byron Quezada',
  'Nube Chuchuca',
  'Wilson Cárdenas',
  'Janeth Morocho',
  'Iván Peñaloza',
  'Doris Sigüencia',
  'Marco Tenemaza',
  'Elsa Narváez',
  'Fabián Cajamarca',
  'Yolanda Mogrovejo',
  'Hernán Pillco',
  'Mariana Quito',
  'Segundo Loja',
  'Blanca Chica',
  'Óscar Villavicencio',
  'Teresa Zhindón',
  'Galo Maldonado',
  'Ximena Uyaguari',
  'Luis Chimborazo',
  'Narcisa Tigre',
  'Édgar Buestán',
  'Lourdes Cabrera',
  'Jaime Guzmán',
  'Alexandra Minchala',
  'Rómulo Paute',
  'Silvia Quizhpi',
  'Vinicio Ordóñez',
  'Martha Tapia',
];

/**
 * Lo que la gente escribe de verdad, para que la bandeja tenga algo que leer.
 *
 * **Sin esto la demostración no demuestra nada.** El guion de hoy es una toma de datos: el
 * bot pregunta, guarda y avisa al abogado, y el panel existe para que él lea lo que contó la
 * persona. Una bandeja con nombres y sin transcripción enseña la mitad que no importa.
 *
 * El relato va en sus palabras, con las faltas y el desorden de un mensaje de WhatsApp: un
 * caso redactado por un abogado no se parece a lo que llega.
 */
interface Caso {
  relato: string;
  antecedentes: string;
  /** Hubo quien contestó con una nota de voz; el bot no la escucha y la bandeja lo dice. */
  porVoz?: boolean;
}

const CASOS: Caso[] = [
  {
    relato:
      'Trabajé 6 años en una empresa de transporte y me botaron en septiembre sin pagarme la liquidacion. Ya les reclamé por escrito y no me contestan nada.',
    antecedentes: 'No me han citado ni demandado, no me han embargado nada y no sé qué es un incidente.',
  },
  {
    relato:
      'Mi exesposo no paga la pension de mis dos hijos desde enero. Tengo la boleta del juzgado pero igual no deposita.',
    antecedentes:
      'La demanda la puse yo el año pasado, a él ya lo citaron. No le han embargado nada. Creo que sí hay un incidente porque pedí aumento.',
  },
  {
    relato:
      'Me llego un papel del juzgado por una deuda de la tarjeta de credito del banco y no entiendo que me estan pidiendo ni cuanto tiempo tengo.',
    antecedentes: 'Me citaron la semana pasada con la demanda. Embargo todavia no. Incidente no hay.',
  },
  {
    relato:
      'Tuve un accidente en la Av. de las Americas el sabado. El otro señor dice que fue mi culpa pero el se pasó la roja, hay el parte policial.',
    antecedentes: 'No me han citado nada todavia, solo está el parte. No hay embargo ni incidente.',
    porVoz: true,
  },
  {
    relato:
      'Quiero divorciarme. Llevamos separados tres años y tenemos un terreno a nombre de los dos en Ricaurte.',
    antecedentes: 'Nada de eso todavia, por eso quiero consultar primero cómo es el trámite.',
  },
  {
    relato:
      'Compré un lote en Ricaurte hace dos años y ahora aparece otro señor con una escritura del mismo lote. Ya no sé a quien creerle.',
    antecedentes:
      'Me citaron el mes pasado, ya hay demanda en el juzgado. El terreno está con prohibición de enajenar. De incidente no me han dicho.',
  },
  {
    relato:
      'Soy la dueña de un departamento en el centro y mi inquilino no me paga desde hace cinco meses. No se quiere ir y ya no me contesta el teléfono.',
    antecedentes: 'No he demandado todavia. No hay citación ni embargo ni nada.',
  },
  {
    relato:
      'En la empresa me hicieron firmar la renuncia diciendome que si no firmaba no me pagaban nada. Eso se puede?',
    antecedentes: 'No me han citado, no hay demanda, no hay embargo, no hay incidente.',
  },
  {
    relato:
      'Mi papá falleció en febrero y mis hermanos no quieren hacer la partición de la casa. Somos cuatro.',
    antecedentes:
      'Ellos pusieron una demanda y a mi me citaron en agosto. La casa salió con un embargo que no sabiamos. Creo que hay un incidente.',
    porVoz: true,
  },
  {
    relato:
      'El municipio me puso una multa por un local que yo vendí en el 2023 y sigue a mi nombre en el catastro.',
    antecedentes: 'Me notificaron hace quince dias. Demanda judicial no hay. Embargo tampoco.',
  },
  {
    relato:
      'Me descontaron tres meses de sueldo por un faltante de caja que yo no hice. Tengo las actas firmadas por otra persona.',
    antecedentes: 'No me han citado. No hay demanda. No me embargaron. No sé del incidente.',
  },
  {
    relato:
      'Mi vecino levantó una pared que se mete un metro en mi terreno. Ya le dije por las buenas y no quiere mover nada.',
    antecedentes: 'No hay citación ni demanda. Nada de embargos. Nada de incidente.',
  },
];

/**
 * Dónde se quedan las que no acaban, con el guion de hoy.
 *
 * El grueso está en el relato: el bot acaba de decir «cuénteme su caso» y mucha gente no
 * vuelve. Después, en las cuatro preguntas, que es el paso que cuesta. Son los dos sitios
 * donde mirar si el guion hay que acortarlo.
 */
const ABANDONO: { estado: string; cuantas: number }[] = [
  { estado: 'RELATO', cuantas: 31 },
  { estado: 'CONSENTIMIENTO', cuantas: 18 },
  { estado: 'ANTECEDENTES', cuantas: 14 },
  { estado: 'MODALIDAD', cuantas: 6 },
];

/** Finales deliberados: quien dijo «era solo referencia» no abandonó, terminó. */
const TERMINADAS: { estado: string; cuantas: number }[] = [
  { estado: 'CIERRE_SIN_CITA', cuantas: 11 },
  { estado: 'DESPEDIDA', cuantas: 8 },
];

/**
 * Las que acabaron en una persona porque algo falló, no porque el guion terminara. Son
 * pocas a propósito: si fueran muchas, el informe estaría diciendo que el bot no sirve.
 */
const ATASCADAS_CERRADAS = 6;

/** Consultas completas que ya se atendieron y se cerraron, sin que saliera cita de ellas. */
const CONSULTAS_CERRADAS = 23;

/** Las que esperan al abogado ahora mismo: es la bandeja que se enseña. */
const CONSULTAS_ESPERANDO = 5;

interface Abogado {
  id: string;
  nombre: string;
  materias: string[];
}

/**
 * Generador reproducible. Con `Math.random` cada preparación da una demostración distinta y
 * un fallo visto una vez no se vuelve a ver.
 */
function semillaFija(estado: number): () => number {
  let x = estado;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Este script borra los contactos, conversaciones y citas del despacho antes de sembrar: ' +
        'no corre con NODE_ENV=production.',
    );
  }

  const slug = process.argv[2] ?? 'demo';
  const url = process.env.DATABASE_URL_OWNER;
  if (url === undefined) throw new Error('Falta DATABASE_URL_OWNER (rol app_owner)');

  const reloj = crearReloj();
  const azar = semillaFija(20260916);
  const entre = (tope: number): number => Math.floor(azar() * tope);
  const alguno = <T>(lista: readonly T[]): T => lista[entre(lista.length)]!;

  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    const { rows: despachos } = await cliente.query<{ id: string; nombre: string }>(
      'SELECT id, nombre FROM tenants WHERE slug = $1 AND activo',
      [slug],
    );
    const despacho = despachos[0];
    if (despacho === undefined) {
      throw new Error(
        `No hay despacho activo con slug «${slug}». Déle de alta primero:\n` +
          '  npm run despacho:alta demo/despacho.json',
      );
    }
    const tenantId = despacho.id;

    await cliente.query('BEGIN');
    try {
      /**
       * Con FORCE ROW LEVEL SECURITY el dueño también está sujeto a la política: sin fijar
       * el tenant, todo lo que viene después no tocaría ninguna fila y no avisaría de nada.
       */
      await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      const { rows: abogados } = await cliente.query<Abogado>(
        'SELECT id, nombre, materias FROM abogados WHERE tenant_id = $1 AND activo ORDER BY nombre',
        [tenantId],
      );
      if (abogados.length === 0) throw new Error('El despacho no tiene abogados activos');

      const { rows: configFilas } = await cliente.query<{
        tarifario: Record<string, { honorarioUsd?: string }>;
        horarios: Record<string, { desde: string; hasta: string }[]>;
      }>('SELECT tarifario, horarios FROM tenant_config WHERE tenant_id = $1', [tenantId]);
      const config = configFilas[0];
      if (config === undefined) throw new Error('El despacho no tiene configuración');

      const tarifas = Object.entries(config.tarifario)
        .filter(([, v]) => typeof v.honorarioUsd === 'string')
        .map(([materia, v]) => ({ materia, honorarioUsd: v.honorarioUsd! }));
      if (tarifas.length === 0) throw new Error('El tarifario no tiene ninguna materia con honorario');

      // --- Limpiar ----------------------------------------------------------
      // En orden de dependencia: lo que apunta a otra cosa, primero.
      for (const tabla of [
        'mensajes',
        'reservas_mes',
        'citas',
        'conversaciones',
        'bloqueos',
        'outbox',
        'eventos',
        'contactos',
      ]) {
        await cliente.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenantId]);
      }

      const ahora = reloj.ahoraMs();
      let telefono = 593998100000;
      const siguienteNumero = (): string => String((telefono += 1));

      /**
       * `consintio` va aparte del nombre a propósito. El nombre llega en el perfil de
       * WhatsApp con el primer mensaje, o sea **antes** de que nadie acepte nada, así que
       * tener nombre no prueba que haya consentimiento: lo prueba haber tocado «Acepto».
       * Quien se quedó en el aviso de datos tiene nombre y no tiene `consent_at`.
       */
      const crearContacto = async (
        persona: Persona | null,
        ultimoInbound: Date,
        consintio = true,
      ): Promise<string> => {
        const id = randomUUID();
        const consentAt = consintio
          ? new Date(ultimoInbound.getTime() - entre(20) * DIA_MS)
          : null;
        await cliente.query(
          `INSERT INTO contactos
             (id, tenant_id, wa_id, nombre, email, cedula, consent_at, consent_version,
              ultimo_inbound_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            id,
            tenantId,
            siguienteNumero(),
            persona?.nombre ?? null,
            persona?.email ?? null,
            persona?.cedula ?? null,
            consentAt,
            consentAt === null ? null : VERSION_CONSENTIMIENTO,
            ultimoInbound,
          ],
        );
        return id;
      };

      // --- Los que reservaron -----------------------------------------------
      const clientes: string[] = [];
      for (const persona of CLIENTES) {
        clientes.push(await crearContacto(persona, new Date(ahora - entre(6) * DIA_MS)));
      }

      // --- Horas de oficina --------------------------------------------------
      /**
       * Los inicios posibles de un día, según el horario real del despacho y el paso de la
       * política (45 + 15 = en punto). Sembrar en UTC daría citas de madrugada.
       */
      const paso = POLITICA.duracionMin + POLITICA.bufferMin;
      const inicios = (dia: string): number[] => {
        const salida: number[] = [];
        for (const tramo of config.horarios[String(reloj.diaSemana(dia))] ?? []) {
          const desde = minutosDeHora(tramo.desde);
          const hasta = minutosDeHora(tramo.hasta);
          if (desde === null || hasta === null) continue;
          for (let m = desde; m + POLITICA.duracionMin <= hasta; m += paso) salida.push(m);
        }
        return salida;
      };

      // --- Citas --------------------------------------------------------------
      /**
       * `citas_una_activa_por_contacto` no deja que un contacto tenga dos citas en pie a la
       * vez, y `citas_slot_unico` no deja dos del mismo abogado a la misma hora. Son
       * restricciones del motor, no consultas previas: aquí se lleva la cuenta para no
       * chocar contra ellas.
       */
      const conActiva = new Set<string>();
      const ocupado = new Set<string>();

      interface CitaCreada {
        contactoId: string;
        creadaMs: number;
      }
      const creadas: CitaCreada[] = [];
      let marcadas = 0;
      let activas = 0;

      const insertarCita = async (opciones: {
        dia: string;
        minutos: number;
        estado: string;
      }): Promise<boolean> => {
        const activa = opciones.estado === 'reservada' || opciones.estado === 'confirmada';
        const posibles = activa ? clientes.filter((c) => !conActiva.has(c)) : clientes;
        if (posibles.length === 0) return false;
        const contactoId = alguno(posibles);

        const abogado = alguno(abogados);
        const llave = `${abogado.id}@${opciones.dia}@${opciones.minutos}`;
        if (ocupado.has(llave)) return false;
        ocupado.add(llave);

        // El abogado atiende lo suyo: societario con el penalista no se sostiene.
        const suyas = tarifas.filter((t) => abogado.materias.includes(t.materia));
        const tarifa = alguno(suyas.length > 0 ? suyas : tarifas);

        const iniciaMs = reloj.instanteLocal(opciones.dia, opciones.minutos);
        const cancelada = opciones.estado === 'cancelada';
        // Se reservó unos días antes de la cita, y nunca en el futuro.
        const creadaMs = Math.min(iniciaMs - (2 + entre(6)) * DIA_MS, ahora - HORA_MS);

        await cliente.query(
          `INSERT INTO citas
             (tenant_id, abogado_id, contacto_id, materia, modalidad, inicia_at, termina_at,
              estado, honorario_usd, cancelada_at, cancelada_por, created_at)
           VALUES ($1, $2, $3, $4, $5::modalidad, $6, $7, $8::cita_estado, $9, $10,
                   $11::cancelada_por, $12)`,
          [
            tenantId,
            abogado.id,
            contactoId,
            tarifa.materia,
            azar() < 0.3 ? 'virtual' : 'presencial',
            new Date(iniciaMs),
            new Date(iniciaMs + POLITICA.duracionMin * MIN_MS),
            opciones.estado,
            tarifa.honorarioUsd,
            cancelada ? new Date(Math.min(iniciaMs - DIA_MS, ahora - HORA_MS)) : null,
            cancelada ? 'contacto' : null,
            new Date(creadaMs),
          ],
        );

        creadas.push({ contactoId, creadaMs });
        if (activa) {
          conActiva.add(contactoId);
          activas += 1;
        }
        if (opciones.estado === 'atendida' || opciones.estado === 'ausente') marcadas += 1;
        return true;
      };

      /**
       * Un mes de citas ya pasadas, con el reparto de `PASADAS` mezclado pero completo: así
       * la tasa de ausencias sale igual cada vez. Se reparten por los días laborables que
       * haya, saltándose los que el horario del despacho deja cerrados.
       */
      const pendientes: string[] = [];
      for (const [estado, cuantas] of Object.entries(PASADAS)) {
        for (let i = 0; i < cuantas; i += 1) pendientes.push(estado);
      }
      // Fisher-Yates con la semilla fija: mezcla sin cambiar las cuentas.
      for (let i = pendientes.length - 1; i > 0; i -= 1) {
        const j = entre(i + 1);
        [pendientes[i], pendientes[j]] = [pendientes[j]!, pendientes[i]!];
      }

      const laborables: string[] = [];
      for (let atras = DIAS_HISTORIA; atras >= 1; atras -= 1) {
        const dia = reloj.diaLocal(ahora - atras * DIA_MS);
        if (inicios(dia).length > 0) laborables.push(dia);
      }
      if (laborables.length === 0) throw new Error('El horario del despacho no deja ningún día abierto');

      let cursor = 0;
      for (const estado of pendientes) {
        // Varias vueltas si hacen falta: cada una pone como mucho una cita por día.
        for (let intento = 0; intento < laborables.length; intento += 1) {
          const dia = laborables[cursor % laborables.length]!;
          cursor += 1;
          if (await insertarCita({ dia, minutos: alguno(inicios(dia)), estado })) break;
        }
      }

      if (marcadas < MINIMO_MUESTRA) {
        throw new Error(
          `Solo ${marcadas} citas marcadas: por debajo de ${MINIMO_MUESTRA} el informe no da ` +
            'porcentajes y la pantalla de métricas no se puede enseñar.',
        );
      }

      /**
       * Hoy y mañana, que es la pantalla que se enseña. Las de hoy se reparten entre horas
       * ya pasadas —que ofrecen «Vino / Faltó»— y horas por venir —que ofrecen «Cancelar»—,
       * para que se vean las dos cosas sin esperar a que den las cinco.
       */
      const [hoy, manana] = reloj.diasDesdeHoy(2);
      const minutosDeAhora = Math.floor((ahora - reloj.instanteLocal(hoy!, 0)) / MIN_MS);
      const deHoy = inicios(hoy!);

      for (const minutos of deHoy.filter((m) => m <= minutosDeAhora).slice(-2)) {
        await insertarCita({ dia: hoy!, minutos, estado: azar() < 0.5 ? 'confirmada' : 'atendida' });
      }
      for (const minutos of deHoy.filter((m) => m > minutosDeAhora).slice(0, 3)) {
        await insertarCita({ dia: hoy!, minutos, estado: azar() < 0.5 ? 'confirmada' : 'reservada' });
      }

      const deManana = inicios(manana!);
      for (const minutos of [deManana[0], deManana[2], deManana[5]]) {
        if (minutos === undefined) continue;
        await insertarCita({ dia: manana!, minutos, estado: azar() < 0.4 ? 'confirmada' : 'reservada' });
      }

      // --- Conversaciones ------------------------------------------------------
      /**
       * Las métricas cuentan por `conversaciones.created_at`, así que hay que repartirlas
       * por el periodo: todas con la fecha de hoy darían un informe de un solo día.
       */
      let conversaciones = 0;
      let mensajes = 0;

      /**
       * Lo que el contacto escribió, que es lo que el abogado lee en la bandeja.
       *
       * Solo entrantes: los salientes guardan si salieron, no su texto, y duplicar ahí el
       * guion sería una segunda copia de `content.ts`. Los `wa_message_id` son únicos por
       * despacho, así que llevan un contador.
       */
      let numeroMensaje = 0;
      const escribir = async (
        conversacionId: string,
        desdeMs: number,
        caso: Caso,
        hasta: 'consentimiento' | 'relato' | 'antecedentes' | 'completa',
      ): Promise<void> => {
        const pasos: { tipo: string; payload: unknown }[] = [
          {
            tipo: 'interactive',
            payload: { interactive: { type: 'button_reply', button_reply: { id: 'acepto', title: 'Acepto' } } },
          },
        ];
        if (hasta !== 'consentimiento') {
          pasos.push(
            caso.porVoz === true
              ? { tipo: 'audio', payload: { audio: { id: 'media-demo', voice: true } } }
              : { tipo: 'text', payload: { text: { body: caso.relato } } },
          );
        }
        if (hasta === 'antecedentes' || hasta === 'completa') {
          pasos.push({ tipo: 'text', payload: { text: { body: caso.antecedentes } } });
        }
        if (hasta === 'completa') {
          pasos.push({
            tipo: 'interactive',
            payload: {
              interactive: {
                type: 'button_reply',
                button_reply: azar() < 0.55
                  ? { id: 'presencial', title: 'Cita presencial' }
                  : { id: 'virtual', title: 'Llamada' },
              },
            },
          });
        }

        for (const [i, paso] of pasos.entries()) {
          numeroMensaje += 1;
          await cliente.query(
            `INSERT INTO mensajes
               (tenant_id, conversacion_id, wa_message_id, direccion, tipo, payload, created_at)
             VALUES ($1, $2, $3, 'entrante', $4, $5::jsonb, $6)`,
            [
              tenantId,
              conversacionId,
              `wamid.DEMO${numeroMensaje}`,
              paso.tipo,
              JSON.stringify(paso.payload),
              new Date(desdeMs + (i + 1) * 90_000),
            ],
          );
          mensajes += 1;
        }
      };

      const nuevaConversacion = async (opciones: {
        contactoId: string;
        estado: string;
        creadaMs: number;
        derivada?: 'consulta_lista' | 'peticion_usuario' | 'tres_fallos';
        abierta?: boolean;
        /** Si se da, se siembra la transcripción: es lo que se lee en la bandeja. */
        caso?: Caso;
        hasta?: 'consentimiento' | 'relato' | 'antecedentes' | 'completa';
      }): Promise<void> => {
        const creada = new Date(opciones.creadaMs);
        const { rows } = await cliente.query<{ id: string }>(
          `INSERT INTO conversaciones
             (tenant_id, contacto_id, estado, flow_version, derivada_at, derivada_motivo,
              cerrada_at, ultimo_inbound_at, expira_at, created_at)
           VALUES ($1, $2, $3, $9, $4, $5::motivo_derivacion, $6, $7, $8, $7)
           RETURNING id`,
          [
            tenantId,
            opciones.contactoId,
            opciones.estado,
            opciones.derivada === undefined ? null : creada,
            opciones.derivada ?? null,
            opciones.abierta === true ? null : new Date(creada.getTime() + HORA_MS),
            creada,
            new Date(creada.getTime() + DIA_MS),
            FLOW_VERSION,
          ],
        );
        conversaciones += 1;
        if (opciones.caso !== undefined) {
          await escribir(rows[0]!.id, opciones.creadaMs, opciones.caso, opciones.hasta ?? 'completa');
        }
      };

      /**
       * Una consulta completa por cada cita del periodo, del mismo contacto y justo antes.
       *
       * Es lo que hace que «citas por cada 100 conversaciones» cuente lo que dice contar: la
       * métrica cruza conversación y cita por contacto y exige que la cita se creara después.
       * Y el orden es el del guion de hoy: el bot toma el caso, el abogado lee la bandeja y
       * **luego** agenda. Por eso el estado es `DERIVADA` con motivo `consulta_lista` y no
       * `CITA_OK`: con este guion el bot no reserva nada.
       */
      const desdeMs = ahora - DIAS_HISTORIA * DIA_MS;
      for (const cita of creadas) {
        if (cita.creadaMs < desdeMs) continue;
        await nuevaConversacion({
          contactoId: cita.contactoId,
          estado: 'DERIVADA',
          creadaMs: cita.creadaMs - 40 * MIN_MS,
          derivada: 'consulta_lista',
          caso: alguno(CASOS),
        });
      }

      // --- Los que se quedaron por el camino ---------------------------------
      /**
       * Uno por conversación: quien abandona no vuelve a escribir esa misma tarde.
       *
       * Los nombres se reparten de una baraja mezclada y sin devolver la carta, así que no
       * se repiten mientras haya. Uno de cada doce va sin nombre: es quien tiene el perfil
       * de WhatsApp en blanco.
       */
      const baraja = [...NOMBRES_SUELTOS];
      for (let i = baraja.length - 1; i > 0; i -= 1) {
        const j = entre(i + 1);
        [baraja[i], baraja[j]] = [baraja[j]!, baraja[i]!];
      }
      let siguienteNombre = 0;
      const curioso = async (
        diasAtras: number,
        conNombre: boolean,
        consintio = true,
      ): Promise<string> => {
        const cuando = new Date(ahora - diasAtras * DIA_MS - entre(9) * HORA_MS);
        const nombre = baraja[siguienteNombre++ % baraja.length]!;
        const persona = conNombre ? { nombre, email: null, cedula: null } : null;
        return crearContacto(persona, cuando, consintio);
      };

      for (const { estado, cuantas } of ABANDONO) {
        for (let i = 0; i < cuantas; i += 1) {
          const diasAtras = 1 + entre(DIAS_HISTORIA - 1);
          // El nombre llega en el perfil con el primer mensaje, así que lo tiene casi
          // cualquiera: el que no, tiene el perfil en blanco.
          const contactoId = await curioso(diasAtras, i % 12 !== 0, estado !== 'CONSENTIMIENTO');
          await nuevaConversacion({
            contactoId,
            estado,
            creadaMs: ahora - diasAtras * DIA_MS - entre(9) * HORA_MS,
          });
        }
      }

      for (const { estado, cuantas } of TERMINADAS) {
        for (let i = 0; i < cuantas; i += 1) {
          const diasAtras = 1 + entre(DIAS_HISTORIA - 1);
          const contactoId = await curioso(diasAtras, azar() < 0.9);
          await nuevaConversacion({
            contactoId,
            estado,
            creadaMs: ahora - diasAtras * DIA_MS - entre(9) * HORA_MS,
          });
        }
      }

      /**
       * Consultas completas que el abogado ya atendió y cerró, sin que de ahí saliera una
       * cita: llamó, resolvió por teléfono, o la persona no volvió a contestar. Sin ellas,
       * «citas por cada 100 conversaciones» saldría casi perfecto y nadie se lo creería.
       */
      for (let i = 0; i < CONSULTAS_CERRADAS; i += 1) {
        const diasAtras = 2 + entre(DIAS_HISTORIA - 2);
        const contactoId = await curioso(diasAtras, true);
        await nuevaConversacion({
          contactoId,
          estado: 'DERIVADA',
          creadaMs: ahora - diasAtras * DIA_MS - entre(9) * HORA_MS,
          derivada: 'consulta_lista',
          caso: alguno(CASOS),
        });
      }

      for (let i = 0; i < ATASCADAS_CERRADAS; i += 1) {
        const diasAtras = 2 + entre(DIAS_HISTORIA - 2);
        const contactoId = await curioso(diasAtras, true);
        await nuevaConversacion({
          contactoId,
          estado: i % 2 === 0 ? 'RELATO' : 'ANTECEDENTES',
          creadaMs: ahora - diasAtras * DIA_MS - entre(9) * HORA_MS,
          derivada: i % 2 === 0 ? 'peticion_usuario' : 'tres_fallos',
          caso: alguno(CASOS),
          hasta: i % 2 === 0 ? 'consentimiento' : 'relato',
        });
      }

      /**
       * La bandeja de ahora mismo, que es la pantalla con la que se abre la demostración.
       *
       * Son consultas completas, con su transcripción, repartidas por la mañana de hoy: lo
       * que el abogado va a hacer es abrir cada una, leer el caso y llamar para agendar. Las
       * dos atascadas van al final porque la bandeja ordena por `derivada_at`, y una
       * incidencia entre consultas normales es justo lo que hay que saber distinguir.
       */
      /**
       * Nadie escribe a un estudio jurídico a las tres de la mañana, y en la bandeja la
       * primera columna es la hora. Repartir las siete hacia atrás a una por hora las metía
       * de madrugada cuando la siembra se corre temprano, que es justo cuando se prepara una
       * demostración. La ventana empieza como muy pronto a las 08:00 de hoy, y si eso deja
       * menos de hora y media se comprime en lugar de retroceder.
       */
      const abiertoDesde = reloj.instanteLocal(hoy!, 8 * 60);
      const masAntiguo = Math.min(Math.max(abiertoDesde, ahora - 5 * HORA_MS), ahora - 90 * MIN_MS);
      const esperando = CONSULTAS_ESPERANDO + 2;
      const separacion = (ahora - masAntiguo) / esperando;

      for (let i = 0; i < CONSULTAS_ESPERANDO; i += 1) {
        await nuevaConversacion({
          contactoId: await curioso(0, true),
          estado: 'DERIVADA',
          creadaMs: Math.round(masAntiguo + i * separacion),
          derivada: 'consulta_lista',
          abierta: true,
          caso: CASOS[i % CASOS.length]!,
        });
      }

      await nuevaConversacion({
        contactoId: await curioso(0, true),
        estado: 'ANTECEDENTES',
        creadaMs: Math.round(masAntiguo + CONSULTAS_ESPERANDO * separacion),
        derivada: 'tres_fallos',
        abierta: true,
        caso: alguno(CASOS),
        hasta: 'relato',
      });
      await nuevaConversacion({
        contactoId: await curioso(0, false),
        estado: 'RELATO',
        creadaMs: Math.round(masAntiguo + (CONSULTAS_ESPERANDO + 1) * separacion),
        derivada: 'peticion_usuario',
        abierta: true,
        caso: alguno(CASOS),
        hasta: 'consentimiento',
      });

      await cliente.query('COMMIT');

      process.stdout.write(
        `despacho «${slug}» sembrado (${despacho.nombre})\n` +
          `  citas:          ${creadas.length} (${activas} en pie, ${marcadas} marcadas)\n` +
          `  conversaciones: ${conversaciones}\n` +
          `  mensajes:       ${mensajes} (la transcripción que se lee en la bandeja)\n` +
          `  esperando:      ${CONSULTAS_ESPERANDO + 2}\n\n` +
          `Panel: <PANEL_ORIGEN>/panel/${slug}\n` +
          `Para entrar hace falta una passkey:\n` +
          `  npm run panel:invitar ${slug} maria@demo.local\n`,
      );
    } catch (error) {
      await cliente.query('ROLLBACK');
      throw error;
    }
  } finally {
    await cliente.end();
  }
}

await main();
