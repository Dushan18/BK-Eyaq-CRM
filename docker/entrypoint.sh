#!/bin/sh
# Arranque del contenedor: migraciones pendientes y luego el API.
# Las migraciones del proyecto son aditivas; aun así, respalda la base antes de desplegar
# una versión que traiga migraciones nuevas. RUN_MIGRATIONS=false para aplicarlas a mano.
set -e
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  ./node_modules/.bin/prisma migrate deploy
fi
exec node dist/src/main
