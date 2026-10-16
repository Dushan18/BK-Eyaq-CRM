# CRM Inteligente EYAQ Systems — Backend

API backend para la gestión de usuarios, autenticación, sesiones, roles y configuración global del restaurante del CRM Inteligente de EYAQ Systems.

Actualmente el proyecto cubre el Sprint 1: usuarios, acceso y autorización basada en roles.

## Tecnologías

- NestJS
- TypeScript
- PostgreSQL
- Prisma ORM
- JWT y Passport
- bcrypt
- class-validator
- Resend
- Rate limiting con `@nestjs/throttler`
- Jest

## Funcionalidades

### Autenticación

- Inicio de sesión.
- Access tokens JWT.
- Refresh tokens con rotación.
- Refresh tokens almacenados mediante hash SHA-256.
- Sesiones persistidas en PostgreSQL.
- Revocación de sesiones y cierre de sesión.
- Invalidación de access tokens asociados a sesiones revocadas.
- Validación de usuarios activos.
- Recuperación de contraseña mediante enlaces de un solo uso.
- Tokens de recuperación aleatorios almacenados únicamente con SHA-256.
- Revocación de todas las sesiones después de cambiar la contraseña.

### Roles y autorización

Roles disponibles:

- `ADMIN`
- `OWNER`
- `OPERATOR`
- `SUPPORT`

La autorización se implementa mediante:

- `AccessTokenGuard`
- `RolesGuard`
- Decorador `@Roles(...)`
- Enum `RoleCode` generado por Prisma

### Gestión administrativa de usuarios

Los usuarios con rol `ADMIN` pueden:

- Crear usuarios.
- Listar y consultar usuarios.
- Editar información general.
- Activar o desactivar usuarios.
- Asignar o reemplazar roles.
- Revocar sesiones al desactivar un usuario.

La implementación también controla emails duplicados, evita exponer `passwordHash` y protege al último administrador activo.

### Configuración global del restaurante

- Configuración singleton garantizada por PostgreSQL.
- Datos generales, ubicación, moneda, zona horaria y políticas.
- Idiomas estructurados mediante `LanguageCode`.
- Horarios estructurados y ordenados de lunes a domingo.
- Responsable opcional relacionado con un usuario activo que tenga `OWNER`.
- Actualización atómica de configuración, idiomas y horarios.
- Lectura permitida a `ADMIN`, `OWNER` y `OPERATOR`.
- Modificación permitida únicamente a `ADMIN`.

## Requisitos

- Node.js
- npm
- PostgreSQL
- Cuenta y API key de Resend

## Configuración

Copia el archivo de ejemplo:

```bash
cp .env.example .env
```

En Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Variables necesarias:

```env
PORT=3000

DATABASE_URL="postgresql://usuario:password@localhost:5432/crm_eyaq"

JWT_SECRET="reemplazar-por-un-secreto-seguro"
JWT_EXPIRES_IN="15m"

JWT_REFRESH_SECRET="reemplazar-por-otro-secreto-seguro"
JWT_REFRESH_EXPIRES_IN="7d"

ADMIN_EMAIL="admin@eyaq.systems"
ADMIN_PASSWORD="reemplazar-por-una-password-segura"

PASSWORD_RESET_TOKEN_TTL_MINUTES=15
FRONTEND_RESET_PASSWORD_URL="http://localhost:5173/reset-password"

RESEND_API_KEY="re_reemplazar-por-api-key"
RESEND_FROM_EMAIL="EYAQ Systems <onboarding@resend.dev>"
```

Nunca subas el archivo `.env`, credenciales, tokens o cadenas de conexión reales al repositorio.

### Envío de correo con Resend

