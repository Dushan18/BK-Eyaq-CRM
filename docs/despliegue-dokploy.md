# Despliegue en un VPS con Dokploy

Guía para publicar el CRM (bk-crm + ft-crm) en un VPS administrado con Dokploy. Dokploy construye cada
repositorio con su `Dockerfile` y Traefik pone el HTTPS (Let's Encrypt).

```text
Internet ──HTTPS──► Traefik ──► crm.<dominio>          ──► ft-crm  :5173 ──(red interna)──► bk-crm :3000
                            └─► api.<dominio>/webhooks  ──► bk-crm  :3000   (solo Meta)
                                                             bk-crm ──► PostgreSQL 18, Redis 7 (red interna)
```

El navegador nunca llama al backend: el frontend (BFF) lo hace por la red interna. Desde Internet, el
backend solo recibe los webhooks de Meta.

## 0. Antes de empezar

- **DNS:** registros `A` de `crm.<dominio>` y `api.<dominio>` hacia la IP del VPS.
- **Código:** commit y push de bk-crm y ft-crm a la rama que vas a desplegar.
- **GitHub en Dokploy:** *Settings → Git → GitHub*, con acceso a `BK-Eyaq-CRM` y `FT-Eyaq-CRM`.

## 1. Proyecto, PostgreSQL y Redis

1. *Create Project*, por ejemplo `crm-sabor-magico`.
2. *Create Service → Database → PostgreSQL*, imagen `postgres:18`, base `crm`. Copia la
   **Internal Connection URL**: es el `DATABASE_URL` del backend.
3. *Create Service → Database → Redis*, imagen `redis:7`. En *Advanced → Command* pon
   `redis-server --appendonly yes`, para que la cola de envíos sobreviva a un reinicio. Copia la
   **Internal Connection URL** y agrégale `/0` al final: es el `REDIS_URL`.
4. **Respaldos:** en el PostgreSQL, *Backups* → uno diario a un destino S3 (*Settings → S3 Destinations*).

## 2. Backend (bk-crm)

1. *Create Service → Application* `bk-crm`. *Provider*: GitHub, repositorio `BK-Eyaq-CRM`, la rama.
   *Build Type*: **Dockerfile** (`Dockerfile`).
2. *Environment*: las variables de la [sección 4](#4-variables-del-backend).
3. *Domains*: host `api.<dominio>`, path `/webhooks`, puerto `3000`, HTTPS con Let's Encrypt. Con el path,
   solo los webhooks quedan públicos.
4. *Advanced → Replicas*: **1**. La lectura del correo y el modo automático de Samanta corren dentro
   del proceso.
5. *Deploy*. En los logs deben aparecer las migraciones aplicadas y `Nest application successfully started`.
   El contenedor aplica las migraciones pendientes cada vez que arranca (`RUN_MIGRATIONS=false` lo
   desactiva).
6. **Solo la primera vez**, desde la terminal del contenedor del backend en Dokploy:

   ```sh
   node dist/prisma/seed.js
   ```

   Crea los roles, el administrador (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) y el catálogo comercial. Luego
   entra al CRM, cambia esa contraseña y completa *Ajustes → Empresa* (nombre, zona horaria, horarios).
   Sin esa configuración, las reservas de la web quedan en espera (`EMAIL_IMPORT_DEFERRED` en el log).

## 3. Frontend (ft-crm)

1. *Create Service → Application* `ft-crm`, repositorio `FT-Eyaq-CRM`, *Build Type*: **Dockerfile**.
2. *Environment*:

   ```env
   CRM_BACKEND_MODE=live
   # Nombre interno del servicio del backend (Dokploy lo muestra como "App Name").
   CRM_BACKEND_URL=http://<app-name-del-backend>:3000
   # Generar un borrador de Samanta puede tardar hasta 60 s.
   CRM_BACKEND_TIMEOUT_MS=65000
   CRM_COOKIE_SECURE=true
   # Traefik es un proxy delante de Next.js.
   CRM_TRUST_PROXY=1
   ```

3. *Domains*: host `crm.<dominio>`, puerto `5173`, HTTPS con Let's Encrypt.
4. *Deploy* y entra a `https://crm.<dominio>`.

## 4. Variables del backend

Los valores entre `<>` son tuyos. Los marcados como secreto no se comparten ni se suben a git.

```env
NODE_ENV=production
PORT=3000
# Traefik delante del backend.
TRUST_PROXY=1

DATABASE_URL=<Internal Connection URL del PostgreSQL>
MESSAGING_ENABLED=true
REDIS_URL=<Internal Connection URL del Redis>/0
MESSAGING_QUEUE_PREFIX=eyaq-messaging

# Secretos: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=<secreto 1>
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=<secreto 2, distinto>
JWT_REFRESH_EXPIRES_IN=7d

# Solo los usa el seed al crear el administrador.
ADMIN_EMAIL=<correo del administrador>
ADMIN_PASSWORD=<contraseña inicial>

PASSWORD_RESET_TOKEN_TTL_MINUTES=15
FRONTEND_RESET_PASSWORD_URL=https://crm.<dominio>/reset-password
RESEND_API_KEY=<secreto>
# Remitente de un dominio verificado en Resend.
RESEND_FROM_EMAIL=Sabor Mágico Grill <no-reply@<dominio>>

# Meta: tokens permanentes de un usuario del sistema (Business Manager), no los temporales.
META_APP_SECRET=<secreto>
WHATSAPP_ENABLED=true
WHATSAPP_ACCESS_TOKEN=<secreto>
WHATSAPP_VERIFY_TOKEN=<texto que tú eliges>
WHATSAPP_PHONE_NUMBER_ID=<id>
WHATSAPP_BUSINESS_ACCOUNT_ID=<id>
WHATSAPP_API_VERSION=v26.0
MESSENGER_ENABLED=true
MESSENGER_PAGE_ID=<id>
MESSENGER_PAGE_ACCESS_TOKEN=<secreto>
MESSENGER_VERIFY_TOKEN=<texto que tú eliges>
MESSENGER_API_VERSION=v26.0
INSTAGRAM_ENABLED=true
INSTAGRAM_ACCOUNT_ID=<id>
INSTAGRAM_VERIFY_TOKEN=<texto que tú eliges>
INSTAGRAM_ACCESS_TOKEN=<secreto>
INSTAGRAM_API_VERSION=v26.0

SAMANTA_ENABLED=true
OPENAI_API_KEY=<secreto>
SAMANTA_MODEL=gpt-6-luna
SAMANTA_DAILY_LIMIT=300
SAMANTA_CONCURRENT_LIMIT=1
SAMANTA_TIMEOUT_MS=20000
SAMANTA_MAX_OUTPUT_TOKENS=4096
SAMANTA_AUTO_ENABLED=true
SAMANTA_AUTO_SEND=true
SAMANTA_AUTO_CHANNELS=WHATSAPP,FACEBOOK,INSTAGRAM
SAMANTA_AUTO_DELAY_MS=8000
SAMANTA_AUTO_MAX_PER_HOUR=12

EMAIL_ENABLED=true
EMAIL_IMAP_HOST=mail.sabormagicorestaurant.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_SECURE=true
EMAIL_USER=reservas@sabormagicorestaurant.com
EMAIL_PASSWORD=<secreto>
EMAIL_MAILBOX=INBOX
EMAIL_POLL_SECONDS=60
EMAIL_IMPORT_SINCE_DAYS=30
WEB_RESERVATION_SENDERS=reservas@sabormagicorestaurant.com
WEB_RESERVATION_HOSTING_ACCOUNT=sabormgic
# true solo con la plantilla aprobada, método de pago y el permiso de WhatsApp en el formulario.
WEB_RESERVATION_WHATSAPP=false
WEB_RESERVATION_CONTACT_MAX_HOURS=24
WEB_RESERVATION_TEMPLATE=solicitud_reserva_web
WEB_RESERVATION_TEMPLATE_LANGUAGES=es
WEB_RESERVATION_DAILY_LIMIT=50
```

Con `NODE_ENV=production`, el backend no arranca si los secretos JWT son cortos o de ejemplo, si
`FRONTEND_RESET_PASSWORD_URL` no es https pública o si `RESEND_FROM_EMAIL` usa `resend.dev`.

## 5. Meta

1. **Webhooks**, con el mismo token de verificación de la sección 4:
   - WhatsApp: `https://api.<dominio>/webhooks/whatsapp`, campo `messages`.
   - Messenger: `https://api.<dominio>/webhooks/messenger`, con la página suscrita a la app.
   - Instagram: `https://api.<dominio>/webhooks/instagram`.
2. **App en modo «En vivo».**
3. **Instagram:** acceso avanzado a `instagram_business_manage_messages` (revisión de la app). Sin él,
   Meta solo entrega a cuentas con un rol en la app.
4. **WhatsApp:** método de pago en la cuenta de WhatsApp Business, plantilla `solicitud_reserva_web`
   aprobada y verificación del negocio.

## 6. Correo de reservas

- El VPS se conecta por IMAP al cPanel del restaurante. Si la contraseña falla varias veces, cPanel
  bloquea la IP del VPS: revisa el log después del primer despliegue (`EMAIL_AUTH_FAILED`).
- `WEB_RESERVATION_WHATSAPP=true` solo cuando la plantilla esté **Activa** en Meta.

## 7. Actualizar

- Cada push a la rama vuelve a desplegar si activas *Auto Deploy* en cada aplicación. Si no, usa
  *Deploy*.
- Las migraciones se aplican solas al arrancar. **Antes de desplegar una versión con migraciones nuevas,
  haz un respaldo manual** (*PostgreSQL → Backups → Run manual backup*).

## 8. Comprobar

- `https://crm.<dominio>`: el inicio de sesión funciona.
- Verificación de Meta, que debe responder `123`:
  `https://api.<dominio>/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=123`.
- Un mensaje de prueba por WhatsApp, Messenger e Instagram, y la respuesta de Samanta.
- En el log del backend: `EMAIL_WEB_RESERVATION` cuando llegue una reserva, y ningún `EMAIL_AUTH_FAILED`.

## Los datos de tu base local

Producción empieza vacía: el seed crea lo necesario y los clientes y conversaciones de prueba se quedan
en local. Si aun así quieres llevarlos, restaura un respaldo de `bd_crm` con `pg_restore` en la base
nueva **antes** del primer arranque del backend.
