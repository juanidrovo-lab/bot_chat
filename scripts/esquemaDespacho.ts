/**
 * La forma del JSON con el que se da de alta un despacho.
 *
 * Vive aparte de `despacho.ts` porque ese módulo corre `main()` al importarse: un test que
 * quisiera validar `demo/aseleb.json` daría de alta el despacho en vez de comprobarlo. Aquí
 * no hay efectos, así que se puede leer desde un test y desde el propio script.
 */
import { z } from 'zod';
import { ZONA } from '../src/platform/time.ts';

const Tramo = z.object({ desde: z.string(), hasta: z.string() });

/**
 * Un número de WhatsApp como lo quiere Meta: **solo dígitos**, en formato internacional,
 * sin `+`, sin espacios y sin guiones.
 *
 * Se valida aquí porque el error llega tardísimo y mudo: `+593 99 013 7819` se guarda tal
 * cual —es un `string` y `jsonb` acepta cualquier cosa—, y el fallo aparece meses después,
 * la primera vez que entra una consulta y el aviso al abogado se rechaza en silencio.
 */
const NumeroWa = z
  .string()
  .regex(/^[1-9]\d{7,14}$/, 'solo dígitos, formato internacional sin + ni espacios: 593990137819');

export const Configuracion = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'solo minúsculas, números y guiones: va en la URL del panel'),
  nombre: z.string().min(1),
  waPhoneNumberId: z.string().min(1),
  waWabaId: z.string().min(1),
  /**
   * El número al que escriben los clientes, para que quede escrito junto a su identificador
   * de Meta. `waPhoneNumberId` es una cadena que Meta asigna y que no se parece a nada: sin
   * esto, nadie puede comprobar de un vistazo que apunta a la línea correcta del estudio.
   * No se guarda en la base; se valida y se imprime al dar de alta.
   */
  waNumero: NumeroWa.optional(),
  /**
   * Zona horaria del despacho. **Hoy solo se admite la del sistema.**
   *
   * El reloj del proyecto es único (`adapters/reloj.ts`) y de ahí salen los días de la
   * agenda, las horas que se ofrecen y la zona de los crones; solo las métricas agrupan por
   * `tenants.tz`. Con todos los despachos en la misma zona da igual, pero uno en otra
   * discreparía **en silencio**: la agenda diría una cosa y el informe del mes otra. Se
   * rechaza aquí, que es donde alguien está mirando.
   */
  tz: z.string().default(ZONA),
  /** Cómo se llama la aplicación para este estudio, en el panel. Sin esto, la de serie. */
  marca: z.string().min(1).optional(),
  /** Quién atiende la consulta virtual: el guion promete que esa persona escribe. */
  abogadoPrincipal: z.string().min(1).optional(),
  /**
   * La oficina, para el flujo presencial.
   *
   * `punto` es opcional y va entero o nada: una latitud sin su longitud no manda a ningún
   * sitio. Es opcional porque una dirección de esquina no siempre tiene un punto exacto a
   * mano, y el despacho no puede quedarse sin poner su dirección por eso — sin punto va la
   * dirección por texto y no se promete ningún mapa.
   *
   * Las coordenadas son números: en `jsonb` se guardarían igual como texto y el punto no
   * abriría en ningún mapa.
   */
  oficina: z
    .object({
      direccion: z.string().min(1),
      nombre: z.string().min(1).optional(),
      punto: z.object({ latitud: z.number(), longitud: z.number() }).optional(),
    })
    .optional(),
  /** Clave de la imagen con la cuenta bancaria, ya registrada con `audios:registrar`. */
  imagenDeposito: z.string().min(1).optional(),
  /**
   * A qué número avisar cuando entra una consulta, y con qué plantilla aprobada en Meta.
   *
   * Va por plantilla porque ese número nunca escribió al bot: su ventana de 24 h está
   * cerrada desde siempre y un texto libre sería un rechazo silencioso.
   */
  avisoAbogado: z
    .object({ waId: NumeroWa, plantilla: z.string().min(1) })
    .optional(),
  tarifario: z.record(
    z.string(),
    z.object({
      titulo: z.string().min(1),
      honorarioUsd: z.string().regex(/^\d+\.\d{2}$/, 'dos decimales, como "40.00"'),
      triaje: z
        .array(
          z.object({
            pregunta: z.string().min(1),
            opciones: z.array(z.object({ id: z.string().min(1), titulo: z.string().min(1) })).min(1),
          }),
        )
        .default([]),
    }),
  ),
  /** Clave: día de la semana, 0 = domingo. */
  horarios: z.record(z.string().regex(/^[0-6]$/), z.array(Tramo)),
  /**
   * El Flow de captura de datos, creado y publicado en Meta (fase 0). **Sin esto el bot no
   * puede pedir nombre ni cédula**, y la conversación se queda a un paso de reservar: se
   * deriva a una persona en cuanto llega a ese punto.
   */
  flowDatos: z.object({ flowId: z.string().min(1), cta: z.string().min(1) }).optional(),
  /** Textos que este despacho reescribe. Los que no toque se quedan con los de `content.ts`. */
  textos: z.record(z.string(), z.string().min(1)).default({}),
  abogados: z
    .array(z.object({ nombre: z.string().min(1), materias: z.array(z.string().min(1)).min(1) }))
    .min(1),
  usuarios: z
    .array(
      z.object({
        email: z.email(),
        nombre: z.string().min(1),
        rol: z.enum(['abogado', 'secretaria']).default('abogado'),
        /** Nombre del abogado con el que se corresponde, si lo es. */
        abogado: z.string().optional(),
      }),
    )
    .default([]),
});

export type Configuracion = z.infer<typeof Configuracion>;
