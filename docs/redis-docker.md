# Redis local con Docker (Windows)

El archivo `compose.yaml` ejecuta únicamente Redis para BullMQ. NestJS y PostgreSQL conservan su configuración actual. No contiene credenciales ni carga el `.env` dentro del contenedor.

## 1. Instalar Docker

Instala [Docker Desktop para Windows](https://docs.docker.com/desktop/setup/install/windows-install/) con el backend WSL 2. Sigue los requisitos del instalador, reinicia Windows si lo solicita y abre Docker Desktop. Espera a que su motor esté iniciado y abre una terminal nueva en la raíz del proyecto.

```powershell
docker version
docker compose version
```

Si `docker` no se reconoce, comprueba la instalación y vuelve a abrir la terminal. Si no conecta con el motor, abre Docker Desktop y espera a que arranque. Usa contenedores Linux.

## 2. Iniciar Redis

Antes de conectar los workers, revisa si tienes mensajes salientes pendientes: con WhatsApp habilitado podrían enviarse al recuperar Redis. Puedes detener temporalmente el backend con Ctrl+C mientras preparas Redis.

```powershell
docker compose up -d redis
docker compose ps
docker compose exec redis redis-cli ping
```

La primera ejecución descarga la imagen. Espera estado `healthy` y respuesta `PONG`. Si el puerto 6379 ya está ocupado, identifica el servicio existente antes de detenerlo; no inicies dos servidores en el mismo puerto.

Redis queda accesible solo en `127.0.0.1:6379`, sin contraseña, para desarrollo local. No lo expongas por ngrok ni uses esta configuración como despliegue de producción. El volumen conserva datos y AOF habilita persistencia. La política `noeviction` evita expulsar claves de las colas, siguiendo las [recomendaciones de BullMQ](https://docs.bullmq.io/guide/going-to-production).

## 3. Conectar el backend

En tu `.env` local:

```dotenv
MESSAGING_ENABLED=true
REDIS_URL="redis://127.0.0.1:6379/0"
MESSAGING_QUEUE_PREFIX="eyaq-messaging"
```

Mantén las credenciales de WhatsApp únicamente en `.env`, fuera de Git. Inicia una sola instancia del backend para evitar `EADDRINUSE`:

```powershell
npm run start:dev
```

Si habías definido `MESSAGING_ENABLED` o `REDIS_URL` con `$env:` en esa terminal, esos valores pueden prevalecer sobre `.env`; usa una terminal nueva o elimina únicamente esos overrides deliberadamente.

Comprueba que ya no aparecen `MESSAGING_REDIS_UNAVAILABLE` ni `MESSAGING_WORKER_UNAVAILABLE`. Si continúan, revisa los logs y la URL efectiva; `PONG` solo confirma Redis, no el procesamiento completo ni la entrega de WhatsApp.

```powershell
docker compose logs --tail 50 redis
```

Continúa con la [guía de WhatsApp](whatsapp-postman.md) para probar mensajes y consultar conversaciones.

## Detener sin borrar datos

```powershell
docker compose stop redis
```

Vuelve a iniciarlo con `docker compose up -d redis`. No uses `docker compose down -v` si quieres conservar los datos: elimina el volumen.
