# Despliegue V1 en un VPS con Dokploy

Guía para publicar el CRM (bk-crm + ft-crm) en el VPS de Hostinger administrado con Dokploy. Dokploy
construye cada repositorio con su `Dockerfile` y Traefik pone el HTTPS (Let's Encrypt).

```text
Internet ──HTTPS──► Traefik ─┬─► panel.perucheck.cloud            ──► ft-crm :5173 ──(red interna)──► bk-crm :3000
                             └─► api.perucheck.cloud/webhooks/*   ──► bk-crm :3000   (solo Meta)
                                                                       bk-crm ──► PostgreSQL 18, Redis 7 (red interna)
```

El navegador nunca llama al backend: el frontend (BFF) lo hace por la red interna. Desde Internet, el
backend solo expone los webhooks de Meta.

## 0. Antes de empezar

- **DNS** (en el panel del dominio `perucheck.cloud`): registros `A` de `panel` y `api` hacia la IP del
  VPS. Comprueba con `nslookup panel.perucheck.cloud` antes de pedir los certificados.
- **Código:** commit y push de bk-crm y ft-crm a la rama que vas a desplegar (incluye los cambios de M9,
  del envío temporal por texto y de las respuestas cortas, y los archivos Docker de esta guía).
- **GitHub en Dokploy:** *Settings → Git → GitHub*, con acceso a `BK-Eyaq-CRM` y `FT-Eyaq-CRM`.
- **Un solo entorno con las credenciales reales.** El backend local y el de producción no pueden estar
  encendidos a la vez con el mismo `.env`: los dos leerían el mismo buzón IMAP (cada reserva web
  entraría dos veces) y enviarían por el mismo número de WhatsApp. Cuando producción esté activa,
  detén el backend local o apágale `EMAIL_ENABLED`, `OWNER_APPROVAL_ENABLED` y `SAMANTA_AUTO_SEND`.

## 1. Proyecto, PostgreSQL y Redis

1. *Create Project*, por ejemplo `crm-sabor-magico`.
2. *Create Service → Database → PostgreSQL*, imagen `postgres:18`, base `bd_crm`, usuario `crm` y una
   contraseña generada. Sin dominio ni puerto público. Copia la **Internal Connection URL** y agrégale
   `?schema=public`: es el `DATABASE_URL` del backend.
3. *Create Service → Database → Redis*, imagen `redis:7.4`. En *Advanced → Command*:
   `redis-server --appendonly yes --maxmemory-policy noeviction` (la cola de envíos sobrevive a un
   reinicio y BullMQ nunca pierde trabajos por falta de memoria). Sin puerto público. Copia la
   **Internal Connection URL**: es el `REDIS_URL`.
4. **Respaldos:** en el PostgreSQL, *Backups* → uno diario a un destino S3 (*Settings → S3 Destinations*).

## 2. Backend (bk-crm)

1. *Create Service → Application* `bk-crm`. *Provider*: GitHub, repositorio `BK-Eyaq-CRM`, la rama.
   *Build Type*: **Dockerfile** (`Dockerfile`, contexto `.`).
2. *Environment*: copia `.env.example` del repositorio y completa los valores (sección 4).
3. *Domains*: host `api.perucheck.cloud`, **path `/webhooks`**, puerto `3000`, HTTPS con Let's Encrypt.
   Con el path, solo los webhooks quedan públicos; el resto del API solo se alcanza por la red interna.
4. *Advanced → Replicas*: **1**. La lectura del correo, el envío al propietario, Samanta automática y
   las fotos de perfil corren con temporizadores dentro del proceso (protegidos con bloqueos, pero una
   réplica es lo previsto para la V1).
5. *Deploy*. En los logs deben aparecer `22 migrations found`, las migraciones aplicadas (o `No pending
   migrations`) y `Nest application successfully started`. El contenedor aplica las migraciones
   pendientes cada vez que arranca (`RUN_MIGRATIONS=false` lo desactiva) y su healthcheck usa `/health`.
6. **Solo la primera vez**, desde la terminal del contenedor del backend en Dokploy:

   ```sh
   node dist/prisma/seed.js
   ```

   Crea los roles, el administrador (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) y el catálogo comercial
   (16 categorías y 86 elementos). Luego entra al CRM, cambia esa contraseña y completa
   *Ajustes → Empresa*: nombre, zona horaria, horarios, el **WhatsApp personal del propietario** y el
   **responsable de aprobaciones** (un usuario OWNER que crees en *Ajustes → Usuarios*). Sin esa
   configuración, las reservas de la web quedan en espera (`EMAIL_IMPORT_DEFERRED`) y no se envía nada al
   propietario (`OWNER_APPROVAL_NOT_CONFIGURED`). Aprueba en el catálogo los elementos que Samanta pueda
   ofrecer.

## 3. Frontend (ft-crm)

1. *Create Service → Application* `ft-crm`, repositorio `FT-Eyaq-CRM`, *Build Type*: **Dockerfile**.
   La imagen usa la salida `standalone` de Next.js (`node server.js`, usuario sin privilegios).
2. *Environment* (ver `.env.example` de ft-crm):

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

   Opcional, en *Build Args* (se fijan al construir): `NEXT_PUBLIC_INBOX_POLL_MS`, `NEXT_PUBLIC_CHAT_POLL_MS`.
3. *Domains*: host `panel.perucheck.cloud`, puerto `5173`, HTTPS con Let's Encrypt.
4. *Deploy* y entra a `https://panel.perucheck.cloud`. `/api/salud` dice si el proceso vive y
   `/api/listo`, si llega al backend.

## 4. Variables del backend

La plantilla completa, con comentarios, está en `.env.example`. Los valores entre `<>` son tuyos; los
secretos no se comparten ni se suben a git.

- **Secretos JWT:** `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
  dos veces (deben ser distintos). Con `NODE_ENV=production` (lo fija la imagen), el backend no arranca
  si son cortos o de ejemplo, si `FRONTEND_RESET_PASSWORD_URL` no es https pública o si
  `RESEND_FROM_EMAIL` usa `resend.dev`.
- **URLs:** `FRONTEND_RESET_PASSWORD_URL=https://panel.perucheck.cloud/reset-password`,
  `TRUST_PROXY=1`.
- **Meta:** tokens permanentes de un usuario del sistema (Business Manager), no los temporales.
- **Valores recomendados para el primer despliegue:**

  | Variable | Valor inicial | Cuándo cambiarlo |
  |---|---|---|
  | `SAMANTA_AUTO_SEND` | `false` (modo sombra) | `true` cuando las pruebas reales salgan bien: con `true`, Samanta responde sola a **todos** los clientes |
  | `OWNER_APPROVAL_ENABLED` | `true` | — |
  | `OWNER_APPROVAL_TEXT_FALLBACK_ENABLED` | `true` (temporal) | `false` cuando Meta apruebe `aprobacion_reserva_propietario` |
  | `OWNER_APPROVAL_MAX_AGE_HOURS` | `24` | — |
  | `CUSTOMER_DECISION_TEMPLATES_ENABLED` | `false` | `true` con `reserva_aprobada`, `reserva_no_aprobada` y `reserva_cambio_propuesto` aprobadas |
  | `WEB_RESERVATION_WHATSAPP` | `false` | `true` con `solicitud_reserva_web` aprobada |

## 5. HTTPS y webhooks de Meta

1. **HTTPS:** Dokploy pide los certificados de Let's Encrypt al guardar cada dominio con HTTPS; el DNS
   debe apuntar ya al VPS. Comprueba `https://api.perucheck.cloud/webhooks/whatsapp` (responde 403 sin
   los parámetros de verificación: es lo esperado).
2. **Verificación** (debe responder `123`):
   `https://api.perucheck.cloud/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=123`
   (igual con `/webhooks/messenger` e `/webhooks/instagram` y su token).
3. **URLs de callback** en la app de Meta, con el token de verificación de cada canal:
   - WhatsApp (*WhatsApp → Configuración*): `https://api.perucheck.cloud/webhooks/whatsapp`, campo `messages`.
   - Messenger: `https://api.perucheck.cloud/webhooks/messenger`, con la página suscrita a la app.
   - Instagram: `https://api.perucheck.cloud/webhooks/instagram`.
   Todas las peticiones de Meta se validan con la firma `X-Hub-Signature-256` (`META_APP_SECRET`).
4. **Al cambiar la URL a producción, el backend local deja de recibir mensajes** (Meta solo tiene una
   URL por app). Si los webhooks verifican pero no llega nada, revisa las suscripciones de la app.
5. **App en modo «En vivo».** Instagram: acceso avanzado a `instagram_business_manage_messages`.
   WhatsApp: método de pago, verificación del negocio y las plantillas aprobadas.

## 6. Correo de reservas

- El VPS se conecta por IMAP al cPanel del restaurante. Si la contraseña falla varias veces, cPanel
  bloquea la IP del VPS: revisa el log después del primer despliegue (`EMAIL_AUTH_FAILED`).
- La importación tolera reintentos (cada correo se identifica por buzón, UIDVALIDITY y UID), pero solo
  un entorno debe leer el buzón (sección 0).

## 7. Envíos sin duplicados

- Cada mensaje entrante o saliente es un trabajo BullMQ con `jobId` propio (`inbound-<id>` /
  `outbound-<id>`), y en PostgreSQL se reserva con un token antes de procesarlo.
- Un envío con resultado incierto (timeout de Meta) queda `UNKNOWN` y **nunca se reenvía**.
- Las solicitudes al propietario, los avisos al cliente y las respuestas de Samanta tienen claves de
  idempotencia únicas en la base. Por eso un reinicio o un webhook repetido no duplican envíos.
- Redis con `noeviction` y AOF (sección 1) para no perder trabajos.

## 8. Actualizar

- Cada push a la rama vuelve a desplegar si activas *Auto Deploy* en cada aplicación. Si no, usa
  *Deploy*.
- Las migraciones se aplican solas al arrancar. **Antes de desplegar una versión con migraciones nuevas,
  haz un respaldo manual** (*PostgreSQL → Backups → Run manual backup*).
- **Volver atrás:** *Deployments → Rollback* a la imagen anterior. Si la versión nueva traía
  migraciones, restaura también el respaldo.

## 9. Comprobar

- `https://panel.perucheck.cloud`: el inicio de sesión funciona.
- Verificación de Meta (sección 5) en los tres canales.
- Un mensaje de prueba por WhatsApp, Messenger e Instagram; en modo sombra, el borrador de Samanta
  aparece en la Bandeja.
- Aprobación del propietario (modo temporal): el propietario escribe «Hola» al número del negocio, se
  crea una solicitud de prueba, le llega el texto y responde con «Responder» + `ACEPTO`.
- En el log del backend: `OWNER_APPROVAL_MODE` con `TEXT_FALLBACK`, `EMAIL_WEB_RESERVATION` cuando llegue
  una reserva, y ningún `EMAIL_AUTH_FAILED`.

## Los datos de tu base local

Producción empieza vacía: el seed crea lo necesario y los clientes y conversaciones de prueba se quedan
en local. Si aun así quieres llevarlos, restaura un respaldo de `bd_crm` con `pg_restore` en la base
nueva **antes** del primer arranque del backend (y no ejecutes el seed). Los clientes de Messenger e
Instagram están ligados a la página y la cuenta configuradas, que son las mismas.
