# Node 24: la elisión de tipos ya no necesita bandera, así que la imagen no lleva ni
# compilador ni artefactos intermedios. Lo que se despliega es exactamente lo que está en
# el repositorio.
FROM node:24-alpine AS dependencias
WORKDIR /app
COPY package.json package-lock.json ./
# `--ignore-scripts`: ningún paquete de este stack necesita compilar nada, y un postinstall
# es el sitio más cómodo para esconder código en una cadena de suministro.
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
WORKDIR /app

# Sin capa de shell ni gestor de paquetes en tiempo de ejecución: `tini` para que la señal
# de parada llegue al proceso y `curl` para el healthcheck del compose.
RUN apk add --no-cache tini curl

ENV NODE_ENV=production
COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY estatico ./estatico
COPY audios ./audios

# Contenedor non-root. La imagen de Node ya trae el usuario `node`; no hay nada que escribir
# en el sistema de archivos, así que además puede montarse en solo lectura.
USER node

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/adapters/http/servidor.ts"]
