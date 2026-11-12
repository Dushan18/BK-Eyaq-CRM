# API de bk-crm para el frontend

> **Estado:** 3 de noviembre de 2026.
> - bk-crm: rama `main`, commit `9538556` («Messenger»), más los cambios del 3/11 que aún no tienen commit (ver [Cambios recientes del backend](#cambios-recientes-del-backend-3112026)). El modo automático de Samanta (8/11) está en [Cambios del backend del 8/11/2026](#cambios-del-backend-del-8112026-samanta-automática), y las reservas de la web por correo (9/11), en [Cambios del backend del 9/11/2026](#cambios-del-backend-del-9112026-reservas-de-la-web-y-plantillas-de-whatsapp). La conversación vinculada y el historial de estados de las solicitudes (10/11) están en [Cambios del backend del 10/11/2026](#cambios-del-backend-del-10112026-conversación-e-historial-de-las-solicitudes), y las solicitudes que registra Samanta (M8.2), en [Cambios del backend del 10/11/2026 (M8.2)](#cambios-del-backend-del-10112026-m82-samanta-registra-solicitudes). La aprobación manual de solicitudes está en [Cambios del backend del 10/11/2026: aprobación manual](#cambios-del-backend-del-10112026-aprobación-manual-de-solicitudes), el envío al WhatsApp del propietario (M9.1), en [Cambios del backend del 10/11/2026 (M9.1)](#cambios-del-backend-del-10112026-m91-envío-de-solicitudes-al-whatsapp-del-propietario), sus respuestas (M9.2), en [Cambios del backend del 10/11/2026 (M9.2)](#cambios-del-backend-del-10112026-m92-respuestas-del-propietario-por-whatsapp), y el aviso al cliente de la decisión (M9.3), en [Cambios del backend del 10/11/2026 (M9.3)](#cambios-del-backend-del-10112026-m93-aviso-al-cliente-de-la-decisión-del-propietario). El envío por Instagram, que bk-crm tiene desde el 4/11 (commit `eca059b`), se corrigió en esta carpeta el 8/11: ver [Correcciones respecto de la versión anterior](#correcciones-respecto-de-la-versión-anterior).
> - ft-crm: rama `main`, commit `aaeb85e`, más los ajustes del BFF que aún no tienen commit (ver [Ya ajustado en ft-crm](#ya-ajustado-en-ft-crm-pendiente-de-commit)).
>
> Esta referencia se generó a partir del código fuente del backend y se verificó ruta por ruta contra ese código: roles, validaciones, mensajes de error y forma de las respuestas. Lo que dice de ft-crm se verificó contra su código actual. El plan para pasar ft-crm a modo live está en [05-implementacion-ft-crm.md](05-implementacion-ft-crm.md).
>
> Reemplaza los contratos de `ft-crm/docs/backend/` (14/10/2026). Si hay diferencias entre ambos, prevalece esta carpeta. Si esta carpeta no coincide con el backend en ejecución, avisa al equipo de backend.
>
> Si ya empezaste a implementar con la versión anterior de esta carpeta, revisa primero [Correcciones respecto de la versión anterior](#correcciones-respecto-de-la-versión-anterior).

## Contenido

| Archivo | Qué cubre |
|---|---|
| [README.md](README.md) | Prompt para el asistente de IA, arquitectura (navegador → BFF → bk-crm), convenciones, mapa de rutas con la función de ft-crm, flujos, diferencias con ft-crm, cambios recientes, correcciones respecto de la versión anterior y preguntas abiertas de todos los módulos |
| [01-auth-usuarios.md](01-auth-usuarios.md) | Login, refresh, logout, `/auth/me`, recuperación de contraseña, salud del servicio y usuarios |
| [02-configuracion-catalogo.md](02-configuracion-catalogo.md) | Configuración del restaurante, categorías y elementos comerciales |
| [03-clientes-reservas.md](03-clientes-reservas.md) | Clientes e intereses, solicitudes de reserva y reservas (calendario) |
| [04-bandeja-samanta.md](04-bandeja-samanta.md) | Conversaciones y mensajes de WhatsApp, Messenger e Instagram, borradores de Samanta y webhooks de Meta |
| [05-implementacion-ft-crm.md](05-implementacion-ft-crm.md) | Plan para pasar ft-crm a modo live: orden de trabajo, `endpoints.ts`, `types.ts` y `query-keys.ts` propuestos, guía por pantalla, manejo de errores, reglas transversales, diferencias del mock y cómo probar contra el backend real |

Cada ruta de los módulos 01 a 04 documenta:
- roles y código de éxito;
- la fila **ft-crm**: la función de `src/lib/api/endpoints.ts` con su firma, y si existe, es nueva o la resuelve el BFF;
- la fila **Caché**: la clave de `qk` y qué invalidar tras un cambio;
- cabeceras, body y query, con un ejemplo de petición cuando la ruta los tiene;
- un ejemplo de respuesta;
- la tabla de errores con el mensaje exacto;
- efectos y notas de uso.

Al final de cada archivo de módulo están sus modelos, sus estados y transiciones, sus preguntas abiertas y sus tipos TypeScript.

## Prompt para el asistente de IA del frontend

Copia esta carpeta (`bk-crm/docs/frontend-api/`) en `ft-crm/docs/frontend-api/` y pega este texto al asistente:

```text
Eres el asistente del equipo de frontend de ft-crm (Next.js con App Router, React Query y zod). Vamos a conectar la app al backend real bk-crm (CRM_BACKEND_MODE=live).

Fuente de verdad: la carpeta docs/frontend-api/.
- Antes de cambiar código, lee completos docs/frontend-api/README.md y docs/frontend-api/05-implementacion-ft-crm.md. El 05 es el plan de trabajo: orden de los pasos, código propuesto para src/lib/api/ (endpoints.ts, types.ts, query-keys.ts y el nuevo errors.ts), guía por pantalla, manejo de errores y diferencias del mock.
- En cada tarea, lee también el archivo del módulo que corresponda: 01-auth-usuarios.md, 02-configuracion-catalogo.md, 03-clientes-reservas.md o 04-bandeja-samanta.md.
- Cada ruta de los módulos tiene una fila "ft-crm" (función de endpoints.ts, su firma y si existe, es nueva o la resuelve el BFF) y una fila "Caché" (clave de qk y qué invalidar). Usa exactamente esas funciones y claves; si una función es nueva, cópiala de la sección 2 del 05.
- Esta carpeta reemplaza docs/backend/*.md. Si se contradicen, sigue docs/frontend-api/.

Reglas:
1. No inventes endpoints, campos, parámetros de query ni valores de enum. Si algo no está en la referencia, dilo y redacta la pregunta para el equipo de backend; no lo supongas.
2. El navegador nunca llama directo a bk-crm. Las rutas de la API se piden con apiFetch a /api/backend/<ruta> (src/lib/api/client.ts → src/app/api/backend/[...path]/route.ts). Login, logout y recuperación de contraseña van por /api/auth/*, y el refresh lo hace el BFF. No toques cookies ni tokens salvo que te lo pida.
3. bk-crm responde 400 ante cualquier campo de body o parámetro de query no declarado. Envía solo los campos documentados, omite los opcionales vacíos (no los mandes como "") y nunca envíes campos de solo lectura (id, createdAt, updatedAt ni objetos anidados de la respuesta). En un PATCH, omitir un campo lo conserva y null lo borra, pero solo si el campo admite null: cada módulo dice cuáles no (p. ej. PATCH /users/:id responde 400 a cualquier null).
4. Errores: message es string[] en la validación y string en los demás casos (apiFetch ya lo normaliza en ApiError.messages). Muestra tal cual los mensajes de negocio, que vienen en español. Los de validación vienen en inglés, salvo los de validadores propios de bk-crm, que vienen en español: conviértelos en errores de campo con fieldErrors (05, sección 4). Un 503 sin code es una función apagada en el servidor, no una falta de conexión.
5. Fechas: la API devuelve ISO 8601 en UTC. Muéstralas en el timeZone de GET /restaurant-config, no en la zona del navegador. Para enviarlas usa ISO con segundos y zona; toISOString() sirve.
6. Importes: son strings con 2 decimales ("38.50"). No los conviertas a number para enviarlos.
7. Enviar mensajes y generar borradores de Samanta exige la cabecera Idempotency-Key (16 a 80 caracteres [A-Za-z0-9_-]). Genera una por cada acción del usuario y reutilízala solo para reintentar esa misma acción. No uses el prefijo "samanta-". Los demás POST no llevan clave: tras un 504, refresca antes de reintentar (la tabla de reintentos por ruta está en el 05, sección 5).
8. No hay WebSockets ni SSE: usa polling con React Query, como ya hace la Bandeja.
9. Roles: ADMIN, OWNER, OPERATOR y SUPPORT (lista fija; un usuario puede tener varios). Léelos de GET /auth/me y respeta la matriz de permisos del README y la tabla de permisos de cada pantalla del 05, incluidas las reglas de OPERATOR sobre asignaciones.
10. Mantén el modo mock funcionando. Si cambias un contrato en src/lib/api/, actualiza también src/lib/mock/ para que se comporte como el backend real (lista de diferencias en el 05, sección 6).

Prioridades: sigue el "Orden de trabajo recomendado" del 05 (sección 1). Si hay que recortar:
1. Capa de API y manejo de errores (05, secciones 2 y 4).
2. Messenger (canal FACEBOOK) e Instagram (canal INSTAGRAM) en la Bandeja: envío, límites (2000 caracteres en Messenger; 1000 caracteres y 1000 bytes UTF-8 en Instagram), ventana de 24 h y códigos MESSENGER_* e INSTAGRAM_*.
3. Samanta con borradores (/conversations/:id/assistant-drafts): generar, consultar, editar, aprobar y rechazar. Deja de suponer que un OUTBOUND sin autor es de Samanta.
4. Clientes sin nombre (WhatsApp, y Messenger o Instagram cuando Meta no da el nombre) y sin teléfono (Messenger e Instagram): textos de respaldo en todas las vistas.
5. Solicitudes y reservas: el flujo del dueño aún no existe en el backend. Oculta lo que depende de él o márcalo como "próximamente", y añade las altas y ediciones que faltan.

En cada cambio:
- explica qué archivos tocas;
- actualiza tipos, endpoints y query keys (src/lib/api/);
- ejecuta npm run typecheck y npm test, y añade o ajusta las pruebas si existen.
```

## Arquitectura: navegador → BFF → bk-crm

```text
Navegador ── /api/backend/<ruta> ──▶ BFF Next.js (ft-crm, :5173) ── <ruta> + Bearer ──▶ bk-crm (:3000)
Navegador ── /api/auth/*         ──▶ BFF (login, logout, recuperación de contraseña)
```

### Cómo se llama a una ruta

- El navegador nunca llama a bk-crm ni ve los tokens. Para usar una ruta de esta referencia, pide `/api/backend` + la ruta con `apiFetch` (`src/lib/api/client.ts`). Ejemplo: `GET /conversations?limit=50` se pide como `/api/backend/conversations?limit=50`.
- El BFF (`src/app/api/backend/[...path]/route.ts`) reenvía la petición a `CRM_BACKEND_URL` (por defecto `http://localhost:3000`) y añade `Authorization: Bearer` con la cookie httpOnly `crm_at`.
- Solo reenvía las cabeceras `content-type`, `idempotency-key` y `accept-language`. Si una ruta necesita otra cabecera, hay que añadirla al BFF.
- El BFF responde 404 `Ruta no disponible.` a estas rutas:
  - `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`;
  - `/auth/test-admin`;
  - `/webhooks/*`.

  Login, logout y recuperación de contraseña tienen sus propios handlers en `/api/auth/*`, y el refresh lo hace el BFF.
- Query string: el helper `toSearch` omite `undefined`, `null` y los textos vacíos o de solo espacios, y envía los booleanos como `'true'`/`'false'`. Úsalo siempre: bk-crm responde 400 a parámetros vacíos o no declarados.
- Modo (`CRM_BACKEND_MODE`): con `live` (por defecto) se llama a bk-crm; con `mock` se usa `src/lib/mock/server.ts` con el mismo contrato. En modo live, `/api/listo` consulta `GET /health`.
- En bk-crm, `FRONTEND_RESET_PASSWORD_URL` debe apuntar a `<origen del frontend>/reset-password`. Esa página lee `?token=`. En producción tiene que ser una URL `https` pública: si no, bk-crm no arranca.

### Sesión (`src/lib/server/session.ts`)

- Si `crm_at` falta o vence en 30 s o menos, el BFF renueva la sesión antes de llamar.
- Si bk-crm responde 401, el BFF renueva una vez y repite la llamada.
- El BFF responde 401 con `code: 'SESSION_EXPIRED'` y borra las cookies cuando no puede renovar (falta la cookie `crm_rt` o el refresh responde 400/401) o cuando bk-crm sigue respondiendo 401 con un token recién renovado.
- Si no hay cookies, responde 401 con `code: 'NO_SESSION'`.
- Ante cualquier 401, el cliente emite `crm:session-expired` y redirige a `/login?motivo=sesion&next=…`.
- Cualquier otro fallo del refresh responde 503 `BACKEND_UNAVAILABLE` y no cierra la sesión.
- La deduplicación de refresh vive en la memoria del proceso. En producción hace falta una sola instancia del frontend o sesiones *sticky*.

### Errores que añade el BFF

| Caso | Respuesta del BFF |
|---|---|
| bk-crm no responde a tiempo (`CRM_BACKEND_TIMEOUT_MS`, 15 000 ms por defecto; 65 000 ms al generar un borrador de Samanta) | 504 `{ statusCode, message, code: 'BACKEND_UNAVAILABLE' }` |
| Error de red hacia bk-crm | 503 `{ statusCode, message, code: 'BACKEND_UNAVAILABLE' }` |
| Sesión inexistente o vencida | 401 `{ code: 'NO_SESSION' }` o `{ code: 'SESSION_EXPIRED' }` |

El campo `code` lo pone el BFF; bk-crm nunca lo envía. `apiFetch` lanza `ApiError(status, messages[], code, body)`, donde `messages` ya es siempre un array.

### Consecuencias para el despliegue

- **CORS no aplica.** El navegador solo habla con el BFF. bk-crm no tiene CORS habilitado y no lo necesita mientras se use el BFF.
- **Límites de intentos por cuenta.** bk-crm cuenta los intentos de login y recuperación de contraseña por IP y por cuenta (email o enlace). Aunque todas las peticiones lleguen con la IP del BFF, un usuario no agota el cupo de los demás. `TRUST_PROXY` (`src/main.ts`) hace que bk-crm tome la IP de `X-Forwarded-For` cuando delante hay un proxy inverso de confianza, pero con el BFF esa IP sigue siendo la del servidor de Next.js: sus handlers de `/api/auth/*` no reenvían la IP del navegador. En la práctica, el límite es por cuenta.
- **Timeout de Samanta.** Generar un borrador espera a la IA hasta `SAMANTA_TIMEOUT_MS`: 20 s por defecto y 60 s como máximo. Por eso el BFF usa para esa ruta un techo de al menos 65 s (`src/lib/server/backend.ts`); el resto sigue con `CRM_BACKEND_TIMEOUT_MS`. Ante un 504, repite el POST con la misma `Idempotency-Key`: así se recupera el borrador sin generar otro.

## Convenciones generales

Reglas comunes a todas las rutas del backend, tomadas de `src/main.ts`, `src/common/filters/global-exception.filter.ts` y los guards de `src/auth`.

### URL base y rutas

- Desde el navegador no se usa esta URL: todo pasa por el BFF (`/api/backend/<ruta>`; ver [Arquitectura](#arquitectura-navegador--bff--bk-crm)).
- URL base en desarrollo: `http://localhost:3000`. El puerto sale de la variable `PORT` y, si no está definida, es `3000`. URL de los demás entornos: (por confirmar).
- No hay prefijo global (`/api`, `/v1`) ni versionado. Las rutas cuelgan de la raíz, p. ej. `POST http://localhost:3000/auth/login`.
- Una ruta inexistente responde 404 con `"message": "Cannot GET /ruta-inexistente"`.
- Los IDs son UUID en texto. Los parámetros `:id` se validan con `ParseUUIDPipe` (acepta cualquier versión). Si no son UUID, la respuesta es 400 `Validation failed (uuid is expected)`.
- Los UUID del body y de la query (`categoryId`, `customerId`, `assignedUserId`…) se validan con `@IsUUID()`, que exige además versión 1 a 8 y variante RFC (también acepta el UUID nulo y el máximo). Si no cumplen, la respuesta es 400 `<campo> must be a UUID`. Los ids que genera bk-crm son v4 y siempre cumplen; un id inventado a mano para un mock o una prueba puede no hacerlo.
- Las fechas se devuelven en ISO 8601 UTC (`"2026-11-03T02:32:11.984Z"`). Los campos sin valor llegan como `null`.

### Peticiones, respuestas y validación

- El body se envía en JSON con `Content-Type: application/json`. Sin esa cabecera el body no se interpreta y la validación responde 400 como si faltaran todos los campos. Si el JSON está mal formado, la respuesta es 400 con el texto del parser en `message` (string).
- El tamaño máximo del body es el de Express por defecto (100 kb). Si se supera, la respuesta es 413 `El cuerpo de la petición supera el tamaño máximo permitido`. Los demás errores del parser conservan su código; por ejemplo, un `charset` que no empieza por `utf-` (`latin1`, o `utf8` sin guion) responde 415 `unsupported charset "LATIN1"`.
- No hay un envoltorio común: la respuesta es el recurso, un array o `{ "message": "..." }`. Los listados paginados devuelven `{ "data": [...], "pagination": { "page", "limit", "total", "totalPages" } }` (ver [Paginación y orden](#paginación-y-orden)). Excepciones: `GET /` responde texto, los `GET` de verificación de los webhooks responden `text/plain` y las rutas con 204 (p. ej. `DELETE /customers/:id/interests/:commercialItemId`) no tienen body.
- Hay un `ValidationPipe` global con `whitelist: true`, `forbidNonWhitelisted: true` y `transform: true`. Esto implica:
  - Un campo que no está declarado en el DTO no se descarta en silencio: la respuesta es 400 `property <campo> should not exist`, y este mensaje aparece primero en el array. No hay que enviar campos que solo existen en la UI (`confirmPassword`) ni campos de solo lectura (`id`, `createdAt`, `isActive` o `roles` en `PATCH /users/:id`).
  - `transform` convierte el body a la clase del DTO, pero no hay conversión implícita de tipos: `"true"` no cuenta como booleano ni `"5"` como número. Solo convierten los DTO que lo declaran con `@Type` o `@Transform` (p. ej. `page` y `limit` en los query params de los listados).
  - Un campo opcional se omite. Enviar `null` no es lo mismo que omitirlo: `null` pasa `@IsOptional()` y llega al servicio.
  - El pipe no recorta espacios. En usuarios y login normalizan los servicios: el email se pasa a minúsculas y los nombres se guardan con `trim`. El servicio también aplica `trim` al email, pero no tiene efecto práctico: `@IsEmail()` rechaza con 400 un email con espacios alrededor, así que hay que recortarlo en el cliente. Los demás módulos recortan en el DTO con `@Transform` (el detalle está en cada módulo).
  - Los mensajes de class-validator están en inglés; los mensajes personalizados, en español.
- El orden de comprobación es: guards (rate limit, access token, rol), luego validación (UUID y body) y al final las reglas del servicio. Por eso, sin token se recibe 401 aunque el body sea inválido, y con token pero sin el rol necesario, 403. La excepción es el parser de Express, que actúa antes que los guards: un JSON mal formado responde 400 (un body de más de 100 kb, 413, y un `charset` que no empieza por `utf-`, 415) aunque falte el token.

### Formato de errores

Todos los errores pasan por el filtro global `GlobalExceptionFilter`. `message` es un **array** solo en el 400 de validación de DTO; en los demás casos es un **string** (el 503 de `GET /health` no trae `message`). Conviene normalizarlo en el cliente: `Array.isArray(message) ? message : [message]`.

| Código | `message` | `error` | Cuándo |
|---|---|---|---|
| 400 | array de strings | `"Bad Request"` | Validación de DTO, incluidos los campos no permitidos |
| 400 | string | `"Bad Request"` | Reglas del servicio, UUID inválido en la ruta o JSON mal formado |
| 401 | `"Unauthorized"` | no viene | Falta `Authorization`, el token está mal formado, la firma es inválida o el token expiró |
| 401 | string | `"Unauthorized"` | Credenciales incorrectas, usuario inactivo, sesión revocada o vencida, refresh token inválido |
| 403 | string | `"Forbidden"` | El usuario no tiene ninguno de los roles exigidos, o una regla del servicio lo impide (el detalle está en cada módulo) |
| 404 | string | `"Not Found"` | El recurso o la ruta no existe |
| 409 | string | `"Conflict"` | Duplicados, protección del último ADMIN o conflicto entre transacciones |
| 413 | `"El cuerpo de la petición supera el tamaño máximo permitido"` | `"Payload Too Large"` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` (p. ej. `"LATIN1"`) | `"Unsupported Media Type"` | El `Content-Type` trae un `charset` que no empieza por `utf-` |
| 429 | `"ThrottlerException: Too Many Requests"` | no viene | Se superó el límite de intentos de login o de recuperación de contraseña. Otros módulos pueden devolver 429 con su propio mensaje, también sin `error` (p. ej. `Límite de generación de Samanta alcanzado`) |
| 500 | `"Ocurrió un error interno"` | no viene (en su lugar trae `path`, `method` y `timestamp`) | Error no controlado; no expone detalles internos |
| 503 | no viene en `GET /health`; string en otros módulos | no viene en `GET /health`; `"Service Unavailable"` en otros módulos | En `GET /health` el body es el objeto de salud con `"status": "error"`. Otros módulos responden 503 cuando una integración está desactivada o mal configurada (p. ej. `Samanta está desactivada`) |

Esta tabla describe lo que responde bk-crm. Lo que ve el navegador:
- En las rutas de `/api/backend`, los 401 de bk-crm nunca llegan tal cual: el BFF responde su propio 401 (`Tu sesión terminó. Vuelve a iniciar sesión.` con `code: "SESSION_EXPIRED"`, o `Inicia sesión para continuar.` con `code: "NO_SESSION"`; ver [Sesión](#sesión-srclibserversessionts)). Los demás códigos llegan con el body de bk-crm sin cambios.
- Los handlers de `/api/auth/*` traducen los errores de bk-crm, también el 429, a sus propios textos (ver cada ruta en [01](01-auth-usuarios.md)).

400 de validación de DTO (array):

```json
{
  "message": [
    "property confirmPassword should not exist",
    "email must be an email",
    "password must be longer than or equal to 8 characters"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

400 de regla de negocio o UUID inválido (string):

```json
{
  "message": "Validation failed (uuid is expected)",
  "error": "Bad Request",
  "statusCode": 400
}
```

401 genérico del guard (sin token, token mal formado, firma inválida o token expirado):

```json
{
  "message": "Unauthorized",
  "statusCode": 401
}
```

401 con motivo:

```json
{
  "message": "Sesión no válida o expirada",
  "error": "Unauthorized",
  "statusCode": 401
}
```

403:

```json
{
  "message": "No tienes permisos para realizar esta acción",
  "error": "Forbidden",
  "statusCode": 403
}
```

404:

```json
{
  "message": "Usuario no encontrado",
  "error": "Not Found",
  "statusCode": 404
}
```

409:

```json
{
  "message": "Ya existe un usuario registrado con este correo",
  "error": "Conflict",
  "statusCode": 409
}
```

429:

```json
{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests"
}
```

500:

```json
{
  "statusCode": 500,
  "message": "Ocurrió un error interno",
  "path": "/users/7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "method": "PATCH",
  "timestamp": "2026-11-03T02:32:11.984Z"
}
```

### Autenticación y sesión

- Las rutas protegidas exigen la cabecera `Authorization: Bearer <accessToken>`.
- **Access token**: JWT HS256 firmado con `JWT_SECRET`. Dura lo que indique `JWT_EXPIRES_IN`: en `.env.example` es `15m`; el valor real de cada entorno está (por confirmar). Sus claims son:

```json
{
  "sub": "3f6c1a52-8d0e-4b7a-9c61-2f4e8b9d0a17",
  "sessionId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "email": "rosa.mamani@example.com",
  "roles": ["ADMIN"],
  "iat": 1793673131,
  "exp": 1793674031
}
```

- El BFF usa `exp` para renovar a tiempo y para fijar el `maxAge` de las cookies; la UI no lo necesita. Los `roles` y el `email` del token reflejan el momento en que se emitió y pueden quedar desactualizados. Para la UI hay que usar `GET /auth/me` o `user.roles` del login.
- En cada petición protegida el backend comprueba:
  - la firma y la expiración del token;
  - que el usuario exista y esté activo;
  - que la sesión no esté revocada ni vencida.
- Además, los roles se leen de la base de datos en cada petición. Por eso desactivar a un usuario o cambiarle los roles surte efecto de inmediato.
- **Refresh token**: JWT firmado con otro secreto (`JWT_REFRESH_SECRET`). Dura lo que indique `JWT_REFRESH_EXPIRES_IN` (`7d` en `.env.example`). Solo se usa en `POST /auth/refresh`, y el backend guarda únicamente su hash SHA-256.
- **Sesión**: cada login crea una sesión independiente, así que un usuario puede tener varias a la vez (p. ej. en varios dispositivos).
  - La sesión vence 7 días después del login. Ese plazo está fijo en el código y el refresh no lo alarga.
  - Cuando vence la sesión o el refresh token, lo que ocurra antes, hay que volver a iniciar sesión.
- **Rotación**: cada refresh exitoso devuelve un par de tokens nuevo, y el refresh token usado deja de servir (es de un solo uso).
  - Si se reutiliza un refresh token que ya rotó, la respuesta es 401 `Refresh token inválido`. La sesión no se revoca: el último refresh token emitido sigue funcionando.
  - Si llegan dos refresh simultáneos con el mismo token, solo uno tiene éxito. El otro recibe 401 `Refresh token ya utilizado o sesión no válida` o `Refresh token inválido`. Por eso el BFF mantiene un único refresh en curso por token y reutiliza su resultado durante 60 s; el navegador no tiene que hacer nada.
  - Los access tokens anteriores de la misma sesión siguen siendo válidos hasta su `exp`.
- **Logout** (`POST /auth/logout`): revoca solo la sesión del access token enviado. Desde ese momento, el access token y el refresh token de esa sesión responden 401. Las demás sesiones del usuario siguen activas.
- **Revocación de todas las sesiones**: ocurre al desactivar al usuario (`PATCH /users/:id/status` con `isActive: false`) y al restablecer la contraseña (`POST /auth/reset-password`). No hay endpoint para listar sesiones ni para cerrar sesión en todos los dispositivos.
- **`GET /auth/me`** devuelve `{ id, sessionId, firstName, lastName, email, roles }` con los datos actuales de la base de datos.
- El BFF ya implementa este ciclo: guarda los tokens en cookies httpOnly, renueva una sola vez ante un 401 y, si no puede, responde `SESSION_EXPIRED` (ver [Sesión](#sesión-srclibserversessionts)).
- No hay registro público: los usuarios los crea un ADMIN. Tampoco hay endpoint para cambiar la contraseña estando autenticado; solo existe el flujo de recuperación.

### Roles

Los valores de `RoleCode` son `ADMIN`, `OWNER`, `OPERATOR` y `SUPPORT`. En el seed se llaman Administrador, Propietario, Operador y Soporte EYAQ. No hay endpoint para listar roles, así que el frontend debe usar esta lista fija.

Un usuario puede tener varios roles, y una ruta lo admite si tiene al menos uno de los permitidos. Si no tiene ninguno, la respuesta es 403 `No tienes permisos para realizar esta acción`. El guard también define el 403 `Usuario no disponible en la solicitud`, pero no se produce en las rutas actuales porque siempre se ejecuta después del guard de token.

Resumen de los `@Roles` de todos los controladores de `src`. Un `@Roles` declarado en una ruta sustituye al del controlador (no se suman):

| Área (rutas) | ADMIN | OWNER | OPERATOR | SUPPORT |
|---|---|---|---|---|
| Sesión propia (`GET /auth/me`, `POST /auth/logout`) | Sí | Sí | Sí | Sí |
| Usuarios (`/users/**`) y `GET /auth/test-admin` | Sí | No | No | No |
| Configuración del restaurante: ver (`GET /restaurant-config`) | Sí | Sí | Sí | No |
| Configuración del restaurante: guardar (`PUT /restaurant-config`) | Sí | No | No | No |
| Catálogo: ver (`GET /commercial-categories`, `GET /commercial-items` y sus detalles) | Sí | Sí | Sí | No |
| Catálogo: crear, editar, cambiar estado y aprobar ítems | Sí | No | No | No |
| Clientes: ver (`GET /customers`, `GET /customers/:id`) | Sí | Sí | Sí | No |
| Clientes: crear, editar, cambiar estado y gestionar intereses | Sí | No | Sí | No |
| Solicitudes de reserva: ver | Sí | Sí | Sí | No |
| Solicitudes de reserva: crear, editar y cambiar estado | Sí | No | Sí | No |
| Reservas: ver (`GET /reservations`, `GET /reservations/:id`) | Sí | Sí | Sí | No |
| Reservas: crear (`POST /reservations`) | Sí | No | No | No |
| Reservas: editar, cambiar estado, asignar responsable, añadir notas y reprogramar | Sí | No | Sí | No |
| Conversaciones: ver (lista, detalle y mensajes) | Sí | Sí | Sí | No |
| Conversaciones: enviar mensajes, marcar como leídas, pausar el asistente y asignar | Sí | No | Sí | No |
| Borradores de Samanta: ver (`GET /conversations/:id/assistant-drafts` y `/:draftId`) | Sí | Sí | Sí | No |
| Borradores de Samanta: generar, editar, aprobar y rechazar | Sí | No | Sí | No |

- **ADMIN**: acceso completo. Es el único que gestiona usuarios, guarda la configuración del restaurante, administra el catálogo y crea reservas manuales.
- **OWNER**: solo lectura en todos los módulos de negocio.
- **OPERATOR**: lectura y operación diaria (clientes, solicitudes, reservas existentes, conversaciones y Samanta).
- **SUPPORT**: no figura en ningún `@Roles`. Solo puede usar las rutas públicas, `GET /auth/me` y `POST /auth/logout`; el resto responde 403.
- Algunos servicios añaden reglas propias por rol (el detalle está en cada módulo):
  - Un OPERATOR solo puede tomar o liberar su propia asignación en reservas y conversaciones.
  - Un OPERATOR no puede operar borradores de Samanta de una conversación asignada a otro usuario.
- `GET/POST /webhooks/whatsapp` y `GET/POST /webhooks/messenger` son públicos y están pensados para Meta. El frontend no los usa.

### Rate limiting

- Tres rutas tienen límite de intentos (`ThrottlerGuard`), contado por ruta, por IP y por cuenta: el email en login y `forgot-password`, y el enlace (`token`) en `reset-password`:
  - `POST /auth/login`: 5 intentos cada 60 s.
  - `POST /auth/forgot-password`: 3 peticiones cada 60 s.
  - `POST /auth/reset-password`: 5 peticiones cada 60 s.
- Al superar el límite, la respuesta es 429 `{ "statusCode": 429, "message": "ThrottlerException: Too Many Requests" }` con la cabecera `Retry-After` (en segundos), y esa combinación de IP y cuenta queda bloqueada 60 s. Las demás cuentas siguen funcionando.
- Las respuestas dentro del límite incluyen las cabeceras `X-RateLimit-Limit`, `X-RateLimit-Remaining` y `X-RateLimit-Reset` (segundos hasta que se reinicia la ventana).
- El navegador no ve ni ese body ni esas cabeceras: los handlers de `/api/auth/*` responden su propio 429 `Hiciste demasiados intentos. Espera un minuto e inténtalo otra vez.`, sin `Retry-After` ni `X-RateLimit-*`. Espera un minuto antes de reactivar el botón.
- El límite se evalúa antes de validar el body, así que las peticiones que no pasan la validación del DTO también consumen cupo. Un JSON mal formado no lo consume, porque el parser lo rechaza antes.
- Los contadores viven en la memoria del proceso y se reinician cuando se reinicia el servidor.
- La IP contada es `req.ip`: la de la conexión o, con `TRUST_PROXY` (número de saltos o direcciones del proxy de confianza), la que un proxy inverso de confianza pone en `X-Forwarded-For`. En las peticiones del navegador es siempre la del servidor del BFF, porque sus handlers de `/api/auth/*` no reenvían la IP del navegador. Por eso también se cuenta por cuenta, y en la práctica el límite es por cuenta (ver [Consecuencias para el despliegue](#consecuencias-para-el-despliegue)).
- `POST /auth/refresh` y las demás rutas no tienen límite: el `ThrottlerGuard` no es global y solo se aplica en las tres rutas anteriores. El límite de generación de Samanta es una regla aparte de su servicio (el detalle está en ese módulo).

### CORS

CORS no está habilitado en bk-crm (`main.ts` no llama a `app.enableCors()`). No hace falta mientras el navegador solo hable con el BFF de Next.js. Solo habría que habilitarlo si algún cliente web llamara directamente a bk-crm.

### Paginación y orden

Los listados paginados devuelven `{ data, pagination: { page, limit, total, totalPages } }`:
- `page`: entero de 1 a 1 000 000. Por defecto vale 1.
- `limit`: de 1 a 100. Por defecto vale 20; en conversaciones y mensajes, 50.
- `totalPages`: `Math.ceil(total / limit)`. Vale 0 si no hay resultados.

`GET /users` y `GET /commercial-categories` devuelven un array plano. `GET /conversations/:id/assistant-drafts` devuelve `{ data }` con los 50 borradores más recientes, sin paginación.

El orden es fijo; solo en los elementos comerciales se puede elegir:

| Listado | Orden |
|---|---|
| `GET /customers` | `lastContactAt` desc, luego `id` asc |
| `GET /customers/:id` → `interests` | `lastInterestedAt` desc, luego `id` asc |
| `GET /reservation-requests` | `createdAt` desc, luego `id` asc |
| `GET /reservations` | `reservationAt` asc, luego `id` asc |
| `GET /conversations` | `lastMessageAt` desc (los nulos al final), luego `id` desc |
| `GET /conversations/:id/messages` | `sequence` desc: la página 1 trae lo más reciente |
| `GET /conversations/:id/assistant-drafts` | `createdAt` desc, luego `id` desc |
| `GET /commercial-items` | `sort` (`category`, `name` o `createdAt`; por defecto `createdAt`) y `order` (`asc` o `desc`; por defecto `desc`) |
| `GET /commercial-categories` | `displayOrder` asc, luego `nameEs` y `nameEn` |
| `GET /users` | `createdAt` desc |

### Fechas, zona horaria e importes

- **Lectura:** la API devuelve instantes ISO 8601 en UTC (`"2026-11-08T01:00:00.000Z"`). Muéstralos en el `timeZone` de `GET /restaurant-config` (`America/Lima` por defecto), no en la zona del navegador.
- **Envío** (body o query): ISO 8601 con segundos y zona explícita (`Z` o `±HH:mm`), con hasta 3 decimales. `Date.prototype.toISOString()` cumple el formato.
  - Una fecha sin zona o sin segundos responde 400.
  - En la URL, `+` debe ir como `%2B`; `URLSearchParams` ya lo hace.
- **Rangos del calendario:** `dateFrom` es inclusivo y `dateTo` exclusivo. Calcula la medianoche en la zona del restaurante y conviértela a UTC.
- **Importes:** son strings de `"0"` a `"99999999.99"`, con hasta 2 decimales. La API los devuelve siempre con 2 decimales (`"38.50"`).

### Idempotencia

- `POST /conversations/:id/messages` y `POST /conversations/:id/assistant-drafts` exigen la cabecera `Idempotency-Key`: de 16 a 80 caracteres `[A-Za-z0-9_-]`. Un `crypto.randomUUID()` sirve.
- Genera una clave nueva por cada acción del usuario. Reutilízala solo para reintentar esa misma acción, por ejemplo tras un timeout, un error de red o un doble clic.
- Si repites la clave con los mismos datos, el backend devuelve el resultado original sin repetir la acción. Si la repites con otros datos, responde 409.
- No uses el prefijo `samanta-`: el backend lo reserva para la aprobación de borradores.

### Tiempo real

- No hay WebSockets ni SSE: todo se actualiza por polling. Hoy la Bandeja consulta la lista cada 6 s y el chat cada 4 s (cada 1,5 s mientras hay salientes en `QUEUED` o `SENDING`). Los intervalos de todas las pantallas están en [Polling](05-implementacion-ft-crm.md#polling).
- Un worker de bk-crm procesa la cola de envío cada 2 s. Los recibos de Meta (entregado o leído) llegan cuando Meta los envía. bk-crm no procesa recibos de Instagram: sus salientes terminan en `SENT`.

## Mapa de rutas

Columnas:
- **Vía**: cómo se llama la ruta desde el navegador. Puede ser `/api/backend` + la ruta, un handler propio del BFF (`/api/auth/*`, `/api/listo`), *BFF (automático)* (el refresh), *Bloqueada* (el BFF responde 404) o *No se usa* (`GET /`: el proxy exige al menos un segmento).
- **Roles**: *Público* significa que la ruta no exige token.
- **ft-crm**: función de `src/lib/api/endpoints.ts` que llama a la ruta. *(nueva)* indica que aún no existe; la propuesta completa está en [05-implementacion-ft-crm.md](05-implementacion-ft-crm.md#21-endpointsts). *—* indica que el navegador no usa la ruta.

### Autenticación y usuarios — [01-auth-usuarios.md](01-auth-usuarios.md)

| Método | Ruta | Roles | Éxito | Vía | ft-crm | Detalle |
|---|---|---|---|---|---|---|
| GET | `/` | Público | 200 | No se usa | — | [Ver la respuesta raíz de la API](01-auth-usuarios.md#ver-la-respuesta-raíz-de-la-api) |
| POST | `/auth/login` | Público (5 intentos cada 60 s por IP y cuenta) | 201 | `/api/auth/login` | `sessionApi.login` | [Iniciar sesión](01-auth-usuarios.md#iniciar-sesión) |
| POST | `/auth/refresh` | Público (requiere refreshToken en el body) | 201 | BFF (automático) | `refreshSession` (BFF) | [Renovar tokens](01-auth-usuarios.md#renovar-tokens) |
| POST | `/auth/logout` | Cualquier usuario autenticado | 201 | `/api/auth/logout` | `sessionApi.logout` | [Cerrar sesión](01-auth-usuarios.md#cerrar-sesión) |
| GET | `/auth/me` | Cualquier usuario autenticado | 200 | `/api/backend` | `sessionApi.me` | [Obtener el usuario autenticado](01-auth-usuarios.md#obtener-el-usuario-autenticado) |
| GET | `/auth/test-admin` | ADMIN | 200 | Bloqueada por el BFF | — | [Comprobar acceso de administrador (endpoint de prueba)](01-auth-usuarios.md#comprobar-acceso-de-administrador-endpoint-de-prueba) |
| POST | `/auth/forgot-password` | Público (3 cada 60 s por IP y cuenta) | 200 | `/api/auth/forgot-password` | `sessionApi.forgotPassword` | [Solicitar recuperación de contraseña](01-auth-usuarios.md#solicitar-recuperación-de-contraseña) |
| POST | `/auth/reset-password` | Público (5 cada 60 s por IP y enlace) | 200 | `/api/auth/reset-password` | `sessionApi.resetPassword` | [Restablecer contraseña](01-auth-usuarios.md#restablecer-contraseña) |
| GET | `/health` | Público | 200 (503 si la base de datos no responde) | `/api/listo` | Handler `/api/listo` (BFF) | [Comprobar el estado del servicio](01-auth-usuarios.md#comprobar-el-estado-del-servicio) |
| POST | `/users` | ADMIN | 201 | `/api/backend` | `usersApi.create` | [Crear usuario](01-auth-usuarios.md#crear-usuario) |
| GET | `/users` | ADMIN | 200 | `/api/backend` | `usersApi.list` | [Listar usuarios](01-auth-usuarios.md#listar-usuarios) |
| GET | `/users/:id` | ADMIN | 200 | `/api/backend` | `usersApi.get` (nueva) | [Ver el detalle de un usuario](01-auth-usuarios.md#ver-el-detalle-de-un-usuario) |
| PATCH | `/users/:id` | ADMIN | 200 | `/api/backend` | `usersApi.update` (nueva) | [Editar los datos de un usuario](01-auth-usuarios.md#editar-los-datos-de-un-usuario) |
| PATCH | `/users/:id/status` | ADMIN | 200 | `/api/backend` | `usersApi.setActive` | [Activar o desactivar un usuario](01-auth-usuarios.md#activar-o-desactivar-un-usuario) |
| PATCH | `/users/:id/roles` | ADMIN | 200 | `/api/backend` | `usersApi.setRoles` | [Reemplazar los roles de un usuario](01-auth-usuarios.md#reemplazar-los-roles-de-un-usuario) |

### Configuración y catálogo — [02-configuracion-catalogo.md](02-configuracion-catalogo.md)

| Método | Ruta | Roles | Éxito | Vía | ft-crm | Detalle |
|---|---|---|---|---|---|---|
| GET | `/restaurant-config` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `configApi.get` | [Obtener la configuración del restaurante](02-configuracion-catalogo.md#obtener-la-configuración-del-restaurante) |
| PUT | `/restaurant-config` | ADMIN | 200 | `/api/backend` | `configApi.put` | [Guardar la configuración del restaurante (crear o reemplazar)](02-configuracion-catalogo.md#guardar-la-configuración-del-restaurante-crear-o-reemplazar) |
| POST | `/commercial-categories` | ADMIN | 201 | `/api/backend` | `catalogApi.createCategory` (nueva) | [Crear categoría comercial](02-configuracion-catalogo.md#crear-categoría-comercial) |
| GET | `/commercial-categories` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `catalogApi.categories` | [Listar categorías comerciales](02-configuracion-catalogo.md#listar-categorías-comerciales) |
| GET | `/commercial-categories/:id` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `catalogApi.category` (nueva) | [Ver detalle de una categoría comercial](02-configuracion-catalogo.md#ver-detalle-de-una-categoría-comercial) |
| PATCH | `/commercial-categories/:id` | ADMIN | 200 | `/api/backend` | `catalogApi.updateCategory` (nueva) | [Editar categoría comercial](02-configuracion-catalogo.md#editar-categoría-comercial) |
| PATCH | `/commercial-categories/:id/status` | ADMIN | 200 | `/api/backend` | `catalogApi.setCategoryActive` (nueva) | [Activar o desactivar una categoría comercial](02-configuracion-catalogo.md#activar-o-desactivar-una-categoría-comercial) |
| POST | `/commercial-items` | ADMIN | 201 | `/api/backend` | `catalogApi.create` (cambia el tipo del body) | [Crear elemento comercial](02-configuracion-catalogo.md#crear-elemento-comercial) |
| GET | `/commercial-items` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `catalogApi.items` | [Listar elementos comerciales](02-configuracion-catalogo.md#listar-elementos-comerciales) |
| GET | `/commercial-items/:id` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `catalogApi.item` (nueva) | [Ver detalle de un elemento comercial](02-configuracion-catalogo.md#ver-detalle-de-un-elemento-comercial) |
| PATCH | `/commercial-items/:id` | ADMIN | 200 | `/api/backend` | `catalogApi.update` (nueva) | [Editar elemento comercial](02-configuracion-catalogo.md#editar-elemento-comercial) |
| PATCH | `/commercial-items/:id/status` | ADMIN | 200 | `/api/backend` | `catalogApi.setActive` | [Activar o desactivar un elemento comercial](02-configuracion-catalogo.md#activar-o-desactivar-un-elemento-comercial) |
| PATCH | `/commercial-items/:id/approval` | ADMIN | 200 | `/api/backend` | `catalogApi.setApproval` | [Cambiar la aprobación de un elemento comercial](02-configuracion-catalogo.md#cambiar-la-aprobación-de-un-elemento-comercial) |

### Clientes, solicitudes y reservas — [03-clientes-reservas.md](03-clientes-reservas.md)

| Método | Ruta | Roles | Éxito | Vía | ft-crm | Detalle |
|---|---|---|---|---|---|---|
| POST | `/customers` | ADMIN, OPERATOR | 201 | `/api/backend` | `customersApi.create` (nueva) | [Crear cliente](03-clientes-reservas.md#crear-cliente) |
| GET | `/customers` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `customersApi.list` | [Listar clientes](03-clientes-reservas.md#listar-clientes) |
| GET | `/customers/:id` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `customersApi.get` | [Ver detalle de cliente](03-clientes-reservas.md#ver-detalle-de-cliente) |
| PATCH | `/customers/:id` | ADMIN, OPERATOR | 200 | `/api/backend` | `customersApi.update` (nueva) | [Editar cliente](03-clientes-reservas.md#editar-cliente) |
| PATCH | `/customers/:id/status` | ADMIN, OPERATOR | 200 | `/api/backend` | `customersApi.setStatus` | [Cambiar estado del cliente](03-clientes-reservas.md#cambiar-estado-del-cliente) |
| POST | `/customers/:id/interests` | ADMIN, OPERATOR | 200 | `/api/backend` | `customersApi.addInterest` (nueva) | [Registrar interés del cliente](03-clientes-reservas.md#registrar-interés-del-cliente) |
| DELETE | `/customers/:id/interests/:commercialItemId` | ADMIN, OPERATOR | 204 | `/api/backend` | `customersApi.removeInterest` (nueva) | [Quitar interés del cliente](03-clientes-reservas.md#quitar-interés-del-cliente) |
| POST | `/reservation-requests` | ADMIN, OPERATOR | 201 | `/api/backend` | `requestsApi.create` (nueva) | [Crear solicitud de reserva](03-clientes-reservas.md#crear-solicitud-de-reserva) |
| GET | `/reservation-requests` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `requestsApi.list` | [Listar solicitudes de reserva](03-clientes-reservas.md#listar-solicitudes-de-reserva) |
| GET | `/reservation-requests/:id` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `requestsApi.get` | [Ver detalle de solicitud de reserva](03-clientes-reservas.md#ver-detalle-de-solicitud-de-reserva) |
| PATCH | `/reservation-requests/:id` | ADMIN, OPERATOR | 200 | `/api/backend` | `requestsApi.update` (nueva) | [Editar solicitud de reserva](03-clientes-reservas.md#editar-solicitud-de-reserva) |
| PATCH | `/reservation-requests/:id/status` | ADMIN, OPERATOR | 200 | `/api/backend` | `requestsApi.cancel` | [Cancelar solicitud de reserva](03-clientes-reservas.md#cancelar-solicitud-de-reserva) |
| POST | `/reservation-requests/:id/approve` | ADMIN, OWNER | 200 | `/api/backend` | `requestsApi.approve` (nueva) | [Aprobar solicitud de reserva](03-clientes-reservas.md#aprobar-solicitud-de-reserva) |
| POST | `/reservation-requests/:id/reject` | ADMIN, OWNER | 200 | `/api/backend` | `requestsApi.reject` (nueva) | [Rechazar solicitud de reserva](03-clientes-reservas.md#rechazar-solicitud-de-reserva) |
| POST | `/reservations` | ADMIN | 201 | `/api/backend` | `reservationsApi.create` (nueva) | [Crear reserva manual](03-clientes-reservas.md#crear-reserva-manual) |
| GET | `/reservations` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `reservationsApi.list` | [Listar reservas (calendario)](03-clientes-reservas.md#listar-reservas-calendario) |
| GET | `/reservations/:id` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `reservationsApi.get` | [Ver detalle de reserva](03-clientes-reservas.md#ver-detalle-de-reserva) |
| PATCH | `/reservations/:id` | ADMIN, OPERATOR | 200 | `/api/backend` | `reservationsApi.update` (nueva) | [Editar reserva](03-clientes-reservas.md#editar-reserva) |
| PATCH | `/reservations/:id/status` | ADMIN, OPERATOR | 200 | `/api/backend` | `reservationsApi.setStatus` | [Cambiar estado de reserva](03-clientes-reservas.md#cambiar-estado-de-reserva) |
| PATCH | `/reservations/:id/assignee` | ADMIN, OPERATOR | 200 | `/api/backend` | `reservationsApi.assign` (nueva) | [Asignar o liberar responsable](03-clientes-reservas.md#asignar-o-liberar-responsable) |
| POST | `/reservations/:id/notes` | ADMIN, OPERATOR | 201 | `/api/backend` | `reservationsApi.addNote` (nueva) | [Agregar observación a la reserva](03-clientes-reservas.md#agregar-observación-a-la-reserva) |
| PATCH | `/reservations/:id/reschedule` | ADMIN, OPERATOR | 200 | `/api/backend` | `reservationsApi.reschedule` (nueva) | [Reprogramar reserva](03-clientes-reservas.md#reprogramar-reserva) |

### Bandeja y Samanta — [04-bandeja-samanta.md](04-bandeja-samanta.md)

| Método | Ruta | Roles | Éxito | Vía | ft-crm | Detalle |
|---|---|---|---|---|---|---|
| GET | `/conversations` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `conversationsApi.list` | [Listar conversaciones (bandeja)](04-bandeja-samanta.md#listar-conversaciones-bandeja) |
| GET | `/conversations/:id` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `conversationsApi.get` | [Ver detalle de una conversación](04-bandeja-samanta.md#ver-detalle-de-una-conversación) |
| GET | `/conversations/:id/messages` | ADMIN, OWNER, OPERATOR | 200 | `/api/backend` | `conversationsApi.messages` | [Ver historial de mensajes](04-bandeja-samanta.md#ver-historial-de-mensajes) |
| POST | `/conversations/:id/messages` | ADMIN, OPERATOR | 202 | `/api/backend` | `conversationsApi.send` | [Enviar un mensaje de texto](04-bandeja-samanta.md#enviar-un-mensaje-de-texto) |
| PATCH | `/conversations/:id/read` | ADMIN, OPERATOR | 200 | `/api/backend` | `conversationsApi.markRead` | [Marcar como leído hasta un mensaje](04-bandeja-samanta.md#marcar-como-leído-hasta-un-mensaje) |
| PATCH | `/conversations/:id/assistant` | ADMIN, OPERATOR | 200 | `/api/backend` | `conversationsApi.setAssistantPaused` | [Pausar o reanudar a Samanta en la conversación](04-bandeja-samanta.md#pausar-o-reanudar-a-samanta-en-la-conversación) |
| PATCH | `/conversations/:id/assignee` | ADMIN, OPERATOR (un OPERATOR solo toma conversaciones libres o se desasigna de las propias) | 200 | `/api/backend` | `conversationsApi.assign` | [Asignar, tomar o liberar una conversación](04-bandeja-samanta.md#asignar-tomar-o-liberar-una-conversación) |
| POST | `/conversations/:id/assistant-drafts` | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otro) | 201 | `/api/backend` | `assistantDraftsApi.generate` (nueva) | [Generar un borrador con Samanta](04-bandeja-samanta.md#generar-un-borrador-con-samanta) |
| GET | `/conversations/:id/assistant-drafts` | ADMIN, OPERATOR, OWNER | 200 | `/api/backend` | `assistantDraftsApi.list` (nueva) | [Listar borradores de Samanta](04-bandeja-samanta.md#listar-borradores-de-samanta) |
| GET | `/conversations/:id/assistant-drafts/:draftId` | ADMIN, OPERATOR, OWNER | 200 | `/api/backend` | `assistantDraftsApi.get` (nueva) | [Ver un borrador de Samanta](04-bandeja-samanta.md#ver-un-borrador-de-samanta) |
| PATCH | `/conversations/:id/assistant-drafts/:draftId` | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otro) | 200 | `/api/backend` | `assistantDraftsApi.edit` (nueva) | [Editar un borrador](04-bandeja-samanta.md#editar-un-borrador) |
| POST | `/conversations/:id/assistant-drafts/:draftId/approve` | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otro) | 202 | `/api/backend` | `assistantDraftsApi.approve` (nueva) | [Aprobar un borrador y encolar el envío](04-bandeja-samanta.md#aprobar-un-borrador-y-encolar-el-envío) |
| POST | `/conversations/:id/assistant-drafts/:draftId/reject` | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otro) | 200 | `/api/backend` | `assistantDraftsApi.reject` (nueva) | [Rechazar un borrador](04-bandeja-samanta.md#rechazar-un-borrador) |
| GET | `/webhooks/whatsapp` | Público (solo Meta; no usar desde el frontend) | 200 | Bloqueada (solo Meta) | — | [Verificar el webhook de WhatsApp](04-bandeja-samanta.md#verificar-el-webhook-de-whatsapp) |
| POST | `/webhooks/whatsapp` | Público (solo Meta, firma X-Hub-Signature-256; no usar desde el frontend) | 200 | Bloqueada (solo Meta) | — | [Recibir eventos de WhatsApp](04-bandeja-samanta.md#recibir-eventos-de-whatsapp) |
| GET | `/webhooks/messenger` | Público (solo Meta; no usar desde el frontend) | 200 | Bloqueada (solo Meta) | — | [Verificar el webhook de Messenger](04-bandeja-samanta.md#verificar-el-webhook-de-messenger) |
| POST | `/webhooks/messenger` | Público (solo Meta, firma X-Hub-Signature-256; no usar desde el frontend) | 200 | Bloqueada (solo Meta) | — | [Recibir eventos de Messenger](04-bandeja-samanta.md#recibir-eventos-de-messenger) |
| GET | `/webhooks/instagram` | Público (solo Meta; no usar desde el frontend) | 200 | Bloqueada (solo Meta) | — | [Webhooks de Meta](04-bandeja-samanta.md#webhooks-de-meta-no-usar-desde-el-frontend) |
| POST | `/webhooks/instagram` | Público (solo Meta, firma X-Hub-Signature-256; no usar desde el frontend) | 200 | Bloqueada (solo Meta) | — | [Webhooks de Meta](04-bandeja-samanta.md#webhooks-de-meta-no-usar-desde-el-frontend) |

## Flujos principales

### Sesión

1. El login va por `/api/auth/login`. El BFF guarda los tokens en cookies y devuelve `{ user }` con `roles`.
2. `GET /auth/me` devuelve `{ id, sessionId, firstName, lastName, email, roles }` con datos actuales. Úsalo para permisos y menús: los roles del token pueden estar desactualizados.
3. Desactivar a un usuario o restablecer su contraseña revoca todas sus sesiones. El siguiente request de ese usuario termina en `SESSION_EXPIRED`.

### Bandeja y envío de mensajes

1. **Lista:** `GET /conversations`, con polling.
   - `unreadCount` es por conversación.
   - Para el total de conversaciones con mensajes sin leer, pide `unreadOnly=true&limit=1` y lee `pagination.total`.
2. **Chat:** `GET /conversations/:id/messages?page=1&limit=50`.
   - Llega en orden `sequence` desc: inviértelo para pintar.
   - Para "cargar anteriores", pide `page + 1` y deduplica por `id`.
   - No ordenes por fechas.
3. **Leído:** `PATCH /conversations/:id/read` con `{ throughMessageId }`, el mensaje más reciente cargado. Solo ADMIN y OPERATOR.
4. **Enviar:** `POST /conversations/:id/messages` con `Idempotency-Key` y `{ type: 'TEXT', content }`.
   - Responde 202 con el mensaje en `QUEUED`. Su estado se sigue por polling: `QUEUED → SENDING → SENT → DELIVERED → READ` (en Instagram termina en `SENT`).
   - `READ` solo existe en WhatsApp.
   - `FAILED` trae `errorCode`.
   - `UNKNOWN` indica un envío incierto: no lo reenvíes sin verificar.
5. **Canales con respuesta:** `WHATSAPP` (hasta 4096 caracteres), `FACEBOOK`/Messenger (hasta 2000) e `INSTAGRAM` (hasta 1000 caracteres y 1000 bytes UTF-8).
   - En los tres hay una ventana de 24 h desde el último `INBOUND` del cliente. Fuera de ella, el POST responde 409.
   - Cuenta la longitud con `content.length`. En Instagram, cuenta además los bytes UTF-8 (`new TextEncoder().encode(texto).length`).
   - Con acceso estándar a la API de Meta, Instagram solo entrega a cuentas con un rol en la app: con otra cuenta, el mensaje termina `FAILED` con `INSTAGRAM_SEND_REJECTED`.
6. **Asignación y pausa:** `PATCH /conversations/:id/assignee` y `PATCH /conversations/:id/assistant` (`{ paused }`).
   - Un OPERATOR solo puede tomar conversaciones libres o liberar las suyas.
   - Son llamadas independientes. Si la UI encadena varias (pausar → enviar → asignar), maneja el fallo de cada paso.

### Samanta: borradores con revisión humana

Genera un borrador cuando una persona lo pide, y una persona lo revisa antes de enviarlo. Funciona en conversaciones `WHATSAPP`, `FACEBOOK` e `INSTAGRAM` sin pausar. Desde el 8/11, si el servidor tiene el modo automático, además responde sola: ver [04 › Samanta automática](04-bandeja-samanta.md#samanta-automática).

1. **Generar:** `POST /conversations/:id/assistant-drafts` con `Idempotency-Key` y `{ sourceMessageId }`.
   - `sourceMessageId` es el `id` del último mensaje de la conversación, que debe ser `INBOUND` de tipo `TEXT`.
   - Responde 201 con el borrador. Revisa `status`: puede venir `READY`, `GENERATING`, `STALE` o `FAILED`.
2. **Esperar:** si sigue en `GENERATING`, consulta `GET /conversations/:id/assistant-drafts/:draftId` cada 2–3 s.
3. **Editar:** `PATCH …/assistant-drafts/:draftId` con `{ revision, content }`. Cada edición suma 1 a `revision`.
4. **Aprobar o rechazar:**
   - `POST …/approve` con `{ revision }` responde 202 y encola un `OUTBOUND` cuyo `authorUserId` es quien aprueba. El borrador guarda ese mensaje en `outboundMessageId`.
   - `POST …/reject` con `{ revision }` responde 200.
5. **Caducidad:** el borrador caduca a los 15 min (`expiresAt`) y pasa a `STALE` si llega otro mensaje. En ambos casos, genera otro con una clave nueva.

Límites por defecto: 100 generaciones al día (global, por día UTC) y 2 simultáneas. Al superarlos, la respuesta es 429. Un OPERATOR no puede operar borradores de una conversación asignada a otra persona.

### Calendario y reservas

- **Consulta:** `GET /reservations?dateFrom=…&dateTo=…&excludeCancelled=true&limit=100`, recorriendo `page` hasta `totalPages`.
- **Cambios de estado:** siguen `RESERVATION_STATUS_TRANSITIONS` (tipos de [03-clientes-reservas.md](03-clientes-reservas.md#tipos-typescript)).
  - `IN_SERVICE` y `NO_SHOW` exigen que haya llegado la hora de la reserva.
  - `RESCHEDULED` lo pone el backend al reprogramar.
  - Los estados finales son `COMPLETED`, `CANCELLED` y `NO_SHOW`.
- **Creación:** solo un ADMIN puede crear una reserva manual (`POST /reservations`). No existe el paso "solicitud aceptada → reserva": `reservationRequestId` siempre es `null`.

### Clientes y canales

- **Alta:** los clientes se crean solos con su primer mensaje (WhatsApp por teléfono, Messenger por el identificador del usuario en la página, Instagram por el de la cuenta) y, desde el 9/11, con las reservas de la web que llegan por correo ([03](03-clientes-reservas.md#solicitudes-que-llegan-de-la-web)). También se pueden crear a mano con `POST /customers` (ADMIN y OPERATOR).
- **Sin nombre:**
  - Los clientes de WhatsApp llegan sin nombre, con teléfono.
  - Los de Messenger e Instagram llegan sin teléfono ni email. Al recibir un mensaje de un cliente sin `firstName` ni `lastName`, el backend pide a Meta el nombre visible y lo guarda completo en `firstName` (`lastName` queda en `null`); en Instagram, si el perfil no tiene nombre, guarda `@usuario`. Nunca pisa un nombre puesto en el CRM. Si Meta no lo da, sigue en `null` y se reintenta con el siguiente mensaje.
  - Muestra un texto de respaldo: el teléfono, «Cliente de Messenger» o «Cliente de Instagram» (ver [Bandeja](05-implementacion-ft-crm.md#bandeja) en el 05).
- **Identidad del proveedor (Messenger e Instagram):** la respuesta no indica si un cliente `FACEBOOK` o `INSTAGRAM` es una identidad de Messenger o de Instagram. Si se intenta cambiar el canal de uno de ellos, la respuesta es 400 `No se puede cambiar el canal de una identidad del proveedor`.

## Diferencias con ft-crm (de mock a live)

Comparación con el código actual de ft-crm (`src/lib/api`, `src/lib/server`, `src/app`, `src/features` y `src/lib/mock`), hecha el 3/11/2026, solo por lectura. El plan detallado, pantalla por pantalla, está en [05-implementacion-ft-crm.md](05-implementacion-ft-crm.md); esta sección es el resumen.

### Lo que ya coincide

- Las 34 llamadas que define hoy ft-crm existen en bk-crm con la misma ruta, método y forma: las 32 funciones de `src/lib/api/endpoints.ts`, el refresh del BFF y `/api/listo`. Treinta ya se usan; las otras cuatro están definidas pero sin pantalla (ver más abajo).
- Ninguna envía parámetros que bk-crm rechace: todos los `limit` son ≤ 100, los booleanos van como texto y las fechas salen de `toISOString()`. La única excepción es Solicitudes, que pasa la `pagina` de la URL sin tope ni redondeo: una página mayor que 1 000 000 o con decimales da 400 (usa `parsePage`, ver [Solicitudes](05-implementacion-ft-crm.md#solicitudes)).
- `apiFetch`, `toSearch`, `collectPages` y `newIdempotencyKey` (`src/lib/api/client.ts`) ya hacen lo que pide bk-crm: no hace falta cambiarlos.
- El orden que asume la UI es el real en todos los listados que usa:
  - solicitudes por `createdAt` desc;
  - reservas por `reservationAt` asc;
  - conversaciones por `lastMessageAt` desc;
  - mensajes por `sequence` desc;
  - intereses por `lastInterestedAt` desc.
- `PUT /restaurant-config` recibe exactamente los campos que envía `toPutRequest`. El `SetupForm` ya maneja el 404 inicial (restaurante sin configurar).
- La matriz de `permissions.ts` coincide con los `@Roles` del backend en las acciones que existen. Para las funciones nuevas faltan acciones (`draft.review`, `reservation.create`…): ver [Guía por pantalla](05-implementacion-ft-crm.md#3-guía-por-pantalla).
- «Marcar como preparada» (`UPCOMING`, desde `CONFIRMED` o `RESCHEDULED`) es una transición válida. No se puede volver directamente a `CONFIRMED` (409), pero al reprogramar la reserva pasa a `RESCHEDULED`, y desde ahí sí. Por eso el «No se puede deshacer» de la confirmación y el comentario de `PREPARED_STATUS` (`src/lib/domain/statuses.ts`) no son exactos. Falta confirmar el texto con producto.

### Ya ajustado en ft-crm (pendiente de commit)

- `src/lib/server/backend.ts`: techo de 65 s para `POST /conversations/:id/assistant-drafts`, con su prueba en `backend.test.ts` (archivo nuevo).
- `src/app/api/auth/login/route.ts`: el 429 del login se muestra como «Hiciste demasiados intentos…» en lugar de un error del servidor.
- `.env.example` y el comentario de `src/app/api/auth/forgot-password/route.ts` describen los límites y techos actuales.

### Cambios necesarios, por prioridad

El orden de trabajo completo, con criterios de «listo», está en [Orden de trabajo recomendado](05-implementacion-ft-crm.md#orden-de-trabajo-recomendado).

1. **Capa de API y errores.** Faltan 25 funciones en `endpoints.ts`, sus tipos y 7 claves de caché ([Capa de API](05-implementacion-ft-crm.md#2-capa-de-api)). Además, `ApiError.isUnavailable` trata cualquier 503 como falta de conexión, también el de una función apagada en el servidor. Hoy solo el envío responde así, y `sendErrorText` ya lo separa; las acciones nuevas (Samanta y altas de solicitudes y reservas) deben usar `isConnectionError` e `isDisabledInServer` ([Manejo de errores](05-implementacion-ft-crm.md#4-manejo-de-errores-en-la-ui)).
2. **Messenger e Instagram en la Bandeja.** Ya aplicado en ft-crm: Messenger en el commit `56519b5` e Instagram en `28ba0ed` (8/11). Hoy ft-crm:
   - responde en `WHATSAPP`, `FACEBOOK` e `INSTAGRAM` (`SENDABLE_CHANNELS` en `src/lib/api/types.ts`) y solo exige teléfono en WhatsApp: en Messenger e Instagram el destinatario lo resuelve el backend;
   - limita a 4096, 2000 y 1000 caracteres (`OUTBOUND_TEXT_MAX_LENGTH`) y, en Instagram, a 1000 bytes UTF-8 (`OUTBOUND_TEXT_MAX_BYTES`), con contador en bytes en el Composer y en el borrador de Samanta;
   - estima la ventana de 24 h en los tres canales y elige según el canal los textos de ventana cerrada, de destinatario y de canal apagado (`sendErrorText`, `windowClosedText` y `sendChannelName`);
   - tiene textos para los `errorCode` `WHATSAPP_*`, `MESSENGER_*` e `INSTAGRAM_*`, incluido `WHATSAPP_TEMPLATE_EXPIRED`;
   - tiene en cuenta que Messenger no informa lecturas (su último estado posible es `DELIVERED`) e Instagram no informa entregas ni lecturas (termina en `SENT`);
   - muestra el panel de Samanta en los tres canales;
   - en el mock, responde `Conversación sin destinatario habilitado`, acepta Instagram con sus topes y deja sus salientes en `SENT`.

   Falta probarlo en modo live con una cuenta de Instagram que tenga un rol en la app de Meta: con acceso estándar, Meta solo entrega a esas cuentas.
3. **Samanta con borradores.** ft-crm no tiene tipos ni hooks para `/conversations/:id/assistant-drafts`, y el mock simula a Samanta con mensajes `OUTBOUND` sin autor y `DELIVERED`. En ft-crm hay que:
   - implementar el flujo de la sección [Samanta](#samanta-borradores-con-revisión-humana) (hooks de ejemplo en la [Bandeja](05-implementacion-ft-crm.md#bandeja) del 05);
   - eliminar la regla «`OUTBOUND` sin autor = Samanta», que con datos reales nunca se cumple;
   - para marcar un mensaje como de Samanta, cruzarlo con `outboundMessageId` de los borradores `APPROVED`. La lista trae solo los 50 borradores más recientes: un mensaje aprobado desde uno más antiguo se verá como de quien lo aprobó ([Listar borradores](04-bandeja-samanta.md#listar-borradores-de-samanta));
   - tener en cuenta que el "modo" de la conversación (Samanta o humano) es un concepto de la UI: en el backend, `isAssistantPaused` solo impide generar y usar borradores;
   - decidir con producto si enviar debe seguir pausando a Samanta: con la conversación en pausa, generar responde 409.
4. **Clientes sin nombre ni teléfono.** En el mock, casi todos los clientes tienen nombre y todos tienen teléfono, también los de Facebook. En bk-crm, los clientes de WhatsApp llegan con `firstName` y `lastName` en `null`; los de Messenger e Instagram reciben `firstName` de Meta cuando está disponible (en Instagram, el nombre del perfil o `@usuario`) y no tienen `phone` ni `email`. Bandeja, Clientes, Solicitudes y Calendario necesitan un texto de respaldo.
5. **Solicitudes y flujo del dueño.** Hoy no hay forma de usar el flujo del dueño con datos reales:
   - `PATCH /reservation-requests/:id/status` solo acepta `CANCELLED`.
   - Ningún endpoint lleva a `SENT_TO_OWNER`, `WAITING_RESPONSE`, `ACCEPTED`, `REJECTED`, `MODIFICATION_REQUESTED` ni `RENEGOTIATING`. Por eso los KPI y las pestañas Esperando, Aceptadas y Rechazadas quedarán en 0.
   - Las solicitudes se crean con `POST /reservation-requests` (ADMIN y OPERATOR), que no tiene pantalla, y desde el 9/11 con las reservas de la web que llegan por correo ([03](03-clientes-reservas.md#solicitudes-que-llegan-de-la-web)).
   - Textos que no se cumplen: el subtítulo de Solicitudes («Samanta envía cada solicitud al WhatsApp del dueño…») y el panel de la Bandeja («Samanta la crea cuando el cliente confirma…»).
   - Opciones: añadir el formulario "Nueva solicitud", o mostrar estas secciones como "próximamente".
6. **Reservas.** Solo se crean con `POST /reservations` (ADMIN), que no tiene pantalla, así que el calendario estará vacío en modo live.
   - La etiqueta será siempre «Registrada en el CRM», porque `reservationRequestId` es `null`; el subtítulo «Solo reservas aceptadas por el dueño.» tampoco se cumple.
   - Tampoco tienen pantalla editar, asignar responsable, agregar observaciones ni reprogramar.
7. **Autor de los mensajes.** `GET /users` es solo para ADMIN, así que OWNER y OPERATOR no pueden traducir `authorUserId` a un nombre. Mantén lo que ya hace `outboundAuthorLabel`: «Tú» (comparando con `GET /auth/me`), el nombre del responsable si fue él quien escribió, o un texto genérico (hoy «Operador»).
8. **Adjuntos.** Solo llega la metadata (`externalMediaId`, `mimeType`, `fileName`) y no hay endpoint para descargar el archivo.
9. **Datos iniciales reales.** El seed crea:
   - un único usuario ADMIN (`ADMIN_EMAIL` / `ADMIN_PASSWORD` del backend);
   - ninguna configuración del restaurante (404 hasta el primer PUT);
   - 16 categorías y 86 elementos en `DRAFT`, 9 de ellos sin `nameEs` (no se pueden aprobar hasta editarlos). Samanta solo usa elementos `APPROVED` y activos de categorías activas (como máximo 30), así que un ADMIN tiene que aprobarlos.
10. **Errores que el mock nunca devuelve** (lista completa en [Qué hace distinto el mock](05-implementacion-ft-crm.md#61-qué-hace-distinto-el-mock)):
    - 429 del rate limiting;
    - 503 `WhatsApp no está habilitado`, `Messenger no está habilitado`, `Instagram no está habilitado`, `El envío por Instagram no está configurado` y `Samanta está desactivada` (en desarrollo se suelen apagar);
    - 409 de concurrencia (`Conflicto de mensajería; vuelve a intentarlo`);
    - 413 por un body de más de 100 kb;
    - validaciones completas de email, enums y URLs.

### Rutas de bk-crm que ft-crm aún no usa

Definidas en `src/lib/api/endpoints.ts`, pero sin pantalla que las use: `PATCH /users/:id/roles`, `PATCH /customers/:id/status`, `GET /reservation-requests/:id`, `PATCH /reservation-requests/:id/status`.

Sin cliente en ft-crm (25 rutas; el mock responde 404 `Cannot METHOD path`). La función propuesta para cada una está en [`endpoints.ts`](05-implementacion-ft-crm.md#21-endpointsts):

| Método | Ruta | Roles | Función propuesta | Detalle |
|---|---|---|---|---|
| GET | `/users/:id` | ADMIN | `usersApi.get` | [Ver el detalle de un usuario](01-auth-usuarios.md#ver-el-detalle-de-un-usuario) |
| PATCH | `/users/:id` | ADMIN | `usersApi.update` | [Editar los datos de un usuario](01-auth-usuarios.md#editar-los-datos-de-un-usuario) |
| POST | `/commercial-categories` | ADMIN | `catalogApi.createCategory` | [Crear categoría comercial](02-configuracion-catalogo.md#crear-categoría-comercial) |
| GET | `/commercial-categories/:id` | ADMIN, OWNER, OPERATOR | `catalogApi.category` | [Ver detalle de una categoría comercial](02-configuracion-catalogo.md#ver-detalle-de-una-categoría-comercial) |
| PATCH | `/commercial-categories/:id` | ADMIN | `catalogApi.updateCategory` | [Editar categoría comercial](02-configuracion-catalogo.md#editar-categoría-comercial) |
| PATCH | `/commercial-categories/:id/status` | ADMIN | `catalogApi.setCategoryActive` | [Activar o desactivar una categoría comercial](02-configuracion-catalogo.md#activar-o-desactivar-una-categoría-comercial) |
| GET | `/commercial-items/:id` | ADMIN, OWNER, OPERATOR | `catalogApi.item` | [Ver detalle de un elemento comercial](02-configuracion-catalogo.md#ver-detalle-de-un-elemento-comercial) |
| PATCH | `/commercial-items/:id` | ADMIN | `catalogApi.update` | [Editar elemento comercial](02-configuracion-catalogo.md#editar-elemento-comercial) |
| POST | `/customers` | ADMIN, OPERATOR | `customersApi.create` | [Crear cliente](03-clientes-reservas.md#crear-cliente) |
| PATCH | `/customers/:id` | ADMIN, OPERATOR | `customersApi.update` | [Editar cliente](03-clientes-reservas.md#editar-cliente) |
| POST | `/customers/:id/interests` | ADMIN, OPERATOR | `customersApi.addInterest` | [Registrar interés del cliente](03-clientes-reservas.md#registrar-interés-del-cliente) |
| DELETE | `/customers/:id/interests/:commercialItemId` | ADMIN, OPERATOR | `customersApi.removeInterest` | [Quitar interés del cliente](03-clientes-reservas.md#quitar-interés-del-cliente) |
| POST | `/reservation-requests` | ADMIN, OPERATOR | `requestsApi.create` | [Crear solicitud de reserva](03-clientes-reservas.md#crear-solicitud-de-reserva) |
| PATCH | `/reservation-requests/:id` | ADMIN, OPERATOR | `requestsApi.update` | [Editar solicitud de reserva](03-clientes-reservas.md#editar-solicitud-de-reserva) |
| POST | `/reservations` | ADMIN | `reservationsApi.create` | [Crear reserva manual](03-clientes-reservas.md#crear-reserva-manual) |
| PATCH | `/reservations/:id` | ADMIN, OPERATOR | `reservationsApi.update` | [Editar reserva](03-clientes-reservas.md#editar-reserva) |
| PATCH | `/reservations/:id/assignee` | ADMIN, OPERATOR | `reservationsApi.assign` | [Asignar o liberar responsable](03-clientes-reservas.md#asignar-o-liberar-responsable) |
| POST | `/reservations/:id/notes` | ADMIN, OPERATOR | `reservationsApi.addNote` | [Agregar observación a la reserva](03-clientes-reservas.md#agregar-observación-a-la-reserva) |
| PATCH | `/reservations/:id/reschedule` | ADMIN, OPERATOR | `reservationsApi.reschedule` | [Reprogramar reserva](03-clientes-reservas.md#reprogramar-reserva) |
| POST | `/conversations/:id/assistant-drafts` | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otro) | `assistantDraftsApi.generate` | [Generar un borrador con Samanta](04-bandeja-samanta.md#generar-un-borrador-con-samanta) |
| GET | `/conversations/:id/assistant-drafts` | ADMIN, OPERATOR, OWNER | `assistantDraftsApi.list` | [Listar borradores de Samanta](04-bandeja-samanta.md#listar-borradores-de-samanta) |
| GET | `/conversations/:id/assistant-drafts/:draftId` | ADMIN, OPERATOR, OWNER | `assistantDraftsApi.get` | [Ver un borrador de Samanta](04-bandeja-samanta.md#ver-un-borrador-de-samanta) |
| PATCH | `/conversations/:id/assistant-drafts/:draftId` | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otro) | `assistantDraftsApi.edit` | [Editar un borrador](04-bandeja-samanta.md#editar-un-borrador) |
| POST | `/conversations/:id/assistant-drafts/:draftId/approve` | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otro) | `assistantDraftsApi.approve` | [Aprobar un borrador y encolar el envío](04-bandeja-samanta.md#aprobar-un-borrador-y-encolar-el-envío) |
| POST | `/conversations/:id/assistant-drafts/:draftId/reject` | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otro) | `assistantDraftsApi.reject` | [Rechazar un borrador](04-bandeja-samanta.md#rechazar-un-borrador) |

### Solo en el mock

Resumen; la tabla completa, con lo que hace bk-crm en cada caso, está en [Qué hace distinto el mock](05-implementacion-ft-crm.md#61-qué-hace-distinto-el-mock).

- `/api/dev/simulador` (inyecta mensajes entrantes, respuestas de Samanta, solicitudes y respuestas del dueño). En modo live responde 404, así que las pruebas e2e de `e2e/*.spec.ts` solo corren en modo mock.
- Usuarios de demostración con la contraseña común `demo1234`, configuración del restaurante ya creada y catálogo con elementos `APPROVED`.
- Clientes de Facebook con teléfono y casi todos los clientes con nombre.
- Solicitudes que pasan a `WAITING_RESPONSE`, `ACCEPTED` o `REJECTED`, y reservas creadas al aceptar una solicitud (`reservationRequestId ≠ null`).
- Regla de "más de 20 personas": el simulador responde con un mensaje de transferencia y pausa a Samanta, sin crear la solicitud ni asignar a nadie.
- Worker de envío simulado: `QUEUED → SENT` (1,2 s) `→ DELIVERED` (2,6 s), sin depender de WhatsApp, Redis ni la ventana de 24 h real.
- Tokens sin firma (`alg: none`), sin rate limiting. `reset-password` acepta cualquier token de 64 caracteres hexadecimales.
- Validaciones simplificadas: el estado del cliente sin enum; en `POST /users`, sin validar el email ni los valores de los roles (y `roles: []` responde 400 con un string); en `PUT /restaurant-config`, `logoUrl` y `website` con una regex simple y sin validar email, zona horaria ni decimales de las coordenadas.

### Llamadas que la UI resuelve en el cliente (candidatas a endpoints del backend)

Hoy funcionan, pero hacen varias llamadas por fila o calculan en el navegador. Son candidatas a un endpoint o a un campo embebido en el backend:
- vista previa del último mensaje de cada conversación (una llamada por fila);
- última solicitud de cada cliente (las 100 más recientes y, si falta, una llamada por fila);
- columnas RESERVAS y CONSULTÓ de Clientes (una llamada por fila para cada columna);
- historial del panel derecho de la Bandeja (dos listados);
- Estadísticas (hasta 20 páginas de 100 por fuente);
- pestaña Esperando (una lectura por estado, de hasta 5 páginas cada una, porque `status` acepta un solo valor);
- etiqueta «Samanta» de los mensajes salientes (cruzar con los borradores aprobados, porque el mensaje no dice que salió de un borrador).

## Cambios del backend del 10/11/2026 (M9.3): aviso al cliente de la decisión del propietario

Todavía sin commit. Requiere la migración `20261114000000_customer_decision_notice`. Va encima de M9.2. No hay rutas nuevas.

1. **Aviso automático.** Cuando el propietario acepta, rechaza o propone un cambio desde su WhatsApp, el backend avisa al cliente:
   - en la conversación de Samanta de la que salió la solicitud (WhatsApp, Messenger o Instagram);
   - o, para las de la web, en la conversación de WhatsApp del cliente.

   Las decisiones tomadas en el CRM no avisan solas.
2. **Reglas.**
   - Con la ventana de 24 h abierta se envía un texto normal.
   - Con la ventana cerrada, solo por WhatsApp, y solo con plantilla aprobada, `CUSTOMER_DECISION_TEMPLATES_ENABLED=true` y un WhatsApp que el cliente nos dio.
   - Nunca se escribe en una conversación que atiende una persona.
   - El aviso de aceptación sale solo después de que la reserva `CONFIRMED` existe.
   - El de rechazo nunca dice «confirmada».
   - El de cambio propuesto no cambia nada y pasa la conversación a una persona.
3. **Un aviso por solicitud**, por el outbox y con sus reintentos. No se duplica con webhooks repetidos ni con respuestas simultáneas.
4. **Campos nuevos en el detalle** de la solicitud:
   - `customerNoticeMessage`: el aviso y su estado;
   - `customerNoticeError`: por qué no se pudo avisar. En ese caso también se agrega una nota `CRM:` en `comments`.

   Muestra una alerta «Avisar al cliente» cuando `customerNoticeError` no sea nulo.
5. **Samanta** ya no responde «pendiente de aprobación» a un «sí» tardío después de la decisión (`reservationOutcome: "ALREADY_DECIDED"`).

Detalle en [03 › Aviso al cliente de la decisión](03-clientes-reservas.md#aviso-al-cliente-de-la-decisión).

## Cambios del backend del 10/11/2026 (M9.2): respuestas del propietario por WhatsApp

Todavía sin commit. Requiere la migración `20261113000000_owner_whatsapp_replies`. Va encima de M9.1. No hay rutas nuevas.

1. **El propietario decide desde su WhatsApp.** Con los botones de la plantilla, o escribiendo ACEPTAR, RECHAZAR o PROPONER CAMBIO **con el código** de la solicitud:
   - Aceptar: `ACCEPTED` y una reserva `CONFIRMED`, con la misma lógica que `POST /reservation-requests/:id/approve`.
   - Rechazar: `REJECTED`, sin reserva.
   - Proponer cambio: `MODIFICATION_REQUESTED`. Su texto siguiente queda en `comments` como `CRM: propuesta del propietario…`, sin cambiar la fecha, las personas ni el servicio.

   El historial registra `actorType: "OWNER"` con el usuario `approvalResponsibleId`.
2. **Seguridad.** Solo cuenta el teléfono que informa Meta igual a `ownerWhatsappNumber`, y solo sobre solicitudes que se le enviaron a él. Un botón vale por el mensaje que responde. Un texto necesita el código o, desde el 11/11, citar con «Responder» el mensaje exacto de la solicitud (respuestas cortas `ACEPTO`, `RECHAZO` o `CAMBIO`); un «Acepto» sin código ni cita no decide nada. Respuestas ambiguas, códigos desconocidos o solicitudes ya resueltas no cambian nada y reciben una aclaración.
3. **Idempotencia.** Los webhooks repetidos y las respuestas simultáneas aplican una sola decisión, y hay como mucho una reserva por solicitud.
4. **Samanta** nunca contesta al propietario: sus mensajes se procesan antes que ella y su conversación se mantiene en pausa.
5. **Lo visible:**
   - el estado `MODIFICATION_REQUESTED` ahora se alcanza;
   - aparecen entradas `OWNER` en `statusHistory`;
   - en la conversación del propietario aparecen los textos de confirmación del backend.

   Desde M9.3 también se avisa al cliente (ver arriba).

Detalle en [03 › Respuestas del propietario](03-clientes-reservas.md#respuestas-del-propietario).

## Cambios del backend del 10/11/2026 (M9.1): envío de solicitudes al WhatsApp del propietario

Todavía sin commit. Requiere la migración `20261112000000_owner_whatsapp_approval` y, para activarlo, una plantilla aprobada en Meta y `OWNER_APPROVAL_ENABLED=true`. Va encima de M8.3. No hay rutas nuevas.

1. **Configuración.** `RestaurantConfig` trae `ownerWhatsappNumber` (E.164, distinto de `whatsappNumber`, o `null`). En `PUT /restaurant-config`, **omitirlo conserva el valor guardado** y `null` lo borra. Sin ese número o sin `approvalResponsibleId` (un OWNER), no se envía nada ([02](02-configuracion-catalogo.md)).
2. **Envío automático.**
   - Cada solicitud nueva de Samanta o de la web en `READY_TO_SEND` se envía **una vez** al WhatsApp del propietario, como plantilla con «Aceptar», «Rechazar» y «Proponer cambio», por el outbox con sus reintentos. Las creadas a mano no se envían.
   - La solicitud pasa a `SENT_TO_OWNER` al encolarse y a `WAITING_RESPONSE` solo cuando WhatsApp acepta el mensaje (`SENT`, `DELIVERED` o `READ`).
   - Si el mensaje falla o queda en duda, vuelve a `READY_TO_SEND` y no se reenvía. Cada paso queda en `statusHistory` con `actorType: "SYSTEM"`.
3. **Respuesta del propietario:** desde M9.2 se procesa sola (ver arriba). Una persona también puede aprobar o rechazar con las rutas de M8.3, que aceptan `SENT_TO_OWNER` y `WAITING_RESPONSE`. Esas solicitudes no admiten `PATCH` ni cancelar (409).
4. **Lecturas.**
   - El detalle de la solicitud trae `ownerMessage` (`{ id, status, errorCode, createdAt, sentAt, deliveredAt, providerReadAt }` o `null`).
   - En la Bandeja y en Clientes aparece el contacto «Propietario», con su conversación de WhatsApp y Samanta en pausa `MANUAL`. No le quites la pausa.

5. **Modo temporal por texto (11/11).** Mientras Meta revisa la plantilla, el servidor puede enviar la solicitud como un texto de WhatsApp (`OWNER_APPROVAL_TEXT_FALLBACK_ENABLED=true`), solo si el propietario escribió en las últimas 24 h. Para el frontend no cambia nada: los estados, `ownerMessage` y el historial son los mismos. `ownerMessage` no trae el nombre de la plantilla y el motivo del historial dice «texto temporal». Con la ventana cerrada, la solicitud sigue en `READY_TO_SEND` sin `ownerMessage` hasta que el propietario escriba. El propietario responde con «Responder» sobre el mensaje y `ACEPTO`, `RECHAZO` o `CAMBIO`, o escribe `ACEPTAR RES-…`, `RECHAZAR RES-…` o `CAMBIO RES-…`.

Detalle en [03 › Envío al WhatsApp del propietario](03-clientes-reservas.md#envío-al-whatsapp-del-propietario).

## Cambios del backend del 10/11/2026: aprobación manual de solicitudes

Todavía sin commit. **No requiere migración.** Va encima de M8.1 y M8.2.

1. **Rutas nuevas** (ADMIN y OWNER; OPERATOR y SUPPORT reciben 403):
   - `POST /reservation-requests/:id/approve`, sin body. En una transacción crea **una** reserva `CONFIRMED` en el calendario con los datos de la solicitud (cliente, fecha, personas, elemento, y `specialRequirements` → `notes`), con `reservationRequestId`, y pasa la solicitud a `ACCEPTED`. Responde 200 con `{ request, reservation }`.
   - `POST /reservation-requests/:id/reject`, con `{ "reason"?: string }` (1–1000). Pasa la solicitud a `REJECTED` sin crear reserva. Responde 200 con la solicitud.
   - Las dos dejan una entrada en `statusHistory` (`actorType: "USER"`, el usuario del token y, al rechazar, el motivo).
2. **Idempotencia y concurrencia.**
   - Aprobar otra vez devuelve la misma reserva, y rechazar otra vez no cambia nada.
   - Dos aprobaciones a la vez dejan una sola reserva: la base de datos admite una por solicitud.
   - Una rechazada no se aprueba y una aprobada no se rechaza (409). Para anular una aprobada, cancela su reserva en el calendario.
3. **Estados.**
   - Se aprueba desde `READY_TO_SEND` (y, con M9, desde `SENT_TO_OWNER` o `WAITING_RESPONSE`).
   - Se rechaza también desde `INCOMPLETE_DATA`.
   - Una incompleta o con la fecha pasada no se aprueba (409). Si el elemento comercial ya no está activo y aprobado, 400.
4. **Lecturas.**
   - El detalle de la solicitud trae `reservation` (`{ id, code, status, reservationAt }` o `null`).
   - `Reservation.reservationRequestId` ya no es siempre `null`: la etiqueta «Aceptada por el dueño» se puede mostrar.
5. **Caché.** Tras aprobar, invalida `qk.requestsAll`, `qk.reservationsAll` y `qk.statsAll`. Tras rechazar, `qk.requestsAll` y `qk.statsAll`.
6. **Sin cambios:** el aviso al cliente (hazlo por la Bandeja), el estado del cliente, la aprobación del dueño por WhatsApp (M9), la renegociación (M10), Samanta y el correo.

Detalle en [03 › Aprobar](03-clientes-reservas.md#aprobar-solicitud-de-reserva) y [03 › Rechazar](03-clientes-reservas.md#rechazar-solicitud-de-reserva); `endpoints.ts` y tipos en [05](05-implementacion-ft-crm.md).

## Cambios del backend del 10/11/2026 (M8.2): Samanta registra solicitudes

Todavía sin commit, y requiere la migración `20261111000000_samanta_reservation_requests`. Va encima de M8.1 (sección siguiente). No hay rutas nuevas.

1. **Samanta automática registra la solicitud** cuando el cliente confirma los datos, en lugar de pasar la conversación a una persona. Lo hace en dos pasos:
   - Primero envía un **resumen fijo** con fecha, hora, personas y, si los hay, servicio y requerimientos, y pide un «sí».
   - Si el cliente lo acepta de forma explícita, crea la solicitud: `READY_TO_SEND`, con el cliente de la conversación y `conversationId`, y `sourceChannel` = canal de la conversación. Luego le responde que quedó **registrada y pendiente de aprobación**.
   - Nunca dice que la reserva está confirmada y no crea reservas en el calendario.
   - Detalle, casos y textos en [04 › Solicitudes que registra Samanta](04-bandeja-samanta.md#solicitudes-que-registra-samanta).
2. **Validación en el backend, no en la IA.** Los datos se validan en la zona del restaurante (`America/Lima`):
   - la fecha debe ser real y futura;
   - personas de 1 en adelante;
   - el servicio debe ser un elemento activo y aprobado;
   - el cliente no debe tener ya una solicitud abierta para ese mismo momento.

   Un «sí» solo vale como respuesta a un resumen entregado, sin usar y de menos de 24 h. La solicitud se crea con los datos guardados de ese resumen. Un mensaje repetido o dos confirmaciones a la vez producen una sola solicitud.
3. **Ya no pausa al confirmar.** Siguen pasando a una persona los reclamos, la petición de hablar con alguien, las alergias, las cancelaciones o cambios de una reserva existente, los eventos privados, los pagos y un «sí» sin resumen previo (`NO_PROPOSAL`).
4. **Borradores.** `SamantaDraft` trae tres campos nuevos, `null` en los manuales y en los anteriores:
   - `reservationProposal`: el resumen enviado;
   - `reservationRequestId`: la solicitud creada a partir de ese resumen;
   - `reservationOutcome`: qué hizo la acción, p. ej. `PROPOSED`, `CREATED` o `PAST_DATE`.

   Cuando hay `reservationOutcome`, `content` es el texto fijo del backend y `originalContent` el de la IA. `promptVersion` pasa a `samanta-v4`, y el contexto de la IA trae `customer.awaitingConfirmation`.
5. **Solicitudes y clientes.**
   - Las solicitudes de Samanta llevan en `comments` la nota `CRM: registrada por Samanta…`.
   - El cliente pasa a `REQUESTED_RESERVATION` si estaba en `NEW`, `INTERESTED` o `IN_CONVERSATION`, igual que con la web.
   - Para mostrarlas en la Bandeja: `GET /reservation-requests?conversationId=…`.
6. **Sin cambios:** los borradores manuales (nunca registran solicitudes), el modo sombra (no registra nada), WhatsApp, Messenger, Instagram y el correo.
7. **Texto vacío de la IA (corrección del 10/11).** En un resumen o una confirmación, la IA a veces no escribe texto. Antes eso fallaba con `AI_INVALID_RESPONSE` y la conversación pasaba a una persona. Ahora se acepta: `originalContent` queda en `""` y `content` trae el texto fijo o uno de respaldo, nunca vacío. Sin esas acciones, un texto vacío sigue siendo `AI_INVALID_RESPONSE`.

## Cambios del backend del 10/11/2026: conversación e historial de las solicitudes

Todavía sin commit, y requiere la migración `20261110000000_reservation_request_history`. Es la primera parte del flujo de solicitudes (M8). Cambios compatibles: los campos nuevos son opcionales o llegan en `null`, y no hay rutas nuevas.

1. **Conversación vinculada.**
   - `ReservationRequest` trae el campo nuevo `conversationId` (`Uuid | null`): la conversación de la Bandeja a la que pertenece la solicitud, siempre del mismo cliente.
   - Se fija con `conversationId` en `POST` y `PATCH /reservation-requests` (`null` desvincula) y se filtra con `GET /reservation-requests?conversationId=…`.
   - Una conversación de otro cliente responde 400 `La conversación pertenece a otro cliente`; una que no existe, 404 `Conversación no encontrada`.
   - Las solicitudes existentes y las importadas de la web llegan con `null`. Las que registra Samanta (M8.2) la traen.
2. **Historial de estados.**
   - `GET /reservation-requests/:id` devuelve `ReservationRequestDetail`: la solicitud más `statusHistory`, una entrada por cada cambio de estado (`previousStatus`, `newStatus`, `actorType`, `actorId`, `reason`, `createdAt`, `actor`).
   - Las escrituras y el listado no lo traen. Después de editar o cancelar, **invalida** `qk.request(id)` en lugar de guardar la respuesta.
   - Hoy dejan entrada la edición que pasa entre `INCOMPLETE_DATA` y `READY_TO_SEND` y la cancelación, ambas con `actorType: "USER"`. Crear una solicitud, una edición que no cambia el estado y una cancelación repetida no dejan entrada.
   - `actorType` puede ser `USER`, `SAMANTA`, `OWNER` o `SYSTEM`; los tres últimos llegarán con el flujo del dueño.
   - Las solicitudes anteriores empiezan con el historial vacío.
3. **Motivo al cancelar.** `PATCH /reservation-requests/:id/status` acepta `reason` (opcional, 1–1000 caracteres), que queda en el historial.

Detalle en [03 › Ver detalle de solicitud de reserva](03-clientes-reservas.md#ver-detalle-de-solicitud-de-reserva) y [03 › `ReservationRequestStatusEntry`](03-clientes-reservas.md#reservationrequeststatusentry). Tipos y `endpoints.ts` actualizados en [05](05-implementacion-ft-crm.md).

## Cambios del backend del 9/11/2026: reservas de la web y plantillas de WhatsApp

En bk-crm desde el commit `7c5b1c7` («BK_Despliegue_v1», 8/11). No hay rutas nuevas.

1. **Solicitudes desde la web.**
   - El backend lee el correo «Nueva reserva SM-…» que envía el formulario de la web y crea el cliente y la solicitud solo.
   - `ReservationRequest` trae el campo nuevo `externalReference`, con el código de la web.
   - El formulario no es una prueba de identidad: nunca agrega un teléfono, un correo ni un nombre a un cliente existente. El cliente se reconoce por su WhatsApp (un número nacional se lee con el «País» del formulario) y, si no trae uno válido, por su correo. Si el correo ya es de otro cliente, se crea un cliente nuevo solo con el WhatsApp.
   - Lo que el equipo debe saber va en `comments`, en líneas que empiezan con `CRM: `: un WhatsApp sin validar, un correo del formulario que no quedó en el cliente (o que es de otro cliente), una fecha inválida y por qué no se le escribió. Una fecha, una hora o una cantidad de personas que no se entiende se copia tal cual y la solicitud queda en `INCOMPLETE_DATA`.
   - Un cliente nuevo de la web nace en `REQUESTED_RESERVATION`, y uno existente en `NEW`, `INTERESTED` o `IN_CONVERSATION` pasa a ese estado. Es el primer cambio automático del estado del cliente.
   - Detalle en [03 › Solicitudes que llegan de la web](03-clientes-reservas.md#solicitudes-que-llegan-de-la-web).
2. **WhatsApp al cliente de la web.** Si el correo llegó hace menos de 24 h (`WEB_RESERVATION_CONTACT_MAX_HOURS`), el backend le escribe como Samanta (`SAMANTA_USER_ID`) para continuar la conversación:
   - con un mensaje normal si la ventana de 24 h está abierta;
   - si no, con una plantilla aprobada en Meta: como mucho una cada 24 h por cliente y hasta `WEB_RESERVATION_DAILY_LIMIT` al día. Si el cliente no tenía conversación de WhatsApp, se crea con ese saliente.

   No le escribe si su conversación la atiende una persona (pausa manual o de las últimas 24 h), si el cliente está escribiendo en ese momento, si a la plantilla le faltan la fecha, la hora o las personas, si se alcanzó el tope diario, si WhatsApp está apagado o si el número no es válido. En cada caso, la solicitud lleva la nota `CRM: no se le escribió por WhatsApp: <motivo>.` con el texto exacto de [03](03-clientes-reservas.md#solicitudes-que-llegan-de-la-web).
3. **Plantillas en el historial.** `Message` trae el campo nuevo `templateName`: el nombre de la plantilla con que salió el mensaje, o `null`. El texto de `content` es la versión del CRM de esa plantilla. Una plantilla que pasa más de 6 h en cola sin poder enviarse termina `FAILED` con el código nuevo `WHATSAPP_TEMPLATE_EXPIRED`, en lugar de llegar tarde.
4. **Botones.** Un toque del cliente en un botón (de plantilla o interactivo) llega como `INBOUND` `TEXT` con el texto del botón. Antes llegaba como `OTHER` («no compatible»). Samanta lo responde como cualquier mensaje.
5. **Contexto de Samanta.** La IA recibe además las solicitudes abiertas del cliente (`customer.pendingReservations`) y sus próximas reservas confirmadas (`customer.upcomingReservations`): con una solicitud de la web, la menciona por su código y no vuelve a pedir los datos. De las solicitudes `WEBSITE` abiertas también recibe `comments` y `specialRequirements`, sin las líneas `CRM: ` y sin enlaces, correos ni teléfonos: una nota interna en esos campos debe empezar con `CRM: `. `promptVersion` pasa a `samanta-v3`. Detalle en [04 › Generar](04-bandeja-samanta.md#generar-un-borrador-con-samanta).

## Cambios del backend del 8/11/2026: Samanta automática

Todavía sin commit. Detalle en [04 › Samanta automática](04-bandeja-samanta.md#samanta-automática).

1. **Samanta responde sola** cuando el servidor tiene `SAMANTA_AUTO_ENABLED=true`. No hay rutas nuevas:
   - Sus respuestas llegan al historial como `OUTBOUND` con `authorUserId` = `SAMANTA_USER_ID` (`00000000-0000-4000-8000-00000000a0a1`), un usuario de sistema inactivo que no aparece en `GET /users`.
   - Cada respuesta deja un borrador `mode: "AUTO"` (estados `SCHEDULED` → `GENERATING` → `APPROVED`).
   - En modo sombra, el borrador queda `READY` para revisión.
2. **Pausa con motivo:** `Conversation` trae `assistantPauseReason` (`MANUAL`, `OPERATOR_REPLIED`, `SAMANTA_HANDOFF`) y `assistantPausedAt`.
   - Con el modo automático activo, enviar un mensaje a mano pausa a Samanta en esa conversación (`OPERATOR_REPLIED`).
   - Samanta se pausa sola al transferir a una persona (`SAMANTA_HANDOFF`).
3. **`SamantaDraft`:** campos nuevos `mode`, `availableAt` y `generationStartedAt`. `generationExpiresAt` admite `null`, y `promptVersion` pasa a `samanta-v2` (`samanta-v3` desde el 9/11).
4. **Generar borradores:**
   - Funciona también en Messenger e Instagram; desaparece el 400 `Samanta v1 admite WhatsApp`.
   - Con la ventana de 24 h cerrada, el canal apagado o sin destinatario, responde el mismo error que enviar (409, 503 o 400) sin llamar a la IA.
   - Las reacciones, stickers y audios ya no invalidan un borrador ni impiden generar.
   - Un borrador en `GENERATING` ya no pasa a `STALE` por consultarlo: lo decide el final de la generación.
5. **Códigos de error nuevos** de los borradores `FAILED`:
   - de OpenAI: `AI_QUOTA_EXCEEDED` (sin saldo o cuota), `AI_AUTH_FAILED` y `AI_MODEL_NOT_FOUND`;
   - un 5xx de OpenAI pasa de `AI_REQUEST_REJECTED` a `AI_UNAVAILABLE`;
   - solo de los automáticos: `AUTO_*` y `AI_CONTEXT_UNAVAILABLE`.
6. **Límite diario:** cuenta las generaciones por `generationStartedAt`, no los borradores creados. Una respuesta automática descartada antes de generarse no consume cuota.

## Cambios recientes del backend (3/11/2026)

Respecto de los contratos anteriores (`ft-crm/docs/backend/`), el backend ya incluye:

1. **Nombre automático en Messenger.**
   - Cuando llega un mensaje de un cliente de Messenger sin `firstName` ni `lastName`, el backend pide a Meta el nombre del remitente y lo guarda completo en `firstName` (hasta 100 caracteres); `lastName` queda en `null`.
   - Nunca sobrescribe un nombre puesto en el CRM. Los clientes que ya existían lo reciben con su siguiente mensaje.
   - Ignora los nombres genéricos («Facebook User», «Usuario de Facebook») y consulta como máximo 3 nombres por webhook. Si Meta no da el nombre o la consulta falla, sigue en `null` y se reintenta con el siguiente mensaje: mantén el texto de respaldo.
   - Si alguien borra los dos nombres en el CRM, el siguiente mensaje del cliente puede volver a llenarlos.
2. **Envío unificado por canal.**
   - Messenger (canal `FACEBOOK`) también envía: tope de 2000 caracteres, ventana de 24 h y códigos de error `MESSENGER_*`.
   - Con el canal apagado, el envío responde 503 `WhatsApp no está habilitado`, `Messenger no está habilitado` o, desde el 4/11, `Instagram no está habilitado`. Instagram encendido sin `INSTAGRAM_ACCESS_TOKEN` responde 503 `El envío por Instagram no está configurado`. Se comprueba antes que la longitud: con Messenger apagado, un texto de 2001 caracteres da 503.
   - Una conversación de un canal sin envío (`WEBSITE`, `PHONE`, `EMAIL`, `OTHER`) responde 400 `Conversación sin destinatario habilitado`. Es el mismo mensaje que cuando el cliente no tiene un destinatario válido. Desde el 4/11 (commit `eca059b`), `INSTAGRAM` sí envía: tope de 1000 caracteres y 1000 bytes UTF-8, ventana de 24 h y códigos `INSTAGRAM_*`.
   - Cada canal mide su límite con `content.length`: 400 `WhatsApp admite hasta 4096 caracteres por respuesta`, `Messenger admite hasta 2000 caracteres por respuesta` o `Instagram admite hasta 1000 caracteres por respuesta`. Instagram mide además los bytes UTF-8: 400 `Instagram admite hasta 1000 bytes por respuesta; las tildes y los emojis ocupan más de uno`.
   - Cuando Meta responde con un error HTTP (4xx, 429 o 5xx), bk-crm deja en sus logs un diagnóstico (`WHATSAPP_SEND_HTTP_ERROR`, `MESSENGER_SEND_HTTP_ERROR` o `INSTAGRAM_SEND_HTTP_ERROR`) con el código HTTP y el de Meta. Un timeout o un error de red no lo dejan. La API no cambia: el mensaje sigue llegando con su `errorCode`.
3. **Fechas en UTC dentro de la base de datos.** Es una corrección interna: la API ya devolvía los instantes correctos y su formato no cambia. bk-crm no arranca si falta la migración `20261103000000_utc_timestamps` o si la sesión de PostgreSQL no queda en UTC.
4. **Errores corregidos:**
   - un PATCH vacío en el catálogo responde 400 `Debes proporcionar al menos un campo para actualizar`, antes de comprobar si el recurso existe;
   - `null` en `PATCH /users/:id` responde 400;
   - un body de más de 100 kb responde 413 `El cuerpo de la petición supera el tamaño máximo permitido`, y un `charset` que no empieza por `utf-`, 415 (antes, los dos respondían 500);
   - el orden del catálogo es estable entre páginas;
   - las fechas de promociones y eventos (`validFrom`, `validUntil`, `startAt` y `endAt`) exigen segundos y zona horaria.
5. **Límites de intentos por IP y cuenta** en login (nuevo: 5 cada 60 s), `forgot-password` (3 cada 60 s) y `reset-password` (5 cada 60 s). La variable nueva `TRUST_PROXY` hace que bk-crm tome la IP de `X-Forwarded-For` detrás de un proxy inverso de confianza; con el BFF, la IP contada sigue siendo la del servidor de Next.js (ver [Rate limiting](#rate-limiting)).
6. **Validación de la configuración de producción.** Con `NODE_ENV=production`, bk-crm no arranca si:
   - `JWT_SECRET` o `JWT_REFRESH_SECRET` tienen menos de 32 caracteres, empiezan por `reemplazar` (el valor del ejemplo) o son iguales;
   - `FRONTEND_RESET_PASSWORD_URL` no es una URL `https` o apunta a `localhost`, `127.0.0.1` o `[::1]`;
   - `RESEND_FROM_EMAIL` falta o usa un remitente `@resend.dev`.

En ft-crm, los ajustes del BFF que acompañan estos cambios (techo de 65 s para generar borradores y texto del 429 del login) están en [Ya ajustado en ft-crm](#ya-ajustado-en-ft-crm-pendiente-de-commit).

## Correcciones respecto de la versión anterior

Para quien ya empezó a implementar con la versión anterior de esta carpeta. Solo se listan las correcciones que cambian lo que tiene que hacer el frontend. No están las de redacción ni lo que es contenido nuevo (el [05](05-implementacion-ft-crm.md), las filas **ft-crm** y **Caché**, los ejemplos de petición). Cada fila se comprobó en el código actual de bk-crm y ft-crm.

**Bandeja: respuestas por Instagram (corrección del 8/11/2026)**

Esta carpeta decía que Instagram solo recibe mensajes. bk-crm responde en Instagram desde el 4/11 (commit `eca059b`, «Instagram: respuestas desde el CRM»), y ft-crm, que seguía estos textos, tenía el editor bloqueado en Instagram. El contrato completo está en [04 › Enviar un mensaje de texto](04-bandeja-samanta.md#enviar-un-mensaje-de-texto).

| Dónde | Antes decía | Lo correcto |
|---|---|---|
| [Enviar un mensaje de texto](04-bandeja-samanta.md#enviar-un-mensaje-de-texto), [Bandeja y envío de mensajes](#bandeja-y-envío-de-mensajes) y [Cambios del 3/11](#cambios-recientes-del-backend-3112026) | `INSTAGRAM` es un canal sin envío: 400 `Conversación sin destinatario habilitado`. Solo responden `WHATSAPP` y `FACEBOOK`. | `POST /conversations/:id/messages` en una conversación `INSTAGRAM` responde 202, igual que en WhatsApp y Messenger. Sin envío quedan `WEBSITE`, `PHONE`, `EMAIL` y `OTHER`. El editor no debe exigir `customer.phone` en Instagram: el backend resuelve el destinatario (IGSID), que no se expone. |
| Tope de `content` en Instagram | — (no tenía envío) | `content.length` ≤ 1000 **y** como máximo 1000 bytes UTF-8 (`new TextEncoder().encode(texto).length`): una tilde ocupa 2 bytes y un emoji, 4. Se comprueban en ese orden: 400 `Instagram admite hasta 1000 caracteres por respuesta` y 400 `Instagram admite hasta 1000 bytes por respuesta; las tildes y los emojis ocupan más de uno`. |
| Canal apagado ([Errores comunes](04-bandeja-samanta.md#errores-comunes-a-todas-las-rutas)) | 503 `WhatsApp no está habilitado` o `Messenger no está habilitado`. | También 503 `Instagram no está habilitado` (`INSTAGRAM_ENABLED` no es `true`) y 503 `El envío por Instagram no está configurado` (Instagram encendido sin `INSTAGRAM_ACCESS_TOKEN`: recibe, pero no responde). Llegan sin `code`: son una función apagada, no falta de conexión. Se comprueban antes que la longitud. |
| Destinatario y ventana de 24 h | Solo los textos de WhatsApp y Messenger. | 400 `Conversación sin destinatario habilitado` si el cliente no es una identidad (IGSID) de la cuenta configurada en `INSTAGRAM_ACCOUNT_ID`, y 409 `Ventana de Instagram cerrada; el cliente debe enviar un nuevo mensaje` si no hay un `INBOUND` del cliente en las últimas 24 h. |
| [Estados y `errorCode` de los salientes](04-bandeja-samanta.md#mensajes-salientes-direction-outbound) | Prefijos `WHATSAPP_` y `MESSENGER_`; `DELIVERED` en todos los canales. | También `INSTAGRAM_RATE_LIMITED`, `INSTAGRAM_SEND_UNKNOWN`, `INSTAGRAM_SEND_INVALID`, `INSTAGRAM_WINDOW_CLOSED` e `INSTAGRAM_SEND_REJECTED`. Instagram nunca llega a `DELIVERED` ni a `READ`: `SENT` («Enviado») es su último estado, y `INSTAGRAM_DELIVERY_FAILED` no se produce. |
| Entrega en Instagram | — | Con acceso estándar a la API, Meta solo entrega a cuentas que tienen un rol en la app de Meta. Con cualquier otra cuenta, el POST responde 202, pero el mensaje termina `FAILED` con `INSTAGRAM_SEND_REJECTED`. |
| Samanta en Instagram: [Generar](04-bandeja-samanta.md#generar-un-borrador-con-samanta) y [Aprobar](04-bandeja-samanta.md#aprobar-un-borrador-y-encolar-el-envío) | Aprobar responde 503 `WhatsApp no está habilitado` y los 400 y 409 de WhatsApp. | Generar y aprobar hacen las comprobaciones de Instagram del envío. La IA recibe un tope de 800 caracteres en Instagram, pero no lo garantiza: aprobar un borrador de más de 1000 caracteres o 1000 bytes responde 400 y el borrador sigue `READY`. En el modo automático, ese caso termina `FAILED` con `AUTO_SEND_REJECTED`. |
| [Editar cliente](03-clientes-reservas.md#editar-cliente) | 400 `No se puede cambiar el canal de una identidad de Messenger`. | El texto exacto es `No se puede cambiar el canal de una identidad del proveedor`, y vale para los clientes que crearon los webhooks de Messenger e Instagram. |
| [Plan de ft-crm](05-implementacion-ft-crm.md#bandeja) | `SENDABLE_CHANNELS` sin `INSTAGRAM`; el editor de Instagram, bloqueado. | Ya aplicado en ft-crm (commit `28ba0ed`, 8/11): `SENDABLE_CHANNELS` incluye `INSTAGRAM`, `OUTBOUND_TEXT_MAX_BYTES = { INSTAGRAM: 1000 }`, contador en bytes en el Composer y en el borrador, textos de Instagram, y el panel de Samanta en WhatsApp, Messenger e Instagram. |

**Sesión, BFF y errores**

| Dónde | Antes decía | Lo correcto |
|---|---|---|
| Errores 401 de todas las rutas autenticadas ([Sesión](#sesión-srclibserversessionts)) | Los 401 de bk-crm (`Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado`, `Sesión no válida o expirada`), como si los recibiera el frontend. | El navegador nunca los recibe. El BFF renueva la sesión y repite la llamada una vez. Si no puede, responde 401 `Tu sesión terminó. Vuelve a iniciar sesión.` (`code: "SESSION_EXPIRED"`) y borra las cookies, o 401 `Inicia sesión para continuar.` (`code: "NO_SESSION"`) si no hay cookies. No muestres el texto: `apiFetch` emite `crm:session-expired` y `SessionProvider` lleva a `/login`. |
| Cómo se llama cada ruta de [01](01-auth-usuarios.md) | «Desde el navegador, cada ruta se pide como `/api/backend<ruta>`». | Solo `GET /auth/me` y `/users/**` van por `/api/backend`. Login, logout y recuperación de contraseña van por `/api/auth/*` con `sessionApi`; el refresh lo hace el BFF; la salud se consulta con `/api/listo`; `GET /` y `GET /auth/test-admin` no se usan. |
| [Iniciar sesión](01-auth-usuarios.md#iniciar-sesión) | Respuesta 201 con `accessToken` y `refreshToken`: «Hay que guardar» los dos. Errores de bk-crm (400 en array, 401 y 429 con `Retry-After`). | `sessionApi.login` recibe 200 `{ user }`. Los tokens quedan en las cookies httpOnly `crm_at` y `crm_rt`: el navegador nunca los ve. Los errores son los del BFF, ya en español: 400 `Ingresa un correo válido y una contraseña de al menos 8 caracteres.`, 401 `Correo o contraseña incorrectos.` y 429 `Hiciste demasiados intentos. Espera un minuto e inténtalo otra vez.`, sin `Retry-After`. |
| [Renovar tokens](01-auth-usuarios.md#renovar-tokens) | «Hay que reemplazar ambos tokens guardados» y mantener un solo refresh en curso. | El navegador no llama a esta ruta: `/api/backend/auth/refresh` responde 404 `Ruta no disponible.`. El BFF renueva solo, antes de que venza `crm_at` o tras un 401, y deduplica los refresh simultáneos. |
| [Cerrar sesión](01-auth-usuarios.md#cerrar-sesión) | «Hay que borrar ambos [tokens] en el cliente». | Llama a `sessionApi.logout()`. El BFF intenta revocar la sesión en bk-crm, borra las cookies y responde siempre 200 `{ ok: true }`, aunque bk-crm falle. |
| [Solicitar recuperación de contraseña](01-auth-usuarios.md#solicitar-recuperación-de-contraseña) y [Restablecer contraseña](01-auth-usuarios.md#restablecer-contraseña) | Mostrar «tal cual» el mensaje de bk-crm; solo errores de bk-crm. | El navegador recibe los textos del BFF, con punto final: `Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.` y `Contraseña restablecida correctamente.`. Sus errores: 400 `Ingresa un correo válido.`, 400 `El enlace no es válido o la contraseña no cumple el largo (8 a 72 caracteres).`, 400 `El enlace de recuperación es inválido o ha expirado. Solicita uno nuevo.`, 429 `Hiciste demasiados intentos. Espera un minuto e inténtalo otra vez.` y 502. |
| [Comprobar el estado del servicio](01-auth-usuarios.md#comprobar-el-estado-del-servicio) | `GET /health` «sirve para un indicador de conexión». | Desde el navegador, consulta `/api/listo` con `fetch` (no con `apiFetch`, que antepone `/api/backend`): 200 `{ estado: "ok", backend }` o 503. `/api/backend/health` exige sesión. |
| Mensajes de validación ([Errores de validación por campo](05-implementacion-ft-crm.md#42-errores-de-validación-por-campo)) | «Los de validación vienen en inglés: conviértelos en errores de campo». | Vienen en inglés, salvo los de validadores propios de bk-crm, que llegan en español (p. ej. `whatsappNumber debe usar formato internacional E.164`). No todos empiezan por el campo: `each value in …`, `All …'s elements must be unique` y `property … should not exist` lo nombran dentro. |
| Tipos TypeScript de [01](01-auth-usuarios.md#tipos-typescript) a [04](04-bandeja-samanta.md#tipos-typescript) | Nombres propios: `IsoDateString`, `IsoDateTimeUtc`, `PaginatedResponse`, `CustomerPage`, `ApiHttpError`, `ApiErrorResponse`, `AuthenticatedUser`, `RefreshTokenRequest`, `TimeHHmm`, `ConversationListQuery`, `SendMessageBody`… | Los de `ft-crm/src/lib/api/types.ts`: `IsoDateTime`, `Paginated<T>`, `ApiErrorBody`, `MeResponse`, `RefreshRequest`, `HhMm`, `ListConversationsQuery`, `SendMessageRequest`… `ApiErrorBody` es igual en todos los módulos: `code?: BffErrorCode`, más `path`, `method` y `timestamp` del 500. Copia los tipos de [`types.ts`](05-implementacion-ft-crm.md#22-typests) en el 05. |

**Usuarios**

| Dónde | Antes decía | Lo correcto |
|---|---|---|
| [Editar los datos de un usuario](01-auth-usuarios.md#editar-los-datos-de-un-usuario) | Refrescar el detalle, el listado y, si es el propio usuario, `GET /auth/me`. | Además, invalida `qk.conversationsAll` y `qk.reservationsAll` si cambió el nombre (va embebido en `assignedUser`, `author` y `changedBy`), y `qk.config` si cambió el nombre o el email (`approvalResponsible`). |
| [Activar o desactivar un usuario](01-auth-usuarios.md#activar-o-desactivar-un-usuario) y [Reemplazar los roles de un usuario](01-auth-usuarios.md#reemplazar-los-roles-de-un-usuario) | Refrescar solo el listado y el detalle. | Desactivar a un usuario, o quitarle ADMIN y OPERATOR, no libera sus conversaciones ni sus reservas: su `assignedUser.isEligible` pasa a `false`. Invalida `qk.conversationsAll` y `qk.reservationsAll`. Si es el responsable de aprobación, después `PUT /restaurant-config` responde 400 `El responsable de aprobación debe estar activo` o `El responsable de aprobación debe tener el rol OWNER`: avísalo antes de confirmar. |

**Configuración y catálogo**

| Dónde | Antes decía | Lo correcto |
|---|---|---|
| [Guardar la configuración del restaurante](02-configuracion-catalogo.md#guardar-la-configuración-del-restaurante-crear-o-reemplazar) · `email` | «Email válido. Máx. 320». | `@IsEmail()` rechaza más de 254 caracteres, o más de 64 antes de la `@`, con `email must be an email`. Limita el campo a 254 en el formulario. |
| [Guardar la configuración del restaurante](02-configuracion-catalogo.md#guardar-la-configuración-del-restaurante-crear-o-reemplazar) · `latitude` y `longitude` | Ningún 500. | Una coordenada distinta de 0 que JavaScript escribe en notación exponencial sin punto (`1e-7`) responde 500 `Ocurrió un error interno`. Redondea a 7 decimales y deja en 0 los valores menores que 0,000001, como hace `normalizeCoordinate` de ft-crm. |
| [Crear categoría comercial](02-configuracion-catalogo.md#crear-categoría-comercial), [Editar categoría comercial](02-configuracion-catalogo.md#editar-categoría-comercial), [Crear elemento comercial](02-configuracion-catalogo.md#crear-elemento-comercial) y [Editar elemento comercial](02-configuracion-catalogo.md#editar-elemento-comercial) | 400 `Los datos de la categoría son inválidos` o `La operación contiene referencias o valores comerciales inválidos` cuando la base de datos rechaza una restricción (Prisma `P2004`). | Prisma 7 no emite `P2004`: esos 400 no llegan por ese motivo. Una restricción `CHECK` rechazada responde 500 `Ocurrió un error interno`, por ejemplo con un nombre formado solo por signos diacríticos sueltos (`^`, `´`). Exige en el formulario al menos una letra o un número. |

**Clientes, reservas y Bandeja**

| Dónde | Antes decía | Lo correcto |
|---|---|---|
| Clientes de Messenger: [Listar conversaciones](04-bandeja-samanta.md#listar-conversaciones-bandeja) y [Listar solicitudes de reserva](03-clientes-reservas.md#listar-solicitudes-de-reserva) | «Los de Messenger no traen nombre, teléfono ni email… `search` no los encuentra hasta que alguien los edite en Clientes»; «pueden aparecer con `customer` todo en `null` salvo `id`». | Con cada mensaje nuevo de un cliente de Messenger sin `firstName` ni `lastName`, bk-crm pide a Meta su nombre y lo guarda completo en `firstName` (`lastName` queda en `null`), así que `search` lo encuentra. Nunca pisa un nombre puesto en el CRM. Si Meta no lo da, sigue en `null` y se reintenta con el siguiente mensaje: mantén el respaldo «Cliente de Messenger». `phone` y `email` llegan en `null` salvo que se agreguen en Clientes. |
| [Reprogramar reserva](03-clientes-reservas.md#reprogramar-reserva) y [Lo que ya coincide](#lo-que-ya-coincide) | «Marcar como preparada» (`UPCOMING`) «no tiene vuelta atrás». | No hay transición directa `UPCOMING → CONFIRMED` (409), pero cambiar la fecha de una reserva `UPCOMING` (reprogramarla, o `PATCH` con otro `reservationAt`) la deja en `RESCHEDULED`, y desde ahí puede volver a `CONFIRMED`. Ajusta el «No se puede deshacer» de la confirmación. |
| [`SamantaDraft`](04-bandeja-samanta.md#samantadraft) | `originalContent` en `null` si el borrador «quedó STALE durante la generación»; `intent`, `requiresHuman` y `missingFields` «pueden venir también en STALE/FAILED si la IA respondió tarde». | Si al terminar la generación cambió la información comercial, el borrador queda `STALE` con el texto y los datos de la IA guardados. Si quedó `STALE` por un mensaje nuevo, una pausa o el vencimiento, o `FAILED`, solo guarda los tokens: `originalContent` y `content` en `null`, `intent` en `null`, `requiresHuman` en `true` y `missingFields` vacío. |
| [Mensajes salientes](04-bandeja-samanta.md#mensajes-salientes-direction-outbound) | `*_RATE_LIMITED` solo en `QUEUED` («Reintentando…»). | También llega en `SENDING`: el worker no borra `errorCode` al reintentar, y `SENT` lo borra. Muestra «Reintentando…» en los dos estados. `outboundStatusView` ya lo hace en los tres canales: `outboundErrorKind` quita el prefijo `WHATSAPP_`, `MESSENGER_` o `INSTAGRAM_`. |

**Plan de cambios en ft-crm**

| Dónde | Antes decía | Lo correcto |
|---|---|---|
| [Cambios necesarios](#cambios-necesarios-por-prioridad) · Messenger | Añadir un texto para el 503 `Messenger no está habilitado`. | `sendErrorText` ya muestra ese 503, y el 400 de longitud, con el texto del backend. Lo que hay que cambiar son los textos de ventana cerrada y de destinatario, que siempre hablan de WhatsApp: elígelos según `conversation.channel`. |
| [Cambios necesarios](#cambios-necesarios-por-prioridad) · Samanta | Cruzar `outboundMessageId` con los borradores `APPROVED` para marcar los mensajes de Samanta. | Sigue valiendo, pero la lista trae solo los 50 borradores más recientes: un mensaje aprobado desde uno más antiguo se verá como de quien lo aprobó. |
| [Cambios necesarios](#cambios-necesarios-por-prioridad) · Autor de los mensajes | Mostrar «Tú» o «Equipo». | Conserva `outboundAuthorLabel`: «Tú» si el autor es el usuario de `GET /auth/me`, el nombre del responsable si él escribió el mensaje y, si no, un texto genérico (hoy «Operador»). Quita solo la regla «`OUTBOUND` sin autor = Samanta». |
| [Lo que ya coincide](#lo-que-ya-coincide) | Ninguna llamada de ft-crm envía parámetros que bk-crm rechace. | Solicitudes pasa la `pagina` de la URL sin tope ni redondeo: una página mayor que 1 000 000 o con decimales responde 400. Usa `parsePage` de `clientes-utils.ts` ([Solicitudes](05-implementacion-ft-crm.md#solicitudes)). |

## Preguntas abiertas

Consolidadas de los cuatro módulos, sin repetir y ordenadas por cuánto afectan al frontend. Cada una enlaza a la pregunta completa, con su contexto: [01](01-auth-usuarios.md#preguntas-abiertas), [02](02-configuracion-catalogo.md#preguntas-abiertas), [03](03-clientes-reservas.md#preguntas-abiertas) y [04](04-bandeja-samanta.md#preguntas-abiertas).

**Bloquean pantallas o textos del modo live**

1. **Flujo del dueño.** ¿Cuándo llegan los endpoints para enviar, aceptar o rechazar solicitudes y convertirlas en reservas? Hoy `reservationRequestId` siempre es `null`, seis estados de solicitud son inalcanzables y Samanta no crea solicitudes. ¿Deben aparecer ya en filtros y KPI? ([03](03-clientes-reservas.md#preguntas-abiertas), pregunta 3)
2. **Capacidades del servidor.** El frontend solo se entera de que WhatsApp, Messenger, Instagram o Samanta están apagados (o de que Instagram no tiene token de envío) por el 503 al usarlos, y no puede consultar cuántas generaciones de Samanta quedan. ¿Habrá un endpoint de capacidades y de cuota? ([04](04-bandeja-samanta.md#preguntas-abiertas), preguntas 11 y 12)
3. **Nombres de los autores.** `GET /users` es solo para ADMIN, así que OWNER y OPERATOR no pueden convertir en un nombre el `authorUserId` de los mensajes ni el `createdById`, `reviewedById` y `editedById` de los borradores de Samanta. Las notas y reprogramaciones de reservas ya traen el nombre (`author` y `changedBy`). ¿Se añadirá el nombre a la respuesta o un endpoint ligero de usuarios? ([01](01-auth-usuarios.md#preguntas-abiertas), pregunta 12; [04](04-bandeja-samanta.md#preguntas-abiertas), pregunta 2)
4. ~~**Samanta en Messenger.**~~ Resuelta el 8/11: Samanta atiende en WhatsApp, Messenger e Instagram ([04](04-bandeja-samanta.md#preguntas-abiertas), pregunta 8).
5. **Identidad del proveedor en el cliente.** La respuesta no dice si un cliente `FACEBOOK` o `INSTAGRAM` es una identidad de Messenger o de Instagram, y cambiarle el canal responde 400 `No se puede cambiar el canal de una identidad del proveedor`. ¿Se añadirá un indicador (p. ej. `hasProviderIdentity`)? ([03](03-clientes-reservas.md#preguntas-abiertas), pregunta 1)
6. **Imágenes, logo y adjuntos.** No hay endpoint de subida (solo URLs `http(s)` ya alojadas) ni para descargar o previsualizar los adjuntos de los mensajes. ¿Dónde se alojarán las imágenes? ¿Habrá un proxy de medios? ([02](02-configuracion-catalogo.md#preguntas-abiertas), pregunta 1; [04](04-bandeja-samanta.md#preguntas-abiertas), pregunta 1)

**Mejoras de la API que simplificarían la UI**

7. **Bandeja.** Vista previa del último mensaje en `GET /conversations`, vencimiento de la ventana de 24 h, filtro de conversaciones sin asignar y `GET /conversations/:id/messages/:messageId`. ([04](04-bandeja-samanta.md#preguntas-abiertas), preguntas 3, 4, 5 y 7)
8. **Clientes y calendario.** Número de reservas y último interés en `GET /customers`; consulta del calendario sin paginar y filtro de reservas sin responsable. ([03](03-clientes-reservas.md#preguntas-abiertas), preguntas 4 y 10)
9. **Tiempo real.** ¿Son aceptables los intervalos de polling actuales (6 s la lista, 4 s el chat, 1,5 s con envíos pendientes, 2–3 s para un borrador en `GENERATING`)? ¿Habrá WebSockets o SSE? ([04](04-bandeja-samanta.md#preguntas-abiertas), pregunta 6)
10. **Mensajes de validación.** Llegan en inglés y en un array. ¿Los personalizará el backend, o los traduce siempre el frontend? ([03](03-clientes-reservas.md#preguntas-abiertas), pregunta 5)
11. **Idempotencia.** `POST /reservation-requests`, `POST /reservations` y `POST /reservations/:id/notes` duplican si se reintentan tras un 504. ¿Se añadirá `Idempotency-Key`? ([03](03-clientes-reservas.md#preguntas-abiertas), pregunta 8)
12. **Búsqueda.** No admite el nombre completo; en solicitudes y reservas no busca por email; cualquier dígito del texto se busca en los teléfonos («Mesa 4»); en el catálogo distingue tildes. ¿Se mejorará? ([03](03-clientes-reservas.md#preguntas-abiertas), pregunta 9; [04](04-bandeja-samanta.md#preguntas-abiertas), pregunta 14; [02](02-configuracion-catalogo.md#preguntas-abiertas), pregunta 3)
13. **Estados de los mensajes.** Los mensajes `UNKNOWN` no se pueden resolver ni reintentar. Messenger ignora los eventos de lectura (nunca pasa de `DELIVERED`), e Instagram ignora todos los recibos (nunca pasa de `SENT`). ([04](04-bandeja-samanta.md#preguntas-abiertas), preguntas 9 y 10)
14. **Nombre en WhatsApp.** ¿Se tomará el nombre del perfil de WhatsApp para los clientes nuevos, como en Messenger? ([04](04-bandeja-samanta.md#preguntas-abiertas), pregunta 13)
15. **Estadísticas.** `GET /reservation-requests` solo filtra por `reservationAt`, así que Estadísticas cuenta las solicitudes por fecha de reserva y omite las que no tienen fecha. ¿Hace falta un filtro por `createdAt`, o endpoints de agregados? ([03](03-clientes-reservas.md#preguntas-abiertas), pregunta 12)

**Reglas de negocio por definir**

16. **Usuarios desactivados o sin roles operativos.** No liberan sus conversaciones ni reservas (`isEligible: false`). ¿Quién las reasigna? Y si el desactivado es el responsable de aprobación, `PUT /restaurant-config` responde 400: ¿la UI debe advertirlo o impedirlo? ([01](01-auth-usuarios.md#preguntas-abiertas), preguntas 10 y 11)
17. **Estado comercial del cliente.** El backend acepta cualquier transición y no lo cambia solo, salvo con las reservas de la web, que lo pasan a `REQUESTED_RESERVATION` (desde el 9/11). ¿Qué flujo debe imponer la UI? ([03](03-clientes-reservas.md#preguntas-abiertas), pregunta 2)
18. **Clientes duplicados y cambio de teléfono.** No hay fusión de clientes, y cambiar el teléfono de un cliente de WhatsApp cambia el destinatario de las respuestas. ¿Se impedirá o se avisará? ([03](03-clientes-reservas.md#preguntas-abiertas), preguntas 6 y 7)
19. **Catálogo.**
    - Las categorías inactivas ocultan sus elementos a Samanta, pero solicitudes y reservas los siguen aceptando.
    - Samanta recibe como máximo 30 elementos sin indicar cuáles.
    - Varios campos de la configuración se guardan sin que ningún proceso los use.
    - No hay auditoría de aprobaciones, control de versión ni `DELETE`.
    - Una coordenada distinta de 0, menor que 0,000001 en valor absoluto y que JavaScript escribe sin punto decimal (`1e-7`), da 500.
    - Un nombre formado solo por signos diacríticos sueltos (`^`, `´`) pasa la validación y da 500.

    ([02](02-configuracion-catalogo.md#preguntas-abiertas), preguntas 2 y 4 a 10)
20. **Rol SUPPORT.** Solo puede usar `/auth/me` y el logout, y en ft-crm no tiene ninguna vista. ¿Es intencional? ([01](01-auth-usuarios.md#preguntas-abiertas), pregunta 9)
21. **Cuentas y sesiones.**
    - `GET /users` no tiene paginación ni búsqueda.
    - No hay endpoint de roles, cambio de contraseña con la sesión abierta, restablecimiento por un ADMIN, gestión de sesiones ni invitaciones por correo.
    - Reutilizar un refresh token ya rotado no revoca la sesión.
    - Las contraseñas admiten 72 caracteres, pero bcrypt solo usa los primeros 72 bytes en UTF-8: con tildes, `ñ` o emojis, el final de una contraseña larga se ignora. ¿Límite en bytes o aviso en la UI?

    ([01](01-auth-usuarios.md#preguntas-abiertas), preguntas 5 a 8 y 13)

**Despliegue**

22. URL de bk-crm en cada entorno (y si un proxy añadirá un prefijo como `/api`), valor de `FRONTEND_RESET_PASSWORD_URL` y de `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` (en `.env.example`, 15 min y 7 días; la sesión vence a los 7 días del login aunque se renueve). ¿Se quitará `GET /auth/test-admin` antes de desplegar? ([01](01-auth-usuarios.md#preguntas-abiertas), preguntas 1 a 4)
23. Textos de 404 distintos para el mismo caso (`Cliente o interés no encontrado` en `PATCH /customers/:id/status` y `Cliente no encontrado` en el resto). ¿Se unificarán? ([03](03-clientes-reservas.md#preguntas-abiertas), pregunta 11)
