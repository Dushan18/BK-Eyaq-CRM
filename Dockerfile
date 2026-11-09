# bk-crm: NestJS 11 + Prisma 7 (PostgreSQL) + BullMQ (Redis). Imagen para Dokploy (o cualquier Docker).
# Arranca aplicando las migraciones pendientes (RUN_MIGRATIONS=false para hacerlas a mano) y luego el API
# en el puerto 3000. La configuración llega por variables de entorno: el archivo .env no entra en la imagen.

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Prisma necesita OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# El cliente de Prisma no está en git: se genera aquí. No se conecta a ninguna base; la URL es solo un valor.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate \
  && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3000
# node_modules completo: incluye la CLI de Prisma para `migrate deploy`.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY docker/entrypoint.sh ./entrypoint.sh
# Por si el archivo llegó con fin de línea de Windows.
RUN sed -i 's/\r$//' ./entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "./entrypoint.sh"]
