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
 * Los que se quedaron por el camino. Casi ninguno tiene nombre: el bot lo pide en el paso de
 * datos, que es de los últimos, así que quien abandona en el triaje no llegó a darlo.
 */
const NOMBRES_SUELTOS = [
  'Byron Quezada',
  'Nube Chuchuca',
  'Wilson Cárdenas',
  'Janeth Morocho',
  'Iván Peñaloza',
  'Doris Sigüencia',
];

/**
 * Dónde se quedan las conversaciones que no acaban. La mezcla no es aleatoria: se parece a
 * la real, con el grueso en el triaje y en el momento de ver el honorario, que es donde se
 * cae de verdad.
 */
const ABANDONO: { estado: string; cuantas: number }[] = [
  { estado: 'TRIAJE', cuantas: 38 },
  { estado: 'TARIFA', cuantas: 22 },
  { estado: 'ELEGIR_HORA', cuantas: 16 },
  { estado: 'CONSENTIMIENTO', cuantas: 11 },
  { estado: 'DATOS', cuantas: 8 },
  { estado: 'MODALIDAD', cuantas: 5 },
];

/** Finales deliberados: quien dijo «solo consultaba» no abandonó, terminó. */
const TERMINADAS: { estado: string; cuantas: number }[] = [
  { estado: 'CIERRE_SIN_CITA', cuantas: 19 },
  { estado: 'DESPEDIDA', cuantas: 13 },
];

const DERIVADAS_CERRADAS = 14;

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

      const crearContacto = async (persona: Persona | null, ultimoInbound: Date): Promise<string> => {
        const id = randomUUID();
        // Sin nombre no hubo consentimiento: el aviso de datos va antes de preguntar nada.
        const consentAt = persona === null ? null : new Date(ultimoInbound.getTime() - entre(20) * DIA_MS);
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
      const nuevaConversacion = async (opciones: {
        contactoId: string;
        estado: string;
        creadaMs: number;
        derivada?: 'peticion_usuario' | 'tres_fallos';
        abierta?: boolean;
      }): Promise<void> => {
        const creada = new Date(opciones.creadaMs);
        await cliente.query(
          `INSERT INTO conversaciones
             (tenant_id, contacto_id, estado, flow_version, derivada_at, derivada_motivo,
              cerrada_at, ultimo_inbound_at, expira_at, created_at)
           VALUES ($1, $2, $3, 1, $4, $5::motivo_derivacion, $6, $7, $8, $7)`,
          [
            tenantId,
            opciones.contactoId,
            opciones.estado,
            opciones.derivada === undefined ? null : creada,
            opciones.derivada ?? null,
            opciones.abierta === true ? null : new Date(creada.getTime() + HORA_MS),
            creada,
            new Date(creada.getTime() + DIA_MS),
          ],
        );
        conversaciones += 1;
      };

      /**
       * Una conversación con cita por cada cita reservada en el periodo, del mismo contacto
       * y justo antes de reservar. Es lo que hace que «citas por cada 100 conversaciones»
       * cuente lo que dice contar: la métrica cruza conversación y cita por contacto, y
       * exige que la cita se creara después.
       */
      const desdeMs = ahora - DIAS_HISTORIA * DIA_MS;
      for (const cita of creadas) {
        if (cita.creadaMs < desdeMs) continue;
        await nuevaConversacion({
          contactoId: cita.contactoId,
          estado: 'CITA_OK',
          creadaMs: cita.creadaMs - 20 * MIN_MS,
        });
      }

      // --- Los que se quedaron por el camino ---------------------------------
      /** Uno por conversación: quien abandona no vuelve a escribir esa misma tarde. */
      const curioso = async (diasAtras: number, conNombre: boolean): Promise<string> => {
        const cuando = new Date(ahora - diasAtras * DIA_MS - entre(9) * HORA_MS);
        const persona = conNombre ? { nombre: alguno(NOMBRES_SUELTOS), email: null, cedula: null } : null;
        return crearContacto(persona, cuando);
      };

      for (const { estado, cuantas } of ABANDONO) {
        for (let i = 0; i < cuantas; i += 1) {
          const diasAtras = 1 + entre(DIAS_HISTORIA - 1);
          // Solo quien pasó del paso de datos llegó a decir su nombre.
          const contactoId = await curioso(diasAtras, estado === 'DATOS' || estado === 'ELEGIR_HORA');
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
          const contactoId = await curioso(diasAtras, azar() < 0.5);
          await nuevaConversacion({
            contactoId,
            estado,
            creadaMs: ahora - diasAtras * DIA_MS - entre(9) * HORA_MS,
          });
        }
      }

      for (let i = 0; i < DERIVADAS_CERRADAS; i += 1) {
        const diasAtras = 2 + entre(DIAS_HISTORIA - 2);
        const contactoId = await curioso(diasAtras, true);
        await nuevaConversacion({
          contactoId,
          estado: 'DERIVADA',
          creadaMs: ahora - diasAtras * DIA_MS - entre(9) * HORA_MS,
          derivada: i % 2 === 0 ? 'peticion_usuario' : 'tres_fallos',
        });
      }

      // Las dos que esperan a una persona ahora mismo: es la bandeja del panel.
      await nuevaConversacion({
        contactoId: await curioso(0, true),
        estado: 'ELEGIR_HORA',
        creadaMs: ahora - 6 * HORA_MS,
        derivada: 'tres_fallos',
        abierta: true,
      });
      await nuevaConversacion({
        contactoId: await curioso(0, false),
        estado: 'TRIAJE',
        creadaMs: ahora - 2 * HORA_MS,
        derivada: 'peticion_usuario',
        abierta: true,
      });

      await cliente.query('COMMIT');

      process.stdout.write(
        `despacho «${slug}» sembrado (${despacho.nombre})\n` +
          `  citas:          ${creadas.length} (${activas} en pie, ${marcadas} marcadas)\n` +
          `  conversaciones: ${conversaciones}\n` +
          `  esperando:      2\n\n` +
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
