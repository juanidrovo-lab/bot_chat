# Providencia

Bot de WhatsApp para estudios jurídicos: atiende la consulta, la clasifica por materia,
informa el honorario y agenda la cita en un horario realmente libre. Multi-despacho desde el
primer día, con un panel web para los abogados.

- La especificación está en [`PLAN-BOT-PROVIDENCIA.md`](PLAN-BOT-PROVIDENCIA.md).
- Las reglas de arquitectura, en [`CLAUDE.md`](CLAUDE.md).
- Qué hacer cuando algo se rompe en producción, en [`RUNBOOK.md`](RUNBOOK.md).

---

## Levantar una demostración en su máquina

Quince minutos, sin cuenta de Meta y sin cuenta de Google. Lo que se enseña es **el panel**,
con un despacho ficticio y un mes de agenda: el lado de WhatsApp necesita el número
verificado y las plantillas aprobadas, que son trámites del estudio y no se pueden simular.

### 1. Qué hace falta instalado

| | Versión | Comprobar | Si falta |
|---|---|---|---|
| **Node.js** | 24 o superior | `node -v` | [nodejs.org](https://nodejs.org) o `nvm install 24` |
| **Docker Desktop** | cualquiera reciente | `docker --version` | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Git** | cualquiera | `git --version` | viene con Xcode en Mac; [git-scm.com](https://git-scm.com) en Windows |

Con **Node 22 el `npm install` avisa con `EBADENGINE`** y algunas cosas fallan de formas
raras: el proyecto usa elisión de tipos nativa, que cambió entre versiones. Si tiene `nvm`,
el repositorio trae un `.nvmrc` y basta con `nvm use` dentro de la carpeta.

Docker es solo para la base de datos. Si ya tiene un PostgreSQL 17 a mano, puede saltárselo
(ver «Sin Docker», al final).

### 2. Clonar e instalar

> **En Windows: use Git Bash, no el Símbolo del sistema.** Vino con Git. Los comandos de
> aquí abajo son los de un terminal Unix —`cp`, `cat`— y en `cmd.exe` fallan con «no se
> reconoce como un comando interno o externo». En el menú Inicio busque **Git Bash**, o
> haga clic derecho sobre la carpeta del proyecto → *Open Git Bash here*.
>
> **Y no clone dentro de `C:\Windows\System32`.** Es lo que pasa si abre el terminal como
> administrador, porque arranca ahí: esa carpeta es del sistema operativo, escribir en ella
> exige permisos especiales y no es sitio para un proyecto. Empiece por `cd ~`.

```bash
cd ~
git clone https://github.com/juanidrovo-lab/bot_chat.git
cd bot_chat
git checkout claude/plan-bot-providencia-review-hry28l
nvm use          # si tiene nvm; si no, asegúrese de estar en Node 24+
npm install
```

### 3. El fichero `.env`

```bash
cp .env.example .env
```

<sub>En `cmd.exe`: `copy .env.example .env`</sub>

Ya viene relleno con credenciales de juguete para una base local. **No sirven para un
servidor**, y el fichero está en el `.gitignore`: nunca se sube. Si quiere saber qué es cada
cosa, el propio `.env.example` lo explica línea a línea.

### 4. La base de datos

El `compose.yml` **no publica el puerto** a propósito: en un servidor la base no se asoma a
internet. Para la demostración hace falta llegar a ella desde su máquina, así que se abre
con un fichero al lado —que ya está en el `.gitignore`—:

```bash
cat > compose.override.yml <<'FIN'
services:
  postgres:
    ports: ['5432:5432']
FIN

docker compose up -d postgres
```

<sub>En `cmd.exe`, el fichero se crea así:
`(echo services:& echo   postgres:& echo     ports: ['5432:5432']) > compose.override.yml`</sub>

Espere a que arranque —la primera vez tarda uno o dos minutos porque baja la imagen— y
compruebe que dice `healthy` antes de seguir:

```bash
docker compose ps
```

Si dice `starting`, espere y repita. Cuando esté sano:

```bash
npm run db:aprovisionar   # crea los tres roles y la base (idempotente)
npm run db:migrate        # crea las tablas
```

### 5. El despacho de ejemplo y sus datos

```bash
npm run despacho:alta demo/despacho.json   # el estudio, sus 3 abogados y su tarifario
npm run demo:sembrar                       # un mes de agenda, citas y conversaciones
```

El segundo comando imprime lo que sembró. Avisará de que **no hay Flow de datos**: es
correcto y no afecta al panel — sin él el bot no podría pedir nombre y cédula por WhatsApp,
que es trámite de Meta.

`demo:sembrar` **borra y vuelve a escribir** los contactos, conversaciones y citas de ese
despacho, así que se puede correr las veces que haga falta. Por lo mismo se niega a correr
con `NODE_ENV=production`.

### 6. Su passkey

El panel no tiene contraseña: se entra con la huella, la cara o el PIN del dispositivo. El
alta va por invitación de un solo uso.

```bash
npm run panel:invitar demo maria@demo.local
```

Imprime una URL. **Se enseña una sola vez** —en la base queda su hash— y caduca en siete
días.

### 7. Arrancar y entrar

```bash
npm run dev
```

1. Abra la URL de la invitación en **Chrome, Edge o Safari**.
2. Pulse «Registrar este dispositivo» y confirme con Touch ID, Windows Hello o el PIN.
3. Ya está dentro: <http://localhost:3000/panel/demo>

Para volver a entrar después, vaya directamente a esa dirección y pulse «Entrar».

---

## Qué enseñar

| Pantalla | Qué se ve |
|---|---|
| **Hoy y mañana** | La agenda de los dos días, con el estado de cada cita. Las de horas ya pasadas ofrecen «Vino / Faltó»; las de después, «Cancelar». Abajo, quién está esperando a que le conteste una persona. |
| **Cancelar una cita** | No pregunta «¿está seguro?»: cancela y deja diez segundos para deshacer. Los efectos que no se pueden deshacer —el aviso al cliente, el borrado del evento de Google— esperan ese plazo. |
| **El nombre del contacto** | Se despliega su ficha ahí mismo, con su historial y el botón de exportar sus datos (LOPDP). Ese despliegue queda auditado; ver la agenda, no. |
| **El buscador** | Alcanza a quien no tiene cita hoy ni mañana: «llamó el señor Pérez, ¿cuándo viene?». |
| **Métricas** | Las cinco cifras del mes, cada porcentaje con su denominador, y dónde se quedan las conversaciones que no acaban. Con muestra pequeña dice «Sin datos» en vez de inventarse un número. |
| **Calendarios** | Dónde cada abogado conecta su Google Calendar. En la demostración no hay credenciales de Google, así que dirá que no se puede conectar: eso es que **falla cerrado**, no que esté roto. |

El panel se ve igual en el teléfono —cada fila se convierte en un bloque— y tiene modo
oscuro, que sigue al del sistema.

---

## Lo que la demostración **no** enseña

Conviene decirlo antes de que lo pregunten:

- **El bot de WhatsApp no responde.** Necesita el número verificado en Meta, las dos
  plantillas aprobadas y el Flow de datos publicado. Son trámites del estudio (fase 0 del
  plan), no código pendiente.
- **Google Calendar no se conecta.** Hace falta un proyecto en Google Cloud con una URI de
  retorno por despacho.
- **Las notas de voz no suenan.** Los `.ogg` se registran contra la API de Meta.

Todo eso está escrito y probado; lo que falta son las credenciales.

---

## Para trabajar en el código

```bash
npm run dev              # servidor + trabajadores en local
npm test                 # unitarios de dominio y adaptadores, sin Docker
npm run test:integration # con Postgres real: concurrencia, RLS y agenda
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run lint:arch        # la regla de dependencias entre anillos
```

Las cinco tienen que pasar antes de dar una fase por cerrada, y CI las corre en cada push.

### Sin Docker

Si ya tiene un PostgreSQL 17 corriendo, cambie los `127.0.0.1:5432` del `.env` por los
suyos, sáltese el paso 4 y siga desde `npm run db:aprovisionar`. El aprovisionamiento es el
mismo para los tres caminos —compose, CI y un clúster local— a propósito.

### Si algo no arranca

| Síntoma | Qué pasa |
|---|---|
| `EBADENGINE` al instalar | Está en Node 22 o anterior. `nvm use` o instale Node 24. |
| `ECONNREFUSED ... 5432` | Postgres no está arriba o no publicó el puerto. Revise el `compose.override.yml` del paso 4. |
| `Configuración inválida en: CLAVE_CIFRADO_HEX` | Esa clave son 64 caracteres hexadecimales exactos. |
| La passkey no se registra | `PANEL_ORIGEN` tiene que ser idéntico a la barra de direcciones. Con `http://localhost:3000` entre por `localhost`, no por `127.0.0.1`. |
| `No hay despacho activo con slug «demo»` | Falta el paso 5: `npm run despacho:alta demo/despacho.json`. |
| El panel se ve vacío | Falta `npm run demo:sembrar`. |
| `"cp" no se reconoce como un comando…` | Está en el Símbolo del sistema de Windows. Abra **Git Bash**. |
| `EPERM` o «acceso denegado» al instalar | Clonó dentro de `C:\Windows\System32`. Mueva el proyecto a su carpeta de usuario. |