1. Crea una cuenta en [Resend](https://resend.com/).
2. Genera una API key en [API Keys](https://resend.com/api-keys).
3. Guarda la clave solamente en tu archivo `.env` local como `RESEND_API_KEY`.
4. Para las primeras pruebas utiliza `onboarding@resend.dev` como remitente y envía al correo asociado con tu cuenta de Resend.
5. Para enviar a usuarios reales, verifica tu dominio y cambia `RESEND_FROM_EMAIL`, por ejemplo:

```env
RESEND_FROM_EMAIL="EYAQ Systems <no-reply@tudominio.com>"
```

La aplicación no inicia si `RESEND_API_KEY` está ausente. Nunca publiques esta clave ni la incluyas en commits.

## Instalación

Instala las dependencias:

```bash
npm install
```

Genera Prisma Client:

```bash
npx prisma generate
```

Aplica las migraciones en desarrollo:

```bash
npx prisma migrate dev
```

Crea los roles y el administrador inicial:

```bash
npx prisma db seed
```

El seed utiliza operaciones idempotentes para evitar duplicar roles, usuarios o relaciones. Configura una contraseña administrativa segura antes de ejecutarlo.

## Ejecución

Desarrollo:

```bash
npm run start:dev
```

Build:

```bash
npm run build
```

La API utiliza por defecto:

```text
http://localhost:3000
```

## Endpoints

### Autenticación

| Método | Ruta                    | Descripción                              |
| ------ | ----------------------- | ---------------------------------------- |
| POST   | `/auth/login`           | Iniciar sesión                           |
| POST   | `/auth/refresh`         | Renovar tokens                           |
| GET    | `/auth/me`              | Obtener el usuario autenticado           |
| POST   | `/auth/logout`          | Revocar la sesión actual                 |
| POST   | `/auth/forgot-password` | Solicitar un enlace de recuperación      |
| POST   | `/auth/reset-password`  | Restablecer la contraseña con ese enlace |

### Usuarios

Todos los endpoints requieren un access token válido y el rol `ADMIN`.

| Método | Ruta                | Descripción                  |
| ------ | ------------------- | ---------------------------- |
| POST   | `/users`            | Crear usuario                |
| GET    | `/users`            | Listar usuarios              |
| GET    | `/users/:id`        | Consultar usuario            |
| PATCH  | `/users/:id`        | Editar información general   |
| PATCH  | `/users/:id/status` | Activar o desactivar usuario |
| PATCH  | `/users/:id/roles`  | Reemplazar roles             |

### Configuración del restaurante

| Método | Ruta                 | Roles permitidos             | Descripción                         |
| ------ | -------------------- | ---------------------------- | ----------------------------------- |
| GET    | `/restaurant-config` | `ADMIN`, `OWNER`, `OPERATOR` | Obtener la configuración global     |
| PUT    | `/restaurant-config` | `ADMIN`                      | Crear o reemplazar la configuración |

No existen rutas `POST`, `DELETE` ni rutas por identificador para este recurso. Si todavía no se creó la configuración, `GET /restaurant-config` responde `404 Not Found`.

### Estado de la aplicación

| Método | Ruta      | Autenticación | Descripción                                        |
| ------ | --------- | ------------- | -------------------------------------------------- |
| GET    | `/health` | Pública       | Comprueba que la API y PostgreSQL estén operativos |

El health check ejecuta un único `SELECT 1` mediante el `PrismaService` compartido. No consulta tablas de negocio, no escribe datos y no incluye Redis porque todavía no forma parte de la infraestructura activa.

## Ejemplo de autenticación

```http
POST /auth/login
Content-Type: application/json
```

```json
{
  "email": "admin@eyaq.systems",
  "password": "PASSWORD_CONFIGURADA"
}
```

Para consumir rutas protegidas:

```http
Authorization: Bearer ACCESS_TOKEN
```

## Ejemplo de creación de usuario

```http
POST /users
Authorization: Bearer ACCESS_TOKEN_ADMIN
Content-Type: application/json
```

```json
{
  "firstName": "Carlos",
  "lastName": "Quispe",
  "email": "carlos@restaurant.com",
  "password": "Password123!",
  "roles": ["OPERATOR"]
}
```

La respuesta no incluye la contraseña ni su hash.

## Configuración del restaurante

Antes de asignar un responsable, crea un usuario `OWNER` con un token de administrador:

```http
POST /users
Authorization: Bearer ACCESS_TOKEN_ADMIN
Content-Type: application/json
```

```json
{
  "firstName": "Olivia",
  "lastName": "Responsable",
  "email": "owner@eyaqsystems.com",
  "password": "Password123!",
  "roles": ["OWNER"]
}
```

Copia el `id` retornado y úsalo como `approvalResponsibleId`. Un usuario con solamente `ADMIN` no es un responsable válido; debe tener explícitamente `OWNER` y estar activo.

Para crear la configuración por primera vez o reemplazarla completamente:

```http
PUT /restaurant-config
Authorization: Bearer ACCESS_TOKEN_ADMIN
Content-Type: application/json
```

```json
{
  "businessName": "Sabor Mágico Grill Restaurante",
  "logoUrl": "https://example.com/logo.png",
  "description": "Restaurante de cocina peruana y parrillas.",
  "address": "Lima, Perú",
  "latitude": -12.046374,
  "longitude": -77.042793,
  "whatsappNumber": "+51999999999",
  "email": "contacto@sabormagico.com",
  "website": "https://sabormagico.com",
  "currency": "PEN",
  "timeZone": "America/Lima",
  "reservationPolicy": "Las reservas están sujetas a disponibilidad.",
  "cancellationPolicy": "Las cancelaciones deben solicitarse con anticipación.",
  "responseTimeoutMinutes": 15,
  "approvalResponsibleId": "UUID_REAL_DEL_OWNER",
  "languages": ["ES", "EN"],
  "schedules": [
    {
      "dayOfWeek": "MONDAY",
      "isOpen": true,
      "openTime": "11:00",
      "closeTime": "23:00"
    },
    {
      "dayOfWeek": "TUESDAY",
      "isOpen": true,
      "openTime": "11:00",
      "closeTime": "23:00"
    },
    {
      "dayOfWeek": "WEDNESDAY",
      "isOpen": true,
      "openTime": "11:00",
      "closeTime": "23:00"
    },
    {
      "dayOfWeek": "THURSDAY",
      "isOpen": true,
      "openTime": "11:00",
      "closeTime": "23:00"
    },
    {
      "dayOfWeek": "FRIDAY",
      "isOpen": true,
      "openTime": "11:00",
      "closeTime": "23:00"
    },
    {
      "dayOfWeek": "SATURDAY",
      "isOpen": true,
      "openTime": "11:00",
      "closeTime": "23:00"
    },
    {
      "dayOfWeek": "SUNDAY",
      "isOpen": false
    }
  ]
}
```

Reglas actuales:

- Deben enviarse exactamente los siete días, sin duplicados.
- Un día abierto requiere `openTime` y `closeTime` en formato `HH:mm`.
- Un día cerrado no admite horas.
- Esta versión no admite horarios que crucen la medianoche ni múltiples franjas en un mismo día.
- `latitude` y `longitude` deben enviarse juntas o quedar ambas en `null`.
- Los campos opcionales omitidos o enviados como `null` se limpian; `PUT` no conserva silenciosamente valores anteriores.
- `languages` y `schedules` reemplazan completamente sus valores anteriores.
- `approvalResponsibleId` puede ser `null`; cuando se envía un ID, debe pertenecer a un usuario activo con `OWNER`.

El segundo `PUT` actualiza la misma fila global. El `id` se conserva y PostgreSQL impide crear una segunda configuración.

### Pruebas rápidas en Postman

1. Ejecuta el `PUT` anterior con un token `ADMIN`: debe responder `200 OK`.
2. Ejecuta `GET /restaurant-config` con `ADMIN`, `OWNER` y `OPERATOR`: debe responder `200 OK`.
3. Ejecuta el mismo `GET` con `SUPPORT`: debe responder `403 Forbidden`.
4. Ejecuta cualquier ruta sin token: debe responder `401 Unauthorized`.
5. Ejecuta `PUT` con `OWNER`, `OPERATOR` o `SUPPORT`: debe responder `403 Forbidden`.
6. Ejecuta un segundo `PUT` con `languages: ["ES"]` y luego consulta: `EN` debe haber desaparecido.
7. Envía una moneda o idioma inexistente, días duplicados, menos de siete días, una hora como `25:00` o coordenadas incompletas: debe responder `400 Bad Request`.
8. Utiliza como responsable un ID inexistente, un usuario inactivo o un usuario sin `OWNER`: debe responder `400 Bad Request`.

La respuesta pública del responsable contiene solamente `id`, `firstName`, `lastName` y `email`; nunca incluye contraseña, sesiones ni tokens.

## Health check

Con el backend y PostgreSQL iniciados, realiza una petición sin token:

```http
GET http://localhost:3000/health
```

Respuesta esperada:

```http
200 OK
Cache-Control: no-store
```

```json
{
  "status": "ok",
  "services": {
    "api": "up",
    "database": "up"
  },
  "timestamp": "2026-09-03T05:00:00.000Z",
  "uptimeSeconds": 1234
}
```

Para comprobar el estado degradado en Windows:

1. Inicia primero PostgreSQL y `npm run start:dev`.
2. En otra consola de PowerShell ejecutada como administrador, identifica el nombre real del servicio:

   ```powershell
   Get-Service -Name '*postgres*'
   ```

3. Detén temporalmente únicamente ese servicio:

   ```powershell
   Stop-Service -Name 'NOMBRE_REAL_DEL_SERVICIO'
   ```

4. Sin cerrar NestJS, vuelve a llamar `GET /health`. Debe responder `503 Service Unavailable` con `database: "down"` y sin detalles internos.
5. Reactiva PostgreSQL:

   ```powershell
   Start-Service -Name 'NOMBRE_REAL_DEL_SERVICIO'
   ```

6. Repite la petición. Debe volver a responder `200 OK`.

La respuesta tiene un límite de espera de tres segundos. Este límite evita que la petición pública quede esperando, pero no cancela la consulta Prisma subyacente. Además, como `PrismaService` se conecta durante el arranque, si PostgreSQL ya está caído antes de iniciar NestJS, la API puede no llegar a escuchar conexiones; la prueba de `503` debe realizarse deteniendo PostgreSQL después de iniciar la aplicación.

## Recuperación de contraseña

Solicita el enlace sin autenticación:

```http
POST /auth/forgot-password
Content-Type: application/json
```

```json
{
  "email": "usuario@eyaq.systems"
}
```

La API devuelve siempre `200 OK` y el mismo mensaje, exista o no el usuario. El token crudo no aparece en la respuesta ni se almacena en PostgreSQL. El enlace llegará al correo mediante Resend; copia de allí el valor `token`.

Restablece la contraseña:

```http
POST /auth/reset-password
Content-Type: application/json
```

```json
{
  "token": "TOKEN_COPIADO_DEL_ENLACE",
  "newPassword": "NuevaPassword123!"
}
```

El enlace expira después de los minutos configurados, solamente puede utilizarse una vez y deja de ser válido si el usuario fue desactivado. Un cambio exitoso revoca todas las sesiones del usuario, por lo que deberá iniciar sesión nuevamente.

## Seguridad

- Las contraseñas se almacenan con bcrypt y nunca en texto plano.
- Los refresh tokens se almacenan mediante SHA-256 y son de un solo uso.
- Los tokens de recuperación tienen 256 bits aleatorios; solamente se almacena su SHA-256.
- Solicitar un enlace nuevo invalida los enlaces de recuperación anteriores.
- El consumo del token, el cambio de contraseña y la revocación de sesiones son atómicos.
- Los endpoints de recuperación tienen rate limiting por dirección IP.
- Las sesiones pueden revocarse.
- Los roles actuales se verifican desde PostgreSQL.
- Los DTO rechazan propiedades no declaradas.
- La configuración global usa un enum de alcance con un solo valor y una restricción `UNIQUE` en PostgreSQL.
- La base de datos valida rangos/coherencia de coordenadas, tiempo de respuesta y horarios.
- La actualización de configuración, idiomas y horarios utiliza una transacción `Serializable` con reintentos acotados.
- El health check público no expone errores, credenciales ni datos de conexión.
- `passwordHash` nunca se incluye en respuestas administrativas.
- La autorización se aplica en el backend y no depende del frontend.
- No es posible desactivar o retirar el rol al último administrador activo.
- La desactivación de un usuario revoca sus sesiones activas.

## Pruebas

Ejecuta toda la suite:

```bash
npm test -- --runInBand
```

Ejecuta la suite e2e:

```bash
npm run test:e2e -- --runInBand
```

Estado actual:

```text
30 suites y 334 pruebas unitarias aprobadas
E2E estándar: 2 pruebas; integraciones opt-in: 25 de clientes y 62 de reservas/calendario
```

## Estructura principal

```text
prisma/
├── migrations/
├── schema.prisma
└── seed.ts

src/
├── auth/
├── commercial/
├── common/
├── config/
├── customers/
├── database/
├── dto/
├── health/
├── reservation-requests/
├── reservations/
├── restaurant-config/
├── roles/
├── strategies/
├── users/
├── app.module.ts
└── main.ts
```

## Estado del proyecto

Sprint 1:

- [x] Autenticación
- [x] Refresh tokens
- [x] Sesiones
- [x] Logout
- [x] Roles y autorización
- [x] Gestión administrativa de usuarios
- [x] Recuperación segura de contraseña
- [x] Configuración global del restaurante
- [x] Horarios e idiomas estructurados
- [x] Health check de API y PostgreSQL
- [ ] Auditoría administrativa
- [ ] Paginación y filtros de usuarios

Pendientes relacionados con la configuración:

- Integrar los eventos `RESTAURANT_CONFIG_CREATED` y `RESTAURANT_CONFIG_UPDATED` cuando exista infraestructura de auditoría.
- Incorporar un teléfono personal en `User` cuando se implemente la validación del propietario por WhatsApp; no se duplicó en `RestaurantConfig`.
- Definir la política para impedir que el responsable configurado sea desactivado o pierda posteriormente el rol `OWNER`.

## Antes de publicar o desplegar

- Verifica que `.env` esté ignorado por Git.
- Usa secretos diferentes para access y refresh tokens.
- Configura `ADMIN_PASSWORD` antes de ejecutar el seed.
- Verifica tu dominio en Resend y configura una URL HTTPS del frontend en producción.
- Elimina endpoints temporales de prueba.
- No expongas secretos, hashes ni credenciales mediante endpoints o logs.

## Clientes e intereses comerciales — Sprint 2

El módulo `/customers` permite registrar clientes, buscar y paginar, editar datos, cambiar estados y gestionar intereses vinculados al catálogo comercial. ADMIN y OPERATOR pueden escribir; OWNER solo consultar; SUPPORT no tiene acceso.

Incluye normalización de teléfonos y correos, prevención de duplicados y protección frente a solicitudes simultáneas. No implementa conversaciones ni reservas.

Consulta la [guía de Postman y pruebas de clientes](docs/customers-postman.md) para conocer los cuerpos reales, permisos y casos de prueba.

## Solicitudes, reservas y calendario inicial — Sprint 2

`/reservation-requests` registra intenciones de reserva: el backend calcula INCOMPLETE_DATA o READY_TO_SEND y permite cancelar. `/reservations` registra reservas operativas; su creación manual está limitada a ADMIN y no aprueba solicitudes. OWNER consulta; ADMIN/OPERATOR gestionan solicitudes y actualizan reservas. SUPPORT no tiene acceso.

El calendario consume exclusivamente `GET /reservations` con rangos de fecha, paginación y orden cronológico. Las fechas exigen zona explícita; los códigos se generan mediante secuencias PostgreSQL y restricciones únicas. No se implementan todavía disponibilidad de mesas, frontend, aprobación del propietario ni WhatsApp.

La migración `20260916055653_add_reservation_requests_and_reservations` agrega tablas, secuencias, índices y restricciones sin eliminar datos existentes. La configuración global del restaurante debe existir antes de crear solicitudes o reservas.

Consulta la [guía completa de Postman y pruebas de reservas](docs/reservations-postman.md).

La ampliación operativa incorpora responsable, observaciones con autor e historial de reprogramación. Conserva `notes` como texto y agrega `noteHistory`/`rescheduleHistory` al detalle. Nuevas acciones: `/reservations/:id/assignee`, `/notes` y `/reschedule`. El listado añade búsqueda, filtros por responsable/elemento comercial y exclusión opcional de canceladas.

La migración `20260922052135_extend_reservation_calendar` es aditiva. Cambiar realmente la fecha (también mediante el PATCH anterior) ahora registra historial y establece RESCHEDULED. UPCOMING se habilita como estado manual. Consulta las reglas y ejemplos en la [guía operativa del calendario](docs/reservation-calendar-postman.md).

## Cierre técnico del Sprint 2

El [informe de cierre](docs/sprint-2-closure.md) registra el diagnóstico, correcciones de validación del catálogo, matriz de 31 endpoints/RBAC, checklist de requisitos y deuda pendiente. Validación automatizada: 339 pruebas unitarias y 139 de integración, con ambas suites de PostgreSQL habilitadas. Esto no sustituye la aprobación funcional.

La [guía de demo en Postman](docs/sprint-2-demo.md) organiza las evidencias y usa reservas independientes para completar, reprogramar y cancelar. No se añadieron funcionalidades de Sprint 3 ni migraciones en el cierre.

## Mensajería central — Sprint 3, Fase 1

El núcleo añade `/conversations`, historial paginado, lectura compartida, pausa del asistente y asignación humana. La ingestión es interna y reutiliza CustomersService; PostgreSQL conserva mensajes y un outbox transaccional. BullMQ procesa con IDs determinísticos, leases y reintentos acotados. No se conecta WhatsApp ni IA todavía.

La migración aditiva `20260923060201_add_messaging_core` agrega Conversation, Message, MessageAttachment y MessagingOutbox. `MESSAGING_ENABLED=false` mantiene apagados los workers hasta configurar `REDIS_URL`; no significa que el procesamiento en background haya sido probado.

Consulta la [guía de mensajería/Postman y demo local](docs/messaging-postman.md) y el [diseño aprobado](docs/messaging-core-design.md). Al 13/10/2026, las colas INBOUND/OUTBOUND y la recuperación tras caída abrupta/reinicio de Redis aislado pasan pruebas con Meta simulado. Consulta el [alcance y pendientes de cierre](docs/sprint-3-progress.md).

## WhatsApp Cloud API — Fase 2

La integración añade `GET/POST /webhooks/whatsapp` con firma HMAC sobre raw body y
`POST /conversations/:id/messages` para ADMIN/OPERATOR, con `Idempotency-Key` obligatorio
y respuesta 202. Reutiliza clientes, conversaciones, mensajes y outbox; incorpora la
cola saliente, metadatos de media y estados SENT/DELIVERED/READ/FAILED/UNKNOWN.

`WHATSAPP_ENABLED=false` mantiene la integración apagada. Activarla exige credenciales
de Meta, Redis y mensajería habilitada. No incluye IA ni plantillas. Los envíos con
resultado incierto no se reintentan automáticamente para evitar duplicados.

Consulta la [guía de configuración, Postman y prueba real](docs/whatsapp-postman.md).
La implementación tiene pruebas automatizadas con Meta simulado y evidencia manual
de recepción PROCESSED y envío DELIVERED usando el número de prueba de Meta.
Validación del 13/10/2026: build, 418 pruebas unitarias y 183 de integración aprobadas,
incluidas ambas colas con Redis real. El [cierre operativo](docs/sprint-3-progress.md)
conserva pendientes; no equivale a producción ni al número real del restaurante.
La fase añadió dos migraciones aditivas, sin reiniciar ni eliminar datos existentes.

## Redis local con Docker

El archivo `compose.yaml` levanta únicamente Redis para las colas de mensajería, con persistencia y puerto limitado a localhost. NestJS sigue ejecutándose con `npm run start:dev`. Consulta la [guía de instalación y verificación en Windows](docs/redis-docker.md).

## Licencia

Software propietario de EYAQ Systems.

No se permite su distribución, modificación o utilización sin autorización expresa.
