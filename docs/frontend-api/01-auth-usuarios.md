# Autenticación, sesión, usuarios y salud

> Parte de la [referencia de la API de bk-crm para el frontend](README.md). Estado: 3 de noviembre de 2026.
>
> En este módulo hay tres formas de llegar a bk-crm desde el navegador:
> - `GET /auth/me` y las rutas `/users` se piden con `apiFetch` a `/api/backend<ruta>`, y el BFF añade el token.
> - Login, logout y recuperación de contraseña tienen handlers propios en `/api/auth/*`. El refresh lo hace el BFF por su cuenta.
> - `GET /health` se consulta con el handler `/api/listo`.
>
> Las convenciones comunes (errores, sesión, roles, rate limiting, fechas) están en el [README](README.md#convenciones-generales). El funcionamiento del BFF está en [Arquitectura](README.md#arquitectura-navegador--bff--bk-crm).

Este módulo cubre el inicio y cierre de sesión, la renovación de tokens, la recuperación de contraseña, el perfil del usuario autenticado, la administración de usuarios (solo ADMIN) y el estado del servicio.

Dónde se usa en ft-crm:

| Pieza de ft-crm | Archivo | Rutas de bk-crm |
|---|---|---|
| Login | `src/app/(auth)/login/login-form.tsx` | `POST /auth/login`, vía `/api/auth/login` |
| Recuperar contraseña | `src/app/(auth)/olvide-contrasena/page.tsx` | `POST /auth/forgot-password`, vía `/api/auth/forgot-password` |
| Nueva contraseña (enlace del correo) | `src/app/(auth)/reset-password/reset-form.tsx` | `POST /auth/reset-password`, vía `/api/auth/reset-password` |
| Sesión, permisos y cierre de sesión | `src/lib/auth/session.tsx` | `GET /auth/me`; `POST /auth/logout`, vía `/api/auth/logout` |
| Renovación de tokens (BFF) | `src/lib/server/session.ts` | `POST /auth/refresh` |
| Ajustes > Usuarios | `src/features/ajustes/usuarios/` | `GET /users`, `POST /users`, `PATCH /users/:id/status` |
| Ajustes > Samanta (responsable de aprobación) | `src/features/ajustes/config/samanta-view.tsx` | `GET /users` |
| Disponibilidad del backend (balanceador, Docker) | `src/app/api/listo/route.ts` | `GET /health` |

Sin pantalla todavía: `GET /users/:id` y `PATCH /users/:id` no tienen función en `endpoints.ts`. `usersApi.setRoles` existe, pero ninguna pantalla llama a `PATCH /users/:id/roles`.

Así se ven los errores de las rutas autenticadas desde el navegador (detalle en [Sesión](README.md#sesión-srclibserversessionts)):
- Un 401 de bk-crm nunca llega tal cual. El BFF renueva la sesión una vez y repite la llamada. Si vuelve a recibir 401, responde `{ "statusCode": 401, "message": "Tu sesión terminó. Vuelve a iniciar sesión.", "code": "SESSION_EXPIRED" }` y borra las cookies. Sin cookies responde 401 `{ "statusCode": 401, "message": "Inicia sesión para continuar.", "code": "NO_SESSION" }`.
- Los 400, 403, 404 y 409 llegan con el body de bk-crm sin cambios. `apiFetch` los lanza como `ApiError`, con `messages` siempre en array.
- Si bk-crm no responde, el BFF devuelve 503 o 504 con `code: "BACKEND_UNAVAILABLE"` (ver [Errores que añade el BFF](README.md#errores-que-añade-el-bff)).

Los mensajes de las tablas de errores son los de bk-crm, salvo el 401 de las rutas que pasan por `/api/backend` (`GET /auth/me` y `/users`): ese muestra lo que responde el BFF, como en los demás módulos. Las rutas que pasan por `/api/auth/*` traducen los errores de bk-crm; cada ruta lo explica en sus notas.

## Índice

- [Ver la respuesta raíz de la API](#ver-la-respuesta-raíz-de-la-api) — `GET /`
- [Iniciar sesión](#iniciar-sesión) — `POST /auth/login`
- [Renovar tokens](#renovar-tokens) — `POST /auth/refresh`
- [Cerrar sesión](#cerrar-sesión) — `POST /auth/logout`
- [Obtener el usuario autenticado](#obtener-el-usuario-autenticado) — `GET /auth/me`
- [Comprobar acceso de administrador (endpoint de prueba)](#comprobar-acceso-de-administrador-endpoint-de-prueba) — `GET /auth/test-admin`
- [Solicitar recuperación de contraseña](#solicitar-recuperación-de-contraseña) — `POST /auth/forgot-password`
- [Restablecer contraseña](#restablecer-contraseña) — `POST /auth/reset-password`
- [Comprobar el estado del servicio](#comprobar-el-estado-del-servicio) — `GET /health`
- [Crear usuario](#crear-usuario) — `POST /users`
- [Listar usuarios](#listar-usuarios) — `GET /users`
- [Ver el detalle de un usuario](#ver-el-detalle-de-un-usuario) — `GET /users/:id`
- [Editar los datos de un usuario](#editar-los-datos-de-un-usuario) — `PATCH /users/:id`
- [Activar o desactivar un usuario](#activar-o-desactivar-un-usuario) — `PATCH /users/:id/status`
- [Reemplazar los roles de un usuario](#reemplazar-los-roles-de-un-usuario) — `PATCH /users/:id/roles`

Secciones del módulo: [Modelos](#modelos) · [Estados y transiciones](#estados-y-transiciones) · [Preguntas abiertas](#preguntas-abiertas) · [Tipos TypeScript](#tipos-typescript)

## Ver la respuesta raíz de la API
`GET /`

| | |
|---|---|
| Roles | Pública |
| Respuesta | 200 · `AppRootResponse` (texto, no JSON) |
| ft-crm | No se usa desde el navegador. El proxy `/api/backend/[...path]` exige al menos un segmento, así que `/api/backend` no llega a esta ruta. |
| Caché | No aplica |

**Respuesta**: texto, no JSON (`Content-Type: text/html; charset=utf-8`):

```text
Hello World!
```

**Errores**: no tiene errores propios. Solo aplica el 500 genérico de [Formato de errores](README.md#formato-de-errores).

**Efectos**: ninguno (solo lectura). No consulta la base de datos.

**Notas para el frontend**:
- Es la ruta de plantilla de NestJS (`AppService.getHello()`). Responder 200 aquí no garantiza que la base de datos funcione.
- Para saber si el backend está operativo usa `GET /health`; en ft-crm, el handler `/api/listo`.

## Iniciar sesión
`POST /auth/login`

| | |
|---|---|
| Roles | Pública |
| Respuesta | 201 · `LoginResponse` (de bk-crm al BFF). El navegador recibe 200 · `BffLoginResponse` (`{ user: LoginUser }`) |
| ft-crm | `sessionApi.login(email: string, password: string): Promise<{ user: LoginUser }>` (existe), que llama al handler del BFF `POST /api/auth/login`. El proxy bloquea `/api/backend/auth/login` con 404 `Ruta no disponible.` |
| Caché | Sin clave propia. Tras el éxito, limpia la caché (`queryClient.clear()`) antes de navegar; hoy `login-form.tsx` no lo hace (solo llama a `router.replace`). `qk.me` se carga después en el shell. |
| Cabeceras y límites | `Content-Type: application/json`, sin `Authorization`. Máximo 5 peticiones cada 60 s por IP y cuenta: la sexta responde 429. Techo del BFF: `CRM_BACKEND_TIMEOUT_MS` (15 s por defecto), luego 504. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `email` | string | Sí | `@IsEmail()`: como máximo 254 caracteres (y 64 antes de la `@`), con dominio y TLD, y sin espacios alrededor. Un email con espacios responde 400. Admite mayúsculas: el servicio aplica `trim` y minúsculas antes de buscar, así que el login no distingue mayúsculas. Este DTO no tiene `@MaxLength`. No admite `null`. |
| `password` | string | Sí | `@IsString()` y `@MinLength(8)`. El DTO no fija máximo; el BFF limita a 200. No se recorta: los espacios cuentan. bcrypt solo compara los primeros 72 bytes en UTF-8. No admite `null`. |

Cualquier otro campo responde 400 `property <campo> should not exist`.

**Ejemplo de petición**

```ts
const { user } = await sessionApi.login("rosa.mamani@example.com", "Cusco-Mesa-2026");
```

El navegador envía a `/api/auth/login`, y el BFF reenvía a bk-crm, este JSON:

```json
{
  "email": "rosa.mamani@example.com",
  "password": "Cusco-Mesa-2026"
}
```

El BFF valida antes con zod: `email` con `trim`, minúsculas, formato de email y máximo 320; `password` de 8 a 200 caracteres. Reenvía los datos ya normalizados y descarta cualquier otro campo, así que desde el navegador nunca llega `property <campo> should not exist`.

**Respuesta**

201 de bk-crm al BFF:

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBlN2MzYS0yZjQxLTRkOGUtOWE2Yi0xYzNkNWU3ZjlhMjAiLCJzZXNzaW9uSWQiOiIwYzZlOWYyYS03ZDRiLTRlMWMtOGEzNS1iMmY3ZDllMWM0NjQiLCJlbWFpbCI6InJvc2EubWFtYW5pQGV4YW1wbGUuY29tIiwicm9sZXMiOlsiQURNSU4iXSwiaWF0IjoxNzkzNzE5MjQxLCJleHAiOjE3OTM3MjAxNDF9.9kTaqoMyWA8WYKAdwcC1YxvfxsTMTZyPiV0BUZEX63s",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBlN2MzYS0yZjQxLTRkOGUtOWE2Yi0xYzNkNWU3ZjlhMjAiLCJzZXNzaW9uSWQiOiIwYzZlOWYyYS03ZDRiLTRlMWMtOGEzNS1iMmY3ZDllMWM0NjQiLCJqdGkiOiIzZThhMWM1Zi05YjJkLTRmNjAtYTdjNC1kMWUzZjViN2E5NzUiLCJpYXQiOjE3OTM3MTkyNDEsImV4cCI6MTc5NDMyNDA0MX0.soA4pg45RmBrSGwh81eKKDiO5fEjErLD8wM-WKR4FLQ",
  "user": {
    "id": "5b0e7c3a-2f41-4d8e-9a6b-1c3d5e7f9a20",
    "firstName": "Rosa",
    "lastName": "Mamani",
    "email": "rosa.mamani@example.com",
    "roles": ["ADMIN"]
  }
}
```

Los tokens del ejemplo están firmados con un secreto ficticio. Los claims del access token son `{ sub, sessionId, email, roles, iat, exp }`; los del refresh token, `{ sub, sessionId, jti, iat, exp }` (ver [Modelos](#modelos)).

200 del BFF al navegador, con las cookies httpOnly `crm_at` y `crm_rt`:

```json
{
  "user": {
    "id": "5b0e7c3a-2f41-4d8e-9a6b-1c3d5e7f9a20",
    "firstName": "Rosa",
    "lastName": "Mamani",
    "email": "rosa.mamani@example.com",
    "roles": ["ADMIN"]
  }
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` (array) | El body trae campos que no son `email` ni `password` |
| 400 | `email must be an email` (array) | `email` falta, no es string, está mal formado, tiene espacios alrededor, supera 254 caracteres o tiene más de 64 antes de la `@` |
| 400 | `password must be longer than or equal to 8 characters`; `password must be a string` (array) | `password` falta o no es string (llegan los dos mensajes), o tiene menos de 8 caracteres (solo el primero) |
| 400 | Texto del parser JSON (string) | JSON mal formado |
| 401 | `Correo o contraseña incorrectos` | El correo no existe, el usuario está inactivo o la contraseña no coincide. El mensaje es el mismo en los tres casos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` | El `Content-Type` declara un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) |
| 429 | `ThrottlerException: Too Many Requests` (sin `error`; con cabecera `Retry-After` en segundos) | Sexta petición en 60 s con la misma IP y el mismo email. La pareja queda bloqueada 60 s. |

Ejemplo de 400 con un campo extra y una contraseña corta:

```json
{
  "message": [
    "property remember should not exist",
    "password must be longer than or equal to 8 characters"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

**Efectos**

- Crea una sesión nueva: su `id` es el `sessionId` del token, guarda el hash SHA-256 del refresh token y vence 7 días después del login. Las sesiones anteriores del usuario siguen activas.
- Actualiza `lastLoginAt` del usuario y, con él, su `updatedAt`.
- Suma una petición al contador de la IP y la cuenta. Cuentan también los logins exitosos y los que fallan la validación. El email se cuenta con `trim` y en minúsculas.

**Notas para el frontend**

- Usa siempre `sessionApi.login`. El navegador nunca recibe los tokens: el BFF los guarda en las cookies httpOnly `crm_at` y `crm_rt` (`SameSite=Lax`, con `maxAge` según el `exp` de cada token) y devuelve solo `{ user }`.
- Lo que recibe el navegador de `/api/auth/login`:

  | Caso | Estado | `message` |
  |---|---|---|
  | El body no pasa la validación del BFF | 400 | `Ingresa un correo válido y una contraseña de al menos 8 caracteres.` |
  | bk-crm responde 401 | 401 | `Correo o contraseña incorrectos.` |
  | bk-crm responde 429 | 429 | `Hiciste demasiados intentos. Espera un minuto e inténtalo otra vez.` (sin `Retry-After`) |
  | bk-crm responde 400 | 400 | El `message` de bk-crm si es string; si es array, `No se pudo iniciar sesión.` |
  | Cualquier otro error de bk-crm | 502 | El `message` de bk-crm si es string; si no, `No se pudo iniciar sesión.` |
  | bk-crm no responde | 503 o 504 | Mensaje del BFF con `code: "BACKEND_UNAVAILABLE"` |
  | Éxito | 200 | `{ user }` |

  `sessionApi.login` lanza `Error(message)` con ese texto: muéstralo tal cual.
- `login-form.tsx` elige el destino así: `safeNextPath(next) ?? homePathFor(user.roles) ?? "/bandeja"`. Para eso basta `user.roles`; para permisos, usa después `GET /auth/me`. SUPPORT no tiene ninguna vista, así que termina en `/bandeja` sin acceso (ver [Preguntas abiertas](#preguntas-abiertas)).
- Limpia la caché de TanStack Query tras un login exitoso. El `QueryClient` del navegador es único y vive mientras no se recargue la página. Si se llega a `/login` sin cerrar sesión y sin recargar, la caché conserva los datos del usuario anterior, y el BFF reemplaza las cookies sin revocar la sesión anterior en bk-crm. `qk.me` podría mostrar al usuario anterior mientras siga fresco (`staleTime` de 60 s).
- Un usuario inactivo recibe el mismo 401: la UI no puede distinguirlo de una contraseña errónea.
- El cupo es por IP y cuenta. Detrás del BFF todos los usuarios comparten IP, pero cada email tiene su propio cupo (ver [Rate limiting](README.md#rate-limiting)).

## Renovar tokens
`POST /auth/refresh`

| | |
|---|---|
| Roles | Pública: no requiere `Authorization`; se autentica con el refresh token del body |
| Respuesta | 201 · `RefreshResponse` |
| ft-crm | No se usa desde el navegador. La llama el BFF con `refreshSession(refreshToken: string): Promise<RefreshOutcome>` (`src/lib/server/session.ts`). El proxy bloquea `/api/backend/auth/refresh` con 404 `Ruta no disponible.` |
| Caché | No aplica. Cuando el BFF renueva, actualiza las cookies en la misma respuesta que devuelve al navegador, salvo si la llamada posterior a bk-crm falla por red o timeout (ver las notas). |
| Cabeceras y límites | `Content-Type: application/json`. Sin rate limiting. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `refreshToken` | string | Sí | `@IsString()`. Debe ser el último refresh token emitido para la sesión. Un string vacío pasa la validación y responde 401. No admite `null`. |

Cualquier otro campo responde 400 `property <campo> should not exist`.

**Ejemplo de petición**

```ts
// BFF (src/lib/server/session.ts): una sola renovación por refresh token
const outcome = await refreshSession(refreshToken);
```

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBlN2MzYS0yZjQxLTRkOGUtOWE2Yi0xYzNkNWU3ZjlhMjAiLCJzZXNzaW9uSWQiOiIwYzZlOWYyYS03ZDRiLTRlMWMtOGEzNS1iMmY3ZDllMWM0NjQiLCJqdGkiOiIzZThhMWM1Zi05YjJkLTRmNjAtYTdjNC1kMWUzZjViN2E5NzUiLCJpYXQiOjE3OTM3MTkyNDEsImV4cCI6MTc5NDMyNDA0MX0.soA4pg45RmBrSGwh81eKKDiO5fEjErLD8wM-WKR4FLQ"
}
```

**Respuesta**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBlN2MzYS0yZjQxLTRkOGUtOWE2Yi0xYzNkNWU3ZjlhMjAiLCJzZXNzaW9uSWQiOiIwYzZlOWYyYS03ZDRiLTRlMWMtOGEzNS1iMmY3ZDllMWM0NjQiLCJlbWFpbCI6InJvc2EubWFtYW5pQGV4YW1wbGUuY29tIiwicm9sZXMiOlsiQURNSU4iXSwiaWF0IjoxNzkzNzIwMTE2LCJleHAiOjE3OTM3MjEwMTZ9.nFrgM4j99B-f1lbz5N6GmopyKG0EKuyUusuA9-2GgVk",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBlN2MzYS0yZjQxLTRkOGUtOWE2Yi0xYzNkNWU3ZjlhMjAiLCJzZXNzaW9uSWQiOiIwYzZlOWYyYS03ZDRiLTRlMWMtOGEzNS1iMmY3ZDllMWM0NjQiLCJqdGkiOiI3ZjJjNGU2YS0xYjNkLTRhNTgtOWM3MC1lMmY0YTZiOGMwODYiLCJpYXQiOjE3OTM3MjAxMTYsImV4cCI6MTc5NDMyNDkxNn0.J7Vg5hg6lUbitTfn4D0QFPjjpsnswf8xsr8CMoisKGQ"
}
```

**Errores**

Tras la validación del body, los 401 se comprueban en este orden: firma y vencimiento del token, sesión, revocación, vencimiento de la sesión, hash del token, usuario y rotación.

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `refreshToken must be a string` (array) | El campo falta, es `null` o no es string |
| 400 | `property <campo> should not exist` (array) | El body trae otros campos |
| 400 | Texto del parser JSON (string) | JSON mal formado |
| 401 | `Refresh token inválido o expirado` | El token está mal formado, vacío o expirado, o tiene una firma inválida (p. ej. si se envía un access token) |
| 401 | `Sesión no válida` | La sesión no existe o no pertenece al usuario del token |
| 401 | `Sesión revocada` | La sesión se cerró por logout, por desactivación del usuario o por restablecimiento de contraseña |
| 401 | `Sesión expirada` | Pasaron 7 días desde el login |
| 401 | `Refresh token inválido` | El token ya rotó: se está reutilizando un refresh token anterior |
| 401 | `Usuario no autorizado` | El usuario ya no existe o está inactivo. Es una comprobación defensiva: al desactivar a un usuario se revocan sus sesiones, así que antes llega `Sesión revocada`. |
| 401 | `Refresh token ya utilizado o sesión no válida` | Otra petición rotó el mismo token a la vez, o la sesión dejó de ser válida durante la operación |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` | El `Content-Type` declara un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) |

**Efectos**

- Rota el refresh token: la sesión guarda el hash del nuevo y registra `lastUsedAt`. El refresh token usado deja de servir.
- No alarga la sesión: sigue venciendo 7 días después del login, aunque el nuevo refresh token tenga su propio `exp` (`JWT_REFRESH_EXPIRES_IN` contado desde la renovación).
- El nuevo access token lleva el email y los roles que hay en ese momento en la base de datos.
- Los access tokens anteriores de la misma sesión siguen valiendo hasta su `exp`.

**Notas para el frontend**

- El navegador no llama a esta ruta. El BFF renueva en dos casos: antes de llamar, si `crm_at` falta o vence en 30 s o menos; y una sola vez, tras un 401 de bk-crm.
- Si varias peticiones necesitan renovar a la vez, el BFF hace una sola renovación por refresh token. Además, recuerda el resultado 60 s para las peticiones que llegan tarde con el token anterior. Ese registro vive en la memoria del proceso: en producción hace falta una sola instancia del frontend o sesiones *sticky*.
- Un 400 o 401 de esta ruta termina la sesión: el BFF responde 401 `SESSION_EXPIRED` y borra las cookies. Cualquier otro fallo, o la falta de respuesta, da 503 `BACKEND_UNAVAILABLE` sin cerrar la sesión.
- Si la renovación funciona pero la llamada que viene después no llega a bk-crm (red o timeout), `proxyWithSession` responde 503 o 504 sin las cookies nuevas. El navegador conserva el refresh token anterior, que bk-crm ya rotó. Durante 60 s el BFF lo resuelve con el resultado recordado; después, el siguiente refresh responde 401 `Refresh token inválido` y la sesión termina con `SESSION_EXPIRED`.
- La respuesta no incluye `user`. Los datos actuales salen de `GET /auth/me`.
- Al vencer la sesión (7 días después del login), esta ruta responde 401 `Sesión expirada` aunque la cookie `crm_rt` siga viva, y hay que volver a iniciar sesión.

## Cerrar sesión
`POST /auth/logout`

| | |
|---|---|
| Roles | Cualquier usuario autenticado (ADMIN, OWNER, OPERATOR o SUPPORT) |
| Respuesta | 201 · `LogoutResponse`. El navegador recibe 200 · `BffLogoutResponse` (`{ ok: true }`) |
| ft-crm | `sessionApi.logout(): Promise<{ ok: true }>` (existe), que llama al handler del BFF `POST /api/auth/logout`. Lo usa `useSession().logout()` (`src/lib/auth/session.tsx`). El proxy bloquea `/api/backend/auth/logout` con 404 `Ruta no disponible.` |
| Caché | `queryClient.clear()` y navegar a `/login`. `SessionProvider.logout` ya lo hace, aunque el logout falle. |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` vigente, de un usuario activo y con la sesión activa. Lo pone el BFF a partir de la cookie `crm_at`. |

**Body**: no lleva. La ruta no tiene DTO, así que un JSON válido se ignora. Un JSON mal formado con `Content-Type: application/json` responde 400 del parser, antes de comprobar el token.

**Ejemplo de petición**

```ts
await sessionApi.logout(); // POST /api/auth/logout con body {}
```

El BFF llama a bk-crm sin body: `POST /auth/logout` con `Authorization: Bearer <crm_at>`.

**Respuesta**

201 de bk-crm al BFF:

```json
{
  "message": "Sesión cerrada correctamente"
}
```

200 del BFF al navegador, que además borra las cookies `crm_at` y `crm_rt`:

```json
{
  "ok": true
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Unauthorized` (sin campo `error`) | Falta la cabecera, el token está mal formado, la firma es inválida o el token expiró |
| 401 | `Token de acceso inválido` | El token no trae `sub` o `sessionId` |
| 401 | `Usuario no autorizado` | El usuario ya no existe o está inactivo (es lo que recibe un usuario desactivado) |
| 401 | `Sesión no válida o expirada` | La sesión ya estaba revocada (p. ej. un segundo logout con el mismo token) o venció |

No hay 403: cualquier rol puede cerrar su sesión.

**Efectos**

- Revoca solo la sesión del access token: guarda `revokedAt`. Desde ese momento, el access token y el refresh token de esa sesión responden 401.
- Las demás sesiones del usuario (otros navegadores o dispositivos) siguen activas.

**Notas para el frontend**

- El handler del BFF primero renueva con `crm_rt` si `crm_at` falta o vence en 5 s o menos, porque bk-crm exige un access token vigente para revocar la sesión. Luego llama a bk-crm e ignora su respuesta.
- `/api/auth/logout` siempre responde 200 `{ ok: true }` y borra las cookies, aunque bk-crm no responda. En ese caso la sesión sigue vigente en el servidor hasta que venza (como máximo, 7 días después del login).
- En bk-crm no es idempotente: repetir el logout con el mismo token da 401. El BFF lo absorbe.
- No hay endpoint para cerrar todas las sesiones de un usuario.

## Obtener el usuario autenticado
`GET /auth/me`

| | |
|---|---|
| Roles | Cualquier usuario autenticado (ADMIN, OWNER, OPERATOR o SUPPORT) |
| Respuesta | 200 · `MeResponse` |
| ft-crm | `sessionApi.me(signal?: AbortSignal): Promise<MeResponse>` (existe), que pide `/api/backend/auth/me` |
| Caché | `qk.me` (`["me"]`). En `SessionProvider`: `staleTime` de 60 s y `refetchInterval` de 5 min. |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` vigente, de un usuario activo y con la sesión activa. Lo pone el BFF. |

**Respuesta**

```json
{
  "id": "5b0e7c3a-2f41-4d8e-9a6b-1c3d5e7f9a20",
  "sessionId": "0c6e9f2a-7d4b-4e1c-8a35-b2f7d9e1c464",
  "firstName": "Rosa",
  "lastName": "Mamani",
  "email": "rosa.mamani@example.com",
  "roles": ["ADMIN"]
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: `NO_SESSION` si no hay cookies; `SESSION_EXPIRED` si hacía falta renovar y no hay `crm_rt`, si el refresh responde 400 o 401, o si bk-crm sigue respondiendo 401 con el token renovado. Si el refresh falla por red, responde 503 `BACKEND_UNAVAILABLE` y no cierra la sesión. |

Motivos del 401 de bk-crm, que el BFF convierte en el anterior (no llegan al navegador):

| Mensaje de bk-crm | Cuándo |
|---|---|
| `Unauthorized` (sin campo `error`) | Falta la cabecera, el token está mal formado, la firma es inválida o el token expiró |
| `Token de acceso inválido` | El token no trae `sub` o `sessionId` |
| `Usuario no autorizado` | El usuario ya no existe o está inactivo (es lo que recibe un usuario desactivado) |
| `Sesión no válida o expirada` | La sesión fue revocada (por logout, por restablecimiento de contraseña o por una desactivación anterior, si el usuario ya se reactivó) o venció |

No hay 403: cualquier rol puede consultar su perfil, incluido SUPPORT.

**Efectos**: ninguno (solo lectura).

**Notas para el frontend**

- Los datos y los roles se leen de la base de datos en cada llamada, no del JWT. Es la fuente de verdad para `can()` y `canView()` (`src/lib/auth/permissions.ts`).
- Refresca `qk.me` después de editar los datos o los roles del propio usuario.
- El orden de `roles` no está garantizado. Para mostrar un solo rol usa `primaryRole()`, que aplica la precedencia ADMIN > OWNER > OPERATOR > SUPPORT.
- `sessionId` identifica la sesión actual; ninguna otra ruta lo usa.
- No incluye `isActive`, `lastLoginAt`, `createdAt` ni `updatedAt`. Para esos datos, un ADMIN puede usar `GET /users/:id`.
- En el navegador, un 401 llega como `SESSION_EXPIRED` o `NO_SESSION`. `apiFetch` emite `crm:session-expired` y `SessionProvider` lleva a `/login?motivo=sesion&next=…`.
- Un 503 o 504 no cierra la sesión. Si todavía no hay datos de `qk.me`, `useSession()` queda en `status: "error"` y ofrece `retry()`; si ya los había, conserva los anteriores.

## Comprobar acceso de administrador (endpoint de prueba)
`GET /auth/test-admin`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `TestAdminResponse` |
| ft-crm | No se usa desde el navegador: el BFF la bloquea y `/api/backend/auth/test-admin` responde 404 `Ruta no disponible.` |
| Caché | No aplica |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` vigente de un ADMIN |

**Respuesta**

```json
{
  "message": "Acceso autorizado para administrador"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Unauthorized` (sin `error`); `Token de acceso inválido`; `Usuario no autorizado`; `Sesión no válida o expirada` | El token falta, es inválido o expiró; el usuario está inactivo; o la sesión fue revocada o venció |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene el rol ADMIN (OWNER, OPERATOR o SUPPORT) |

**Efectos**: ninguno (solo lectura).

**Notas para el frontend**

- Es un endpoint de prueba. El README de bk-crm pide eliminar los endpoints temporales de prueba antes de desplegar, así que no construyas pantallas sobre él. Falta confirmar si se mantendrá (ver [Preguntas abiertas](#preguntas-abiertas)).
- Para saber si el usuario es ADMIN usa `GET /auth/me` (`roles.includes("ADMIN")`).

## Solicitar recuperación de contraseña
`POST /auth/forgot-password`

| | |
|---|---|
| Roles | Pública |
| Respuesta | 200 · `ForgotPasswordResponse` (siempre la misma). El navegador recibe 200 · `BffForgotPasswordResponse` |
| ft-crm | `sessionApi.forgotPassword(email: string): Promise<{ message: string }>` (existe), que llama al handler del BFF `POST /api/auth/forgot-password`. El proxy bloquea `/api/backend/auth/forgot-password` con 404 `Ruta no disponible.` |
| Caché | No aplica (pantalla pública, sin consultas) |
| Cabeceras y límites | `Content-Type: application/json`, sin `Authorization`. Máximo 3 peticiones cada 60 s por IP y cuenta: la cuarta responde 429. Techo del BFF: `CRM_BACKEND_TIMEOUT_MS` (15 s por defecto), luego 504. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `email` | string | Sí | `@IsEmail()` y `@MaxLength(320)`. En la práctica `@IsEmail()` ya limita el email a 254 caracteres y rechaza los espacios alrededor. El servicio aplica `trim` y minúsculas antes de buscar. No admite `null`. |

Cualquier otro campo responde 400 `property <campo> should not exist`.

**Ejemplo de petición**

```ts
const { message } = await sessionApi.forgotPassword("carlos.huaman@example.com");
```

El navegador envía a `/api/auth/forgot-password`, y el BFF reenvía a bk-crm (con `trim`, en minúsculas y sin otros campos), este JSON:

```json
{
  "email": "carlos.huaman@example.com"
}
```

**Respuesta**

200 de bk-crm al BFF:

```json
{
  "message": "Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña"
}
```

200 del BFF al navegador (su propio texto, con punto final):

```json
{
  "message": "Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña."
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `email must be shorter than or equal to 320 characters`; `email must be an email` (array) | `email` falta, es `null` o no es string (llegan los dos mensajes), o supera 320 caracteres |
| 400 | `email must be an email` (array) | El email está mal formado, tiene espacios alrededor o supera 254 caracteres |
| 400 | `property <campo> should not exist` (array) | El body trae otros campos |
| 400 | Texto del parser JSON (string) | JSON mal formado |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` | El `Content-Type` declara un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) |
| 429 | `ThrottlerException: Too Many Requests` (sin `error`; con cabecera `Retry-After` en segundos) | Cuarta petición en 60 s con la misma IP y el mismo email (con `trim` y en minúsculas). La pareja queda bloqueada 60 s. |

No hay 404: un correo desconocido responde igual que uno registrado.

**Efectos**

- Si el correo pertenece a un usuario activo:
  1. Borra todos sus enlaces de recuperación anteriores, usados o no.
  2. Crea un enlace de un solo uso que vence a los `PASSWORD_RESET_TOKEN_TTL_MINUTES` minutos (15 por defecto; entero de 1 a 1440). Solo guarda el hash SHA-256 del token.
  3. Envía con Resend el correo «Restablece tu contraseña de EYAQ Systems». El correo incluye el enlace `FRONTEND_RESET_PASSWORD_URL?token=<64 caracteres hexadecimales en minúsculas>` y avisa en cuántos minutos vence.
- Si falla el envío, borra el enlace nuevo. Como los anteriores ya se borraron, el usuario se queda sin enlace válido y tiene que pedir otro.
- Si el correo no existe, el usuario está inactivo o no se pudo crear el enlace, no hace nada más.
- En todos los casos suma una petición al contador de la IP y la cuenta, también si no pasa la validación.

**Notas para el frontend**

- La respuesta de bk-crm es siempre la misma 200: exista o no el correo, esté inactivo el usuario o falle el envío. Así no se revela si la cuenta existe. Muestra el mensaje tal cual y no prometas que el correo llegó.
- Lo que recibe el navegador de `/api/auth/forgot-password`:

  | Caso | Estado | `message` |
  |---|---|---|
  | El body no pasa la validación del BFF (zod: email con `trim`, minúsculas y máximo 320) | 400 | `Ingresa un correo válido.` |
  | bk-crm responde 429 | 429 | `Hiciste demasiados intentos. Espera un minuto e inténtalo otra vez.` (sin `Retry-After`) |
  | Cualquier otro error de bk-crm | 502 | `No se pudo enviar el enlace. Inténtalo de nuevo.` |
  | bk-crm no responde | 503 o 504 | Mensaje del BFF con `code: "BACKEND_UNAVAILABLE"` |
  | Éxito | 200 | `Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.` |

- El enlace del correo abre `/reset-password?token=…` en ft-crm (`src/app/(auth)/reset-password/`), que es una ruta pública en `src/proxy.ts`. `FRONTEND_RESET_PASSWORD_URL` vale por defecto `http://localhost:5173/reset-password`. Con `NODE_ENV=production`, bk-crm no arranca si no es una URL `https` pública. La URL de cada entorno está por confirmar.
- Sin `RESEND_FROM_EMAIL` (o con un remitente de `resend.dev`), Resend solo entrega al dueño de la cuenta de Resend; con `NODE_ENV=production`, bk-crm no arranca así. En desarrollo, el correo puede no llegar aunque la respuesta sea 200.

## Restablecer contraseña
`POST /auth/reset-password`

| | |
|---|---|
| Roles | Pública |
| Respuesta | 200 · `ResetPasswordResponse`. El navegador recibe 200 · `BffResetPasswordResponse` |
| ft-crm | `sessionApi.resetPassword(token: string, newPassword: string): Promise<{ message: string }>` (existe), que llama al handler del BFF `POST /api/auth/reset-password`. El proxy bloquea `/api/backend/auth/reset-password` con 404 `Ruta no disponible.` |
| Caché | No aplica (pantalla pública, sin consultas) |
| Cabeceras y límites | `Content-Type: application/json`, sin `Authorization`. Máximo 5 peticiones cada 60 s por IP y enlace (`token`): la sexta responde 429. Techo del BFF: `CRM_BACKEND_TIMEOUT_MS` (15 s por defecto), luego 504. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `token` | string | Sí | `@IsString()` y `@Matches(/^[a-f0-9]{64}$/i)`; si no cumple, el mensaje es `El token de recuperación no tiene un formato válido`. Envía exactamente el valor que llegó en el enlace: el patrón admite mayúsculas, pero el token se busca por su hash y solo coincide tal como se emitió (en minúsculas). No admite `null`. |
| `newPassword` | string | Sí | `@IsString()`, `@MinLength(8)` y `@MaxLength(72)`, en caracteres. No se recorta y no hay reglas de complejidad. bcrypt solo usa los primeros 72 bytes en UTF-8: con tildes, `ñ` o emojis, el resto se ignora al comparar. No admite `null`. |

Cualquier otro campo responde 400 `property <campo> should not exist`; por ejemplo, `confirmPassword`.

**Ejemplo de petición**

```ts
// reset-form.tsx lee el token de ?token= y comprueba que las dos contraseñas coincidan
await sessionApi.resetPassword(token, "Nueva-Clave-2026");
```

El navegador envía a `/api/auth/reset-password`, y el BFF reenvía a bk-crm (sin otros campos), este JSON:

```json
{
  "token": "34e9f720f76dcdf209c3e0cfdcaf31cfdba932f8e0416cbbb0cc2f75531ba935",
  "newPassword": "Nueva-Clave-2026"
}
```

**Respuesta**

200 de bk-crm al BFF:

```json
{
  "message": "Contraseña restablecida correctamente"
}
```

200 del BFF al navegador (su propio texto, con punto final):

```json
{
  "message": "Contraseña restablecida correctamente."
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `El token de recuperación no tiene un formato válido` (array) | `token` no tiene 64 caracteres hexadecimales. Si falta o no es string, llega junto con `token must be a string`. |
| 400 | `newPassword must be shorter than or equal to 72 characters`; `newPassword must be longer than or equal to 8 characters`; `newPassword must be a string` (array) | `newPassword` tiene menos de 8 o más de 72 caracteres (solo el mensaje de esa longitud). Si falta o no es string, llegan los tres, en este orden. Con el body vacío llegan cinco: los dos de `token` y después los tres de `newPassword`. |
| 400 | `property <campo> should not exist` (array) | El body trae otros campos |
| 400 | Texto del parser JSON (string) | JSON mal formado |
| 400 | `El enlace de recuperación es inválido o ha expirado` (string) | El token no existe (o se envió en mayúsculas), ya se usó, venció o se borró al pedir otro enlace; el usuario está inactivo; o hubo un conflicto con otra petición simultánea |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` | El `Content-Type` declara un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) |
| 429 | `ThrottlerException: Too Many Requests` (sin `error`; con cabecera `Retry-After` en segundos) | Sexta petición en 60 s con la misma IP y el mismo `token`. La pareja queda bloqueada 60 s. |

**Efectos**

En una sola transacción:
- marca el enlace como usado (`usedAt`);
- guarda la nueva contraseña (bcrypt, 12 rondas), lo que también cambia el `updatedAt` del usuario;
- revoca todas las sesiones activas del usuario;
- borra sus demás enlaces de recuperación.

No inicia sesión ni cambia `lastLoginAt`. Suma una petición al contador de la IP y el enlace.

**Notas para el frontend**

- El token es de un solo uso: un segundo intento con el mismo token devuelve 400.
- El usuario tendrá que iniciar sesión de nuevo en todos sus dispositivos. ft-crm redirige a `/login?motivo=restablecida`.
- Lo que recibe el navegador de `/api/auth/reset-password`:

  | Caso | Estado | `message` |
  |---|---|---|
  | El body no pasa la validación del BFF (zod: `token` con el mismo patrón y `newPassword` de 8 a 72) | 400 | `El enlace no es válido o la contraseña no cumple el largo (8 a 72 caracteres).` |
  | bk-crm responde 400 | 400 | `El enlace de recuperación es inválido o ha expirado. Solicita uno nuevo.` |
  | bk-crm responde 429 | 429 | `Hiciste demasiados intentos. Espera un minuto e inténtalo otra vez.` (sin `Retry-After`) |
  | Cualquier otro error de bk-crm | 502 | `No se pudo cambiar la contraseña. Inténtalo de nuevo.` |
  | bk-crm no responde | 503 o 504 | Mensaje del BFF con `code: "BACKEND_UNAVAILABLE"` |
  | Éxito | 200 | `Contraseña restablecida correctamente.` |

- `reset-form.tsx` muestra «Enlace no válido» si `token` no cumple `/^[a-f0-9]{64}$/i`, y valida en el cliente el largo y que las dos contraseñas coincidan. No envíes la confirmación al backend.
- Si quien restablece tenía la sesión abierta en el mismo navegador, sus cookies siguen ahí, pero la sesión ya está revocada. Su siguiente llamada termina en `SESSION_EXPIRED`.

## Comprobar el estado del servicio
`GET /health`

| | |
|---|---|
| Roles | Pública |
| Respuesta | 200 · `HealthResponse` con `status: "ok"`; 503 · `HealthResponse` con `status: "error"` si la base de datos no responde |
| ft-crm | Handler del BFF `GET /api/listo` (existe; sin función en `endpoints.ts`). Responde 200 `ReadyResponse` si bk-crm responde 2xx, y 503 si no. |
| Caché | No aplica: hoy ninguna pantalla lo consulta |
| Cabeceras y límites | Sin token. bk-crm responde siempre con `Cache-Control: no-store`, también en el 503. La consulta a la base de datos tiene un límite de 3 s. |

**Respuesta**

200:

```json
{
  "status": "ok",
  "services": {
    "api": "up",
    "database": "up"
  },
  "timestamp": "2026-11-03T15:20:41.512Z",
  "uptimeSeconds": 6215
}
```

503: el body tiene la misma forma, sin `message` ni `error`.

```json
{
  "status": "error",
  "services": {
    "api": "up",
    "database": "down"
  },
  "timestamp": "2026-11-03T15:21:02.087Z",
  "uptimeSeconds": 6236
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 503 | Sin `message`: el body es el `HealthResponse` anterior, con `"status": "error"` y `"database": "down"` | La consulta `SELECT 1` a PostgreSQL falla o tarda más de 3 s |

**Efectos**: ninguno (solo lectura). Ejecuta una única consulta `SELECT 1 AS "result"`. No consulta Redis ni tablas de negocio.

**Notas para el frontend**

- `/api/listo` (`src/app/api/listo/route.ts`) devuelve, siempre con `cache-control: no-store`:
  - en modo mock, 200 `{ "estado": "ok", "backend": "simulado" }`;
  - en modo live, si bk-crm responde 2xx, 200 `{ "estado": "ok", "backend": "disponible" }`;
  - si bk-crm responde otro código, 503 `{ "estado": "error", "backend": "respondió 503" }`;
  - si bk-crm no responde, 503 `{ "estado": "error", "backend": "no disponible", "motivo": "timeout" }` (`motivo` puede ser `timeout`, `network` o `error`).
- `/api/salud` informa solo del proceso de Next.js (`{ estado, modo }`) y no consulta bk-crm.
- No uses `/api/backend/health`: el proxy exige sesión y responde 401 `NO_SESSION` sin cookies.
- Si una pantalla necesita un indicador de conexión, consulta `/api/listo` con `fetch` y una clave propia (p. ej. `["ready"]`). `apiFetch` no sirve, porque antepone `/api/backend`.
- `uptimeSeconds` son los segundos enteros desde que arrancó el proceso de bk-crm. `timestamp` es el instante de la comprobación, en UTC.

## Crear usuario
`POST /users`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 201 · `User` |
| ft-crm | `usersApi.create(body: CreateUserRequest): Promise<User>` (existe). Lo usa `InvitarUsuarioForm` (`src/features/ajustes/usuarios/invitar-usuario-form.tsx`). |
| Caché | Invalida `qk.users` (ya lo hace `InvitarUsuarioForm`). Si usas la clave nueva `qk.user(id)`, guarda ahí la respuesta con `setQueryData`. |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` de un ADMIN (lo pone el BFF) y `Content-Type: application/json` (lo pone `apiFetch`) |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `firstName` | string | Sí | `@IsString()`, `@IsNotEmpty()`, al menos un carácter no blanco (`firstName no puede contener solo espacios`) y `@MaxLength(100)`. El máximo se mide antes del `trim`, con los espacios. Se guarda con `trim`. No admite `null`. |
| `lastName` | string | Sí | Las mismas reglas que `firstName`, con el mensaje `lastName no puede contener solo espacios`. Se guarda con `trim`. No admite `null`. |
| `email` | string | Sí | `@IsEmail()` y `@MaxLength(320)`. En la práctica `@IsEmail()` ya limita el email a 254 caracteres y rechaza los espacios alrededor. Se guarda en minúsculas y debe ser único; la comparación se hace ya en minúsculas. No admite `null`. |
| `password` | string | Sí | `@IsString()`, `@MinLength(8)` y `@MaxLength(72)`, en caracteres. No se recorta y no hay reglas de complejidad. Se guarda con bcrypt (12 rondas) y nunca se devuelve. bcrypt solo usa los primeros 72 bytes en UTF-8: con tildes, `ñ` o emojis, 72 caracteres pueden superar ese tamaño y el resto se ignora al comparar. No admite `null`. |
| `roles` | `RoleCode[]` | Sí | `@IsArray()`, `@ArrayMinSize(1)`, `@ArrayUnique()` y cada valor debe ser `ADMIN`, `OWNER`, `OPERATOR` o `SUPPORT`, en mayúsculas. Admite varios roles. No admite `null`. |

Cualquier otro campo responde 400 `property <campo> should not exist`; por ejemplo, `isActive` o `confirmPassword`.

**Ejemplo de petición**

```ts
const user = await usersApi.create({
  firstName: "Lucía",
  lastName: "Quispe",
  email: "lucia.quispe@example.com",
  password: "Temporal-Lima-26",
  roles: ["OPERATOR"],
});
```

```json
{
  "firstName": "Lucía",
  "lastName": "Quispe",
  "email": "lucia.quispe@example.com",
  "password": "Temporal-Lima-26",
  "roles": ["OPERATOR"]
}
```

**Respuesta**

```json
{
  "id": "e8c5a1f3-4d2b-4c79-a0e6-9b1d3f5a7c53",
  "firstName": "Lucía",
  "lastName": "Quispe",
  "email": "lucia.quispe@example.com",
  "isActive": true,
  "lastLoginAt": null,
  "createdAt": "2026-11-03T15:42:08.517Z",
  "updatedAt": "2026-11-03T15:42:08.517Z",
  "roles": ["OPERATOR"]
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` (array) | El body trae campos que no están en la tabla anterior |
| 400 | `firstName must be shorter than or equal to 100 characters`; `firstName no puede contener solo espacios`; `firstName should not be empty`; `firstName must be a string` (array, en este orden; lo mismo para `lastName`) | Falta o es `null`: llegan los cuatro. Otro tipo (número, booleano, array…): los mismos sin `should not be empty`. `""`: `no puede contener solo espacios` y `should not be empty`. Solo espacios: `no puede contener solo espacios`. Más de 100 caracteres: solo `must be shorter…` |
| 400 | `email must be shorter than or equal to 320 characters`; `email must be an email` (array, en este orden) | `email` falta, es `null`, no es string o supera 320 caracteres: llegan los dos. Mal formado, con espacios alrededor, con más de 254 caracteres o con más de 64 antes de la `@`: solo `email must be an email` |
| 400 | `password must be shorter than or equal to 72 characters`; `password must be longer than or equal to 8 characters`; `password must be a string` (array, en este orden) | `password` falta, es `null` o no es string: llegan los tres. Menos de 8 o más de 72 caracteres: solo el mensaje de esa longitud |
| 400 | `each value in roles must be one of the following values: ADMIN, OWNER, OPERATOR, SUPPORT`; `All roles's elements must be unique`; `roles must contain at least 1 elements`; `roles must be an array` (array, en este orden) | `roles` falta, es `null` o no es array (p. ej. `"admin"`, `5` o `{}`): llegan los cuatro; si es un string con un rol válido (`"ADMIN"`), los tres últimos. `[]`: solo `at least 1 elements`. Rol repetido: solo `must be unique`. Un valor fuera del enum dentro del array (p. ej. `["admin"]`): solo `each value in roles…` |
| 400 | Texto del parser JSON (string) | JSON mal formado |
| 400 | `Uno o más roles no están disponibles` (string) | Algún rol del enum no existe en la tabla `roles` (no se ejecutó el seed) |
| 400 | `Debes asignar al menos un rol` (string) | Comprobación defensiva del servicio. No llega por HTTP: antes responde la validación `roles must contain at least 1 elements`. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. bk-crm le responde `Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado` o `Sesión no válida o expirada` (token ausente, inválido o vencido; usuario inactivo; sesión revocada o vencida), pero esos textos no llegan al navegador. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario autenticado no tiene el rol ADMIN (OWNER, OPERATOR o SUPPORT) |
| 409 | `Ya existe un usuario registrado con este correo` | El email ya está registrado, comparado en minúsculas. También si otra petición lo registra a la vez. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` | El `Content-Type` declara un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) |

Ejemplo de 400 para `{ "firstName": "   ", "lastName": "", "email": "x", "password": "corta", "roles": [] }`:

```json
{
  "message": [
    "firstName no puede contener solo espacios",
    "lastName no puede contener solo espacios",
    "lastName should not be empty",
    "email must be an email",
    "password must be longer than or equal to 8 characters",
    "roles must contain at least 1 elements"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

**Efectos**

- Crea el usuario activo (`isActive: true`, `lastLoginAt: null`) y le asigna los roles indicados.
- No envía correo de invitación ni crea sesiones.

**Notas para el frontend**

- El servicio comprueba primero el correo y después los roles: si el correo ya existe, responde 409 aunque falten roles en la base de datos.
- Los mensajes de validación están en inglés y casi todos empiezan por el nombre del campo (`firstName`, `lastName`, `email`, `password`, `roles`). Úsalo para mostrarlos como errores de campo. Excepciones: `each value in roles …` y `All roles's elements must be unique` (son de `roles`) y `property <campo> should not exist`. Hoy `createUserErrorTarget` lleva al campo Correo el 409 y los 400 cuyos mensajes son todos de `email`; el resto va a un aviso del formulario.
- `buildCreateUserBody` ya recorta los nombres y el email, y pasa el email a minúsculas. La contraseña se envía tal cual.
- El formulario actual envía un solo rol (`roles: [values.role]`), aunque el backend admite varios.
- No hay invitación por correo: el ADMIN comparte la contraseña temporal, y el usuario puede cambiarla con «¿Olvidaste tu contraseña?».
- La respuesta devuelve el email normalizado y nunca incluye `password` ni `passwordHash`. El orden de `roles` no está garantizado.

## Listar usuarios
`GET /users`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `User[]` (`UserListResponse`) |
| ft-crm | `usersApi.list(): Promise<User[]>` (existe). La usan `UsuariosView` (Ajustes > Usuarios) y `OwnerValidationCard` (Ajustes > Samanta, con `enabled: canEdit`). |
| Caché | `qk.users` (`["users"]`) |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` de un ADMIN (lo pone el BFF) |

**Query**: no tiene. No hay búsqueda, filtros ni paginación. Los parámetros que se envíen se ignoran: esta ruta no declara DTO de query, así que no responde 400.

**Respuesta**: array plano, sin envoltorio ni paginación, ordenado por `createdAt` descendente.

```json
[
  {
    "id": "e8c5a1f3-4d2b-4c79-a0e6-9b1d3f5a7c53",
    "firstName": "Lucía",
    "lastName": "Quispe",
    "email": "lucia.quispe@example.com",
    "isActive": true,
    "lastLoginAt": null,
    "createdAt": "2026-11-03T15:42:08.517Z",
    "updatedAt": "2026-11-03T15:42:08.517Z",
    "roles": ["OPERATOR"]
  },
  {
    "id": "a3f1c9e2-6b7d-4e58-8c19-0d2e4f6a8b31",
    "firstName": "Carlos",
    "lastName": "Huamán",
    "email": "carlos.huaman@example.com",
    "isActive": true,
    "lastLoginAt": "2026-11-03T13:12:09.441Z",
    "createdAt": "2026-10-21T14:05:33.208Z",
    "updatedAt": "2026-11-03T13:12:09.442Z",
    "roles": ["OPERATOR"]
  },
  {
    "id": "d47b2e19-8c3f-4a61-b5d0-7e9f1a2c3b42",
    "firstName": "Jorge",
    "lastName": "Condori",
    "email": "jorge.condori@example.com",
    "isActive": true,
    "lastLoginAt": "2026-11-02T22:31:17.060Z",
    "createdAt": "2026-09-02T16:47:51.902Z",
    "updatedAt": "2026-11-02T22:31:17.061Z",
    "roles": ["OWNER"]
  },
  {
    "id": "5b0e7c3a-2f41-4d8e-9a6b-1c3d5e7f9a20",
    "firstName": "Rosa",
    "lastName": "Mamani",
    "email": "rosa.mamani@example.com",
    "isActive": true,
    "lastLoginAt": "2026-11-03T15:20:41.233Z",
    "createdAt": "2026-07-30T05:20:11.000Z",
    "updatedAt": "2026-11-03T15:20:41.234Z",
    "roles": ["ADMIN"]
  }
]
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. bk-crm le responde `Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado` o `Sesión no válida o expirada` (token ausente, inválido o vencido; usuario inactivo; sesión revocada o vencida), pero esos textos no llegan al navegador. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario autenticado no tiene el rol ADMIN (OWNER, OPERATOR o SUPPORT) |

**Efectos**: ninguno (solo lectura).

**Notas para el frontend**

- Devuelve todos los usuarios, incluidos los inactivos. Si dos usuarios tienen el mismo `createdAt`, el orden entre ellos no está garantizado; `sortUsers` vuelve a ordenar en el cliente por `createdAt`, sin desempate.
- Filtra y pagina en el cliente. Por ejemplo, `OwnerValidationCard` usa `approvalCandidates` para quedarse con los usuarios activos con rol OWNER al elegir el responsable de aprobación.
- `updatedAt` también cambia en cada login, porque se actualiza `lastLoginAt`.
- `lastLoginAt` es `null` si el usuario nunca inició sesión (en la UI, «Nunca»). Muestra las fechas en el `timeZone` del restaurante (`formatDayTime`, `lastAccessText`).
- OWNER y OPERATOR reciben 403, así que con esta ruta no pueden convertir en un nombre el `authorUserId` de un mensaje ni los `createdById`, `reviewedById` o `editedById` de un borrador de Samanta (ver [Preguntas abiertas](#preguntas-abiertas)). No lo necesitan para las asignaciones, las observaciones ni las reprogramaciones: `assignedUser`, `author` y `changedBy` ya traen el nombre.

## Ver el detalle de un usuario
`GET /users/:id`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `User` |
| ft-crm | Nueva: `usersApi.get(id: Uuid, signal?: AbortSignal): Promise<User>`, implementada como ``apiFetch<User>(`/users/${id}`, { signal })`` |
| Caché | Nueva: `qk.user(id)` = `["users", "detail", id]`. Cuelga de `qk.users`, así que invalidar `qk.users` también la invalida. |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` de un ADMIN (lo pone el BFF) |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | `ParseUUIDPipe`: acepta cualquier versión de UUID, en minúsculas o mayúsculas. El `id` se guarda como texto en minúsculas: usa el valor tal como lo devuelve la API, porque un UUID en mayúsculas pasa la validación pero responde 404. |

**Ejemplo de petición**

```ts
const user = await usersApi.get("a3f1c9e2-6b7d-4e58-8c19-0d2e4f6a8b31"); // GET /api/backend/users/a3f1c9e2-…
```

**Respuesta**

```json
{
  "id": "a3f1c9e2-6b7d-4e58-8c19-0d2e4f6a8b31",
  "firstName": "Carlos",
  "lastName": "Huamán",
  "email": "carlos.huaman@example.com",
  "isActive": true,
  "lastLoginAt": "2026-11-03T13:12:09.441Z",
  "createdAt": "2026-10-21T14:05:33.208Z",
  "updatedAt": "2026-11-03T13:12:09.442Z",
  "roles": ["OPERATOR"]
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` (string) | `:id` no es un UUID |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. bk-crm le responde `Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado` o `Sesión no válida o expirada` (token ausente, inválido o vencido; usuario inactivo; sesión revocada o vencida), pero esos textos no llegan al navegador. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario autenticado no tiene el rol ADMIN (OWNER, OPERATOR o SUPPORT). Los guards actúan antes que la validación del `:id`. |
| 404 | `Usuario no encontrado` | No existe un usuario con ese `id` |

**Efectos**: ninguno (solo lectura).

**Notas para el frontend**

- Devuelve lo mismo que una fila de `GET /users`. También devuelve usuarios inactivos (`isActive: false`).
- Sirve para una pantalla de detalle o edición. Para la lista ya basta `GET /users`.
- Al añadir `usersApi.get`, añade también su handler en `src/lib/mock/server.ts`. Hoy el mock no tiene esta ruta y responde 404 `Cannot GET /users/<id>`.
- Propuesta para `src/lib/api/endpoints.ts` y `src/lib/api/query-keys.ts`, con el mismo estilo que las funciones existentes (`get` y `update` son nuevas; compila con los tipos de [Tipos TypeScript](#tipos-typescript)):

  ```ts
  // endpoints.ts: añade Uuid y UpdateUserRequest (este último, nuevo en types.ts) al import de "./types".
  export const usersApi = {
    list: () => apiFetch<User[]>("/users"),
    /** Nueva: GET /users/:id */
    get: (id: Uuid, signal?: AbortSignal) => apiFetch<User>(`/users/${id}`, { signal }),
    create: (body: CreateUserRequest) => apiFetch<User>("/users", { method: "POST", body }),
    /** Nueva: PATCH /users/:id. Envía solo los campos que cambian. */
    update: (id: Uuid, body: UpdateUserRequest) => apiFetch<User>(`/users/${id}`, { method: "PATCH", body }),
    setActive: (id: string, isActive: boolean) =>
      apiFetch<User>(`/users/${id}/status`, { method: "PATCH", body: { isActive } }),
    setRoles: (id: string, roles: RoleCode[]) => apiFetch<User>(`/users/${id}/roles`, { method: "PATCH", body: { roles } }),
  };

  // query-keys.ts, junto a `users`:
  // user: (id: string) => ["users", "detail", id] as const,
  ```

## Editar los datos de un usuario
`PATCH /users/:id`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `User` |
| ft-crm | Nueva: `usersApi.update(id: Uuid, body: UpdateUserRequest): Promise<User>`, implementada como ``apiFetch<User>(`/users/${id}`, { method: "PATCH", body })`` |
| Caché | Guarda la respuesta en `qk.user(id)` (nueva) y en la fila de `qk.users`, o invalida `qk.users`. Si `id` es el del usuario autenticado, invalida `qk.me`. Si cambió el nombre, invalida también `qk.conversationsAll` y `qk.reservationsAll`, que muestran el nombre embebido. Si cambió el nombre o el email, invalida `qk.config`: `approvalResponsible` trae nombre, apellido y email. |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` de un ADMIN (lo pone el BFF) y `Content-Type: application/json` (lo pone `apiFetch`) |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | `ParseUUIDPipe` (cualquier versión). Usa el `id` tal como lo devuelve la API: en mayúsculas responde 404. |

**Body**: envía al menos uno de estos campos, solo los que cambian.

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `firstName` | string | No | `@IsString()`, al menos un carácter no blanco (`firstName no puede contener solo espacios`) y `@MaxLength(100)`, medido antes del `trim`. Se guarda con `trim`. No admite `null` ni `""`. |
| `lastName` | string | No | Las mismas reglas que `firstName`, con el mensaje `lastName no puede contener solo espacios`. Se guarda con `trim`. No admite `null` ni `""`. |
| `email` | string | No | `@IsEmail()` y `@MaxLength(320)`. En la práctica `@IsEmail()` ya limita el email a 254 caracteres y rechaza los espacios alrededor. Se guarda en minúsculas y debe ser único; se puede reenviar el email actual del propio usuario. No admite `null`. |

Los campos opcionales se validan solo si están presentes (`@ValidateIf(value !== undefined)`): omitirlos no es lo mismo que enviarlos en `null`, que responde 400. Cualquier otro campo (`password`, `roles`, `isActive`, `id`, `createdAt`…) responde 400 `property <campo> should not exist`.

**Ejemplo de petición**

```ts
const user = await usersApi.update("a3f1c9e2-6b7d-4e58-8c19-0d2e4f6a8b31", { firstName: "Carlos Alberto" });
```

```json
{
  "firstName": "Carlos Alberto"
}
```

**Respuesta**

```json
{
  "id": "a3f1c9e2-6b7d-4e58-8c19-0d2e4f6a8b31",
  "firstName": "Carlos Alberto",
  "lastName": "Huamán",
  "email": "carlos.huaman@example.com",
  "isActive": true,
  "lastLoginAt": "2026-11-03T13:12:09.441Z",
  "createdAt": "2026-10-21T14:05:33.208Z",
  "updatedAt": "2026-11-03T15:46:27.905Z",
  "roles": ["OPERATOR"]
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` (array) | El body trae campos no editables (`password`, `roles`, `isActive`, etc.) |
| 400 | `firstName must be shorter than or equal to 100 characters`; `firstName no puede contener solo espacios`; `firstName must be a string` (array, en este orden; lo mismo para `lastName`) | El campo llega en `null` o no es string: llegan los tres. `""` o solo espacios: solo `no puede contener solo espacios`. Más de 100 caracteres: solo `must be shorter…` |
| 400 | `email must be shorter than or equal to 320 characters`; `email must be an email` (array, en este orden) | `email` llega en `null`, no es string o supera 320 caracteres: llegan los dos. Mal formado (también `""`), con espacios alrededor, con más de 254 caracteres o con más de 64 antes de la `@`: solo `email must be an email` |
| 400 | Texto del parser JSON (string) | JSON mal formado |
| 400 | `Validation failed (uuid is expected)` (string) | `:id` no es un UUID |
| 400 | `Debes proporcionar al menos un campo para actualizar` (string) | El body está vacío (`{}`) y el usuario existe |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. bk-crm le responde `Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado` o `Sesión no válida o expirada` (token ausente, inválido o vencido; usuario inactivo; sesión revocada o vencida), pero esos textos no llegan al navegador. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario autenticado no tiene el rol ADMIN (OWNER, OPERATOR o SUPPORT) |
| 404 | `Usuario no encontrado` | No existe un usuario con ese `id`. Se comprueba antes que el body vacío y que el email duplicado. |
| 409 | `Ya existe un usuario registrado con este correo` | El email pertenece a otro usuario, comparado en minúsculas. También si otro usuario lo toma a la vez. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` | El `Content-Type` declara un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) |

**Efectos**

- Actualiza solo los campos enviados y cambia `updatedAt`, aunque el valor sea el mismo.
- Los nombres del usuario aparecen embebidos en otros recursos, que se leen en cada consulta:
  - `assignedUser` de conversaciones y reservas;
  - el autor de las observaciones (`author`) y de las reprogramaciones (`changedBy`) de una reserva;
  - `approvalResponsible` de `GET /restaurant-config`, que además trae el email.

  La siguiente lectura de esos recursos ya trae los datos nuevos.
- Cambiar el email no cierra sesiones: el usuario seguirá conectado y usará el email nuevo en su próximo login.

**Notas para el frontend**

- Es una actualización parcial: envía solo los campos que cambiaron, ya recortados y con el email en minúsculas. Nunca envíes `null` ni `""` para "no cambiar": omite el campo.
- No cambia la contraseña, el estado ni los roles; para eso están las rutas específicas. No hay endpoint para que un ADMIN cambie la contraseña de otro usuario.
- Funciona también con usuarios inactivos.
- Mapea los mensajes de validación por su primera palabra (`firstName`, `lastName`, `email`) y el 409 al campo email.
- Al añadir `usersApi.update`, añade también su handler en `src/lib/mock/server.ts`. Hoy el mock responde 404 `Cannot PATCH /users/<id>`. El `usersApi` propuesto completo está en [Ver el detalle de un usuario](#ver-el-detalle-de-un-usuario).

## Activar o desactivar un usuario
`PATCH /users/:id/status`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `User` |
| ft-crm | `usersApi.setActive(id: string, isActive: boolean): Promise<User>` (existe). La usa el interruptor «Activo» de `UsuariosView`. |
| Caché | `UsuariosView` ya actualiza `qk.users` de forma optimista, la revierte si hay error y la invalida al terminar. Actualiza también `qk.user(id)` (nueva) e invalida `qk.conversationsAll` y `qk.reservationsAll`, que muestran `assignedUser.isActive` e `isEligible`. |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` de un ADMIN (lo pone el BFF) y `Content-Type: application/json` (lo pone `apiFetch`) |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | `ParseUUIDPipe` (cualquier versión). Usa el `id` tal como lo devuelve la API: en mayúsculas responde 404. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `isActive` | boolean | Sí | `@IsBoolean()`. Tiene que ser un booleano JSON real: `"true"`, `1` o `null` responden 400. |

Cualquier otro campo responde 400 `property <campo> should not exist`.

**Ejemplo de petición**

```ts
const user = await usersApi.setActive("a3f1c9e2-6b7d-4e58-8c19-0d2e4f6a8b31", false);
```

```json
{
  "isActive": false
}
```

**Respuesta**

```json
{
  "id": "a3f1c9e2-6b7d-4e58-8c19-0d2e4f6a8b31",
  "firstName": "Carlos",
  "lastName": "Huamán",
  "email": "carlos.huaman@example.com",
  "isActive": false,
  "lastLoginAt": "2026-11-03T13:12:09.441Z",
  "createdAt": "2026-10-21T14:05:33.208Z",
  "updatedAt": "2026-11-03T15:48:52.336Z",
  "roles": ["OPERATOR"]
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `isActive must be a boolean value` (array) | El campo falta, es `null` o no es booleano |
| 400 | `property <campo> should not exist` (array) | El body trae otros campos |
| 400 | Texto del parser JSON (string) | JSON mal formado |
| 400 | `Validation failed (uuid is expected)` (string) | `:id` no es un UUID |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. bk-crm le responde `Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado` o `Sesión no válida o expirada` (token ausente, inválido o vencido; usuario inactivo; sesión revocada o vencida), pero esos textos no llegan al navegador. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario autenticado no tiene el rol ADMIN (OWNER, OPERATOR o SUPPORT) |
| 404 | `Usuario no encontrado` | No existe un usuario con ese `id` |
| 409 | `No se puede desactivar al último administrador activo` | Se intenta desactivar a un ADMIN activo y no hay otro ADMIN activo |
| 409 | `La operación entró en conflicto con otro cambio; inténtalo nuevamente` | Otra transacción simultánea entró en conflicto (transacción `Serializable`). Se puede reintentar. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` | El `Content-Type` declara un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) |

**Efectos**

- Cambia `isActive` y `updatedAt`, también si el estado no cambia.
- Con `isActive: false` revoca en la misma transacción todas las sesiones activas del usuario: sus tokens responden 401 de inmediato. Mientras siga inactivo:
  - no puede iniciar sesión (401 `Correo o contraseña incorrectos`);
  - `forgot-password` no le envía correo;
  - sus enlaces de recuperación pendientes responden 400.
- Con `isActive: true` no recupera las sesiones anteriores: el usuario tiene que iniciar sesión de nuevo.
- No libera sus asignaciones. Las conversaciones y reservas que tenía asignadas siguen con `assignedUser`, ahora con `isActive: false` e `isEligible: false`.
- No comprueba si es el responsable de aprobación del restaurante. Si lo es, `GET /restaurant-config` lo sigue mostrando, pero `PUT /restaurant-config` responde 400 `El responsable de aprobación debe estar activo` hasta que se elija otro.

**Notas para el frontend**

- Enviar el mismo estado que ya tiene el usuario es válido y responde 200.
- Un ADMIN puede desactivarse a sí mismo si hay otro ADMIN activo. Su propia sesión se revoca y la siguiente petición termina en `SESSION_EXPIRED`, que lleva al login. `UsuariosView` ya pide confirmación antes.
- Muestra el mensaje de los 409 tal cual. El de conflicto admite reintento; el del último ADMIN, no.
- Si el usuario es el responsable de aprobación (`approvalResponsibleId` de la configuración), avisa antes de desactivarlo: Ajustes > Samanta lo marcará como «ya no es válido».

## Reemplazar los roles de un usuario
`PATCH /users/:id/roles`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `User` |
| ft-crm | `usersApi.setRoles(id: string, roles: RoleCode[]): Promise<User>` (existe; ninguna pantalla la usa todavía) |
| Caché | Guarda la respuesta en la fila de `qk.users` (o invalídala) y en `qk.user(id)` (nueva). Si `id` es el del usuario autenticado, invalida `qk.me`. Invalida `qk.conversationsAll` y `qk.reservationsAll` si cambió ADMIN u OPERATOR, porque cambia `assignedUser.isEligible`. |
| Cabeceras y límites | `Authorization: Bearer <accessToken>` de un ADMIN (lo pone el BFF) y `Content-Type: application/json` (lo pone `apiFetch`) |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | `ParseUUIDPipe` (cualquier versión). Usa el `id` tal como lo devuelve la API: en mayúsculas responde 404. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `roles` | `RoleCode[]` | Sí | `@IsArray()`, `@ArrayMinSize(1)`, `@ArrayUnique()` y cada valor debe ser `ADMIN`, `OWNER`, `OPERATOR` o `SUPPORT`, en mayúsculas. Es la lista final completa. No admite `null`. |

Cualquier otro campo responde 400 `property <campo> should not exist`.

**Ejemplo de petición**

```ts
const user = await usersApi.setRoles("d47b2e19-8c3f-4a61-b5d0-7e9f1a2c3b42", ["OWNER", "OPERATOR"]);
```

```json
{
  "roles": ["OWNER", "OPERATOR"]
}
```

**Respuesta**

```json
{
  "id": "d47b2e19-8c3f-4a61-b5d0-7e9f1a2c3b42",
  "firstName": "Jorge",
  "lastName": "Condori",
  "email": "jorge.condori@example.com",
  "isActive": true,
  "lastLoginAt": "2026-11-02T22:31:17.060Z",
  "createdAt": "2026-09-02T16:47:51.902Z",
  "updatedAt": "2026-11-02T22:31:17.061Z",
  "roles": ["OWNER", "OPERATOR"]
}
```

`updatedAt` no cambia: los roles se guardan en otra tabla.

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `each value in roles must be one of the following values: ADMIN, OWNER, OPERATOR, SUPPORT`; `All roles's elements must be unique`; `roles must contain at least 1 elements`; `roles must be an array` (array, en este orden) | `roles` falta, es `null` o no es array (p. ej. `"admin"`, `5` o `{}`): llegan los cuatro; si es un string con un rol válido (`"ADMIN"`), los tres últimos. `[]`: solo `at least 1 elements`. Rol repetido: solo `must be unique`. Un valor fuera del enum dentro del array (p. ej. `["admin"]`): solo `each value in roles…` |
| 400 | `property <campo> should not exist` (array) | El body trae otros campos |
| 400 | Texto del parser JSON (string) | JSON mal formado |
| 400 | `Validation failed (uuid is expected)` (string) | `:id` no es un UUID |
| 400 | `Uno o más roles no están disponibles` (string) | Algún rol no existe en la tabla `roles` (no se ejecutó el seed). Se comprueba antes de buscar al usuario. |
| 400 | `Debes asignar al menos un rol` (string) | Comprobación defensiva del servicio. No llega por HTTP: antes responde la validación `roles must contain at least 1 elements`. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. bk-crm le responde `Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado` o `Sesión no válida o expirada` (token ausente, inválido o vencido; usuario inactivo; sesión revocada o vencida), pero esos textos no llegan al navegador. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario autenticado no tiene el rol ADMIN (OWNER, OPERATOR o SUPPORT) |
| 404 | `Usuario no encontrado` | No existe un usuario con ese `id` |
| 409 | `No se puede retirar el rol al último administrador activo` | El usuario está activo, tiene ADMIN, la lista nueva no incluye `ADMIN` y no hay otro ADMIN activo |
| 409 | `La operación entró en conflicto con otro cambio; inténtalo nuevamente` | Otra transacción simultánea entró en conflicto (transacción `Serializable`). Se puede reintentar. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb |
| 415 | `unsupported charset "<CHARSET>"` | El `Content-Type` declara un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) |

**Efectos**

- Borra los roles del usuario y crea los nuevos en la misma transacción. No cambia `updatedAt`.
- No revoca sesiones. El cambio surte efecto en la siguiente petición del usuario, porque los roles se leen de la base de datos en cada petición. El claim `roles` del JWT queda desactualizado hasta la próxima renovación.
- `assignedUser.isEligible` de sus conversaciones y reservas se recalcula al leerlas: es `true` solo si el usuario está activo y tiene ADMIN u OPERATOR. Las asignaciones existentes no se liberan.
- No comprueba si es el responsable de aprobación del restaurante. Si se le quita OWNER, `PUT /restaurant-config` responde 400 `El responsable de aprobación debe tener el rol OWNER` hasta que se elija otro.

**Notas para el frontend**

- Reemplaza la lista completa, no agrega: para sumar un rol, envía los actuales más el nuevo.
- Un ADMIN puede quitarse su propio rol ADMIN si hay otro ADMIN activo. Desde su siguiente petición, `/users` le responde 403: refresca `qk.me` y la navegación.
- Los roles se validan contra la base de datos antes de buscar al usuario, así que el 400 `Uno o más roles no están disponibles` puede llegar antes que un 404.
- El orden de `roles` en la respuesta no está garantizado.

## Modelos

Las fechas son instantes ISO 8601 en UTC con milisegundos (`IsoDateTime`). Muéstralas en el `timeZone` del restaurante (ver [Fechas](README.md#fechas-zona-horaria-e-importes)).

### `User`

Lo devuelven todas las rutas `/users`. Sale de `publicUserSelect` y `serializeUser` (`src/users/users.service.ts`).

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Identificador. Prisma lo genera en minúsculas. |
| `firstName` | string | No | Nombre, guardado con `trim`. De 1 a 100 caracteres. |
| `lastName` | string | No | Apellido, guardado con `trim`. De 1 a 100 caracteres. |
| `email` | string | No | Email único, en minúsculas. Es el usuario del login. |
| `isActive` | boolean | No | Si es `false`, no puede iniciar sesión y sus sesiones están revocadas. Los usuarios nuevos empiezan en `true`. |
| `lastLoginAt` | `IsoDateTime` | Sí | Último login exitoso; `null` si nunca inició sesión. El refresh no lo cambia. |
| `createdAt` | `IsoDateTime` | No | Fecha de alta. |
| `updatedAt` | `IsoDateTime` | No | Última modificación de la fila. Cambia con cada login, con `PATCH /users/:id` y `/status` y al restablecer la contraseña (`POST /auth/reset-password`); no cambia con `PATCH /users/:id/roles`. |
| `roles` | `RoleCode[]` | No | Al menos uno, sin repetidos. Orden no garantizado. |

Nunca incluye `password` ni `passwordHash`.

### `LoginUser`

Va dentro de `LoginResponse` y de la respuesta `{ user }` del BFF.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del usuario |
| `firstName` | string | No | Nombre |
| `lastName` | string | No | Apellido |
| `email` | string | No | Email en minúsculas |
| `roles` | `RoleCode[]` | No | Roles en el momento del login. Orden no garantizado. |

### `LoginResponse`

201 de `POST /auth/login`. Solo la ve el BFF.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `accessToken` | string | No | JWT HS256 firmado con `JWT_SECRET`. Dura `JWT_EXPIRES_IN` (`15m` en `.env.example`). |
| `refreshToken` | string | No | JWT HS256 firmado con `JWT_REFRESH_SECRET`. Dura `JWT_REFRESH_EXPIRES_IN` (`7d` en `.env.example`). Es de un solo uso. |
| `user` | `LoginUser` | No | Datos del usuario |

### `RefreshResponse`

201 de `POST /auth/refresh`. Solo la ve el BFF.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `accessToken` | string | No | Access token nuevo, con el email y los roles actuales |
| `refreshToken` | string | No | Refresh token nuevo. El anterior deja de servir. |

### Claims de los tokens (`AccessTokenClaims`, `RefreshTokenClaims`)

Solo el BFF los lee: decodifica `exp` sin verificar la firma para renovar a tiempo (`src/lib/server/tokens.ts`).

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `sub` | `Uuid` | No | Id del usuario (ambos tokens) |
| `sessionId` | `Uuid` | No | Id de la sesión (ambos tokens) |
| `email` | string | No | Solo en el access token. Email al emitirlo: puede quedar desactualizado. |
| `roles` | `RoleCode[]` | No | Solo en el access token. Roles al emitirlo: pueden quedar desactualizados. |
| `jti` | `Uuid` | No | Solo en el refresh token. Identificador único de cada refresh token. |
| `iat` | number | No | Emisión, en segundos Unix |
| `exp` | number | No | Expiración, en segundos Unix |

### `MeResponse`

200 de `GET /auth/me`. Sale de `AccessTokenStrategy.validate` (`src/strategies/access-token.strategy.ts`).

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del usuario |
| `sessionId` | `Uuid` | No | Sesión del access token usado |
| `firstName` | string | No | Nombre actual |
| `lastName` | string | No | Apellido actual |
| `email` | string | No | Email actual, en minúsculas |
| `roles` | `RoleCode[]` | No | Roles actuales, leídos de la base de datos. Orden no garantizado. |

### Respuestas con `message` (`MessageResponse`)

| Ruta | Tipo | `message` |
|---|---|---|
| `POST /auth/logout` | `LogoutResponse` | `Sesión cerrada correctamente` |
| `GET /auth/test-admin` | `TestAdminResponse` | `Acceso autorizado para administrador` |
| `POST /auth/forgot-password` | `ForgotPasswordResponse` | `Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña` |
| `POST /auth/reset-password` | `ResetPasswordResponse` | `Contraseña restablecida correctamente` |

### `HealthResponse`

200 o 503 de `GET /health`.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `status` | `"ok"` o `"error"` | No | `ok` con respuesta 200; `error` con respuesta 503 |
| `services.api` | `"up"` | No | Siempre `up`: si la ruta responde, la API está arriba |
| `services.database` | `"up"` o `"down"` | No | Resultado de `SELECT 1`, con un límite de 3 s |
| `timestamp` | `IsoDateTime` | No | Instante de la comprobación |
| `uptimeSeconds` | number | No | Segundos enteros desde que arrancó el proceso |

### Respuestas de los handlers del BFF

| Handler | Éxito | Tipo |
|---|---|---|
| `POST /api/auth/login` | 200 `{ user }` y cookies `crm_at` y `crm_rt` | `BffLoginResponse` |
| `POST /api/auth/logout` | Siempre 200 `{ ok: true }`; borra las cookies | `BffLogoutResponse` |
| `POST /api/auth/forgot-password` | 200 `{ message }`, con punto final | `BffForgotPasswordResponse` |
| `POST /api/auth/reset-password` | 200 `{ message }`, con punto final | `BffResetPasswordResponse` |
| `GET /api/listo` | 200 `{ estado: "ok", backend }`; 503 `{ estado: "error", backend, motivo? }` | `ReadyResponse` |

Los errores de los handlers `/api/auth/*` tienen la forma `{ statusCode, message, code? }` (`ApiErrorBody`), con `message` siempre string. El 503 de `/api/listo` no: su body es el propio `ReadyResponse`.

## Estados y transiciones

### Estado del usuario (`isActive`)

| Valor | Significado |
|---|---|
| `true` | Activo. Puede iniciar sesión, renovar tokens y recuperar su contraseña. Si además tiene ADMIN u OPERATOR, se le pueden asignar conversaciones y reservas. |
| `false` | Inactivo. El login responde 401 `Correo o contraseña incorrectos`, sus tokens 401 `Usuario no autorizado` y `forgot-password` no le envía correo; sus enlaces pendientes responden 400. Sigue apareciendo en `GET /users`. |

| Transición | Ruta | Roles | Reglas y error |
|---|---|---|---|
| Alta → `true` | `POST /users` | ADMIN | Todo usuario nuevo empieza activo |
| `true` → `false` | `PATCH /users/:id/status` con `{ "isActive": false }` | ADMIN | 409 `No se puede desactivar al último administrador activo` si es el único ADMIN activo. Revoca todas sus sesiones. |
| `false` → `true` | `PATCH /users/:id/status` con `{ "isActive": true }` | ADMIN | Siempre permitida. No recupera las sesiones anteriores. |
| Mismo valor | `PATCH /users/:id/status` | ADMIN | Responde 200 y solo cambia `updatedAt` |

- Con otro rol, la respuesta es 403 `No tienes permisos para realizar esta acción`.
- Un conflicto entre transacciones simultáneas responde 409 `La operación entró en conflicto con otro cambio; inténtalo nuevamente`.
- Transiciones automáticas: ninguna. El sistema nunca desactiva usuarios por su cuenta.

### Roles (`RoleCode`)

| Valor | Nombre en el seed | Descripción en el seed | Acceso (detalle en [Roles](README.md#roles)) |
|---|---|---|---|
| `ADMIN` | Administrador | Acceso completo al CRM | Todo. Es el único rol que gestiona usuarios. |
| `OWNER` | Propietario | Responsable de validación y configuración | Solo lectura en los módulos de negocio. Puede ser el responsable de aprobación del restaurante. |
| `OPERATOR` | Operador | Gestiona calendario, clientes y reservas | Lectura y operación diaria |
| `SUPPORT` | Soporte EYAQ | Acceso técnico, soporte y revisión de errores | Solo `GET /auth/me`, `POST /auth/logout` y las rutas públicas |

- La lista inicial se fija en `POST /users`, y `PATCH /users/:id/roles` la reemplaza entera. Las dos rutas son solo para ADMIN.
- La lista no puede quedar vacía ni repetir roles.
- Si el usuario está activo y es el único ADMIN activo, quitarle ADMIN responde 409 `No se puede retirar el rol al último administrador activo`.
- Transiciones automáticas: ninguna.

### Sesión (interna)

No se expone como recurso: solo `GET /auth/me` devuelve su `sessionId`.

| Estado | Cómo se llega | Qué responde |
|---|---|---|
| Activa | `POST /auth/login` | Las rutas protegidas aceptan su access token, y `POST /auth/refresh` rota sus tokens |
| Revocada | `POST /auth/logout` (solo esa sesión), `PATCH /users/:id/status` con `false` o `POST /auth/reset-password` (todas las del usuario) | El access token recibe 401 `Sesión no válida o expirada`, o `Usuario no autorizado` si el usuario está inactivo. El refresh recibe 401 `Sesión revocada`. |
| Vencida | Automático, 7 días después del login (el refresh no lo alarga) | El access token recibe 401 `Sesión no válida o expirada` (o `Unauthorized` si el token ya expiró). El refresh recibe 401 `Sesión expirada`, o `Refresh token inválido o expirado` si el propio refresh token también venció (con `JWT_REFRESH_EXPIRES_IN=7d`, el emitido en el login vence casi a la vez que la sesión). |

Una sesión revocada o vencida no vuelve a activarse: hay que iniciar sesión de nuevo.

### Enlace de recuperación (interno)

| Estado | Cómo se llega | Qué responde `POST /auth/reset-password` |
|---|---|---|
| Pendiente | `POST /auth/forgot-password` de un usuario activo | 200 si el usuario sigue activo; si no, 400 `El enlace de recuperación es inválido o ha expirado` |
| Usado | `POST /auth/reset-password` con éxito | 400 `El enlace de recuperación es inválido o ha expirado` |
| Vencido | Automático, a los `PASSWORD_RESET_TOKEN_TTL_MINUTES` minutos (15 por defecto) | 400, mismo mensaje |
| Borrado | Otro `forgot-password` del mismo usuario, un reset exitoso con otro enlace o un fallo al enviar el correo | 400, mismo mensaje |

### Salud del servicio (`HealthResponse.status`)

| Valor | `services.database` | Código |
|---|---|---|
| `ok` | `up` | 200 |
| `error` | `down` | 503 |

No hay transiciones por ruta: cada `GET /health` comprueba la base de datos en el momento.

## Preguntas abiertas

1. ¿Qué valores de `JWT_EXPIRES_IN` y `JWT_REFRESH_EXPIRES_IN` usa cada entorno? El README de bk-crm recomienda `15m` y `7d` para producción, igual que `.env.example`. La UI no los necesita, porque el BFF lee `exp` de cada token, pero fijan cada cuánto renueva el BFF y cuánto dura la cookie `crm_rt`.
2. ¿Cuál es la URL base de bk-crm en cada entorno (dev, staging, producción)? ¿Algún proxy añadirá un prefijo como `/api`? En el código no hay prefijo global.
3. ¿Qué valor tendrá `FRONTEND_RESET_PASSWORD_URL` en cada entorno? En producción debe ser `https://<dominio del frontend>/reset-password`, y bk-crm no arranca si no es una URL `https` pública.
4. `GET /auth/test-admin` es un endpoint de prueba. ¿Se mantendrá o se eliminará antes de desplegar, como pide el README de bk-crm para los endpoints temporales?
5. No hay endpoint para listar roles (`RolesModule` está vacío). ¿El frontend debe mantener fija la lista `ADMIN`/`OWNER`/`OPERATOR`/`SUPPORT` con las etiquetas del seed, como hace hoy `ROLE_LABELS`?
6. `GET /users` no tiene paginación, filtros ni búsqueda; el README de bk-crm lo marca como pendiente. ¿Cambiará la respuesta a un `Paginated<User>`?
7. Reutilizar un refresh token que ya rotó devuelve 401 `Refresh token inválido`, pero no revoca la sesión. ¿Es intencional, o se planea revocarla al detectar la reutilización?
8. No hay endpoints para: cambiar la contraseña estando autenticado, que un ADMIN restablezca la contraseña de otro usuario, listar las sesiones o cerrarlas todas, ni enviar invitaciones por correo. ¿Están planificados?
9. El rol SUPPORT no figura en ningún `@Roles`: solo puede usar `/auth/me`, `/auth/logout` y las rutas públicas. En ft-crm no tiene ninguna vista. ¿Es intencional o faltan permisos de soporte?
10. bk-crm permite desactivar al responsable de aprobación o quitarle OWNER sin avisar. Después, `PUT /restaurant-config` responde 400 hasta que se elija otro. El README de bk-crm tiene pendiente definir esta política. ¿La UI debe advertirlo o impedirlo?
11. Desactivar a un usuario, o quitarle ADMIN y OPERATOR, no libera sus conversaciones ni reservas asignadas: quedan con `isEligible: false`. ¿Se deben reasignar? ¿Lo hará el backend o la UI?
12. `GET /users` es solo para ADMIN, así que OWNER y OPERATOR no pueden mostrar el nombre detrás del `authorUserId` de un mensaje ni de los `createdById`, `reviewedById` y `editedById` de un borrador de Samanta. ¿Se añadirá el nombre a la respuesta o un endpoint ligero de usuarios?
13. `password` y `newPassword` admiten hasta 72 caracteres, pero bcrypt solo usa los primeros 72 bytes en UTF-8. Con tildes, `ñ` o emojis, el final de una contraseña larga se ignora sin aviso. ¿El límite debería medirse en bytes, o la UI debería advertirlo?

## Tipos TypeScript

Bloque autocontenido: compila con `tsc --strict` y se puede copiar solo. Usa los nombres de `ft-crm/src/lib/api/types.ts` cuando el concepto ya existe allí. Los tipos compartidos (`Uuid`, `IsoDateTime`, `RoleCode`, `Pagination`, `Paginated<T>`, `ApiErrorBody`, `MessageResponse`) se repiten con la misma definición que ft-crm: en el frontend decláralos una sola vez. La única diferencia está en `ApiErrorBody`: añade los campos opcionales `path`, `method` y `timestamp` del 500, y acota `code` a los tres valores que pone el BFF (`BffErrorCode`).

Tipos nuevos respecto de ft-crm: `RefreshRequest`, `UpdateUserRequest`, `HealthResponse`, `ReadyResponse`, las respuestas con mensaje literal (`LogoutResponse`, `ForgotPasswordResponse`…), los claims de los tokens, los tipos `Bff*` y las uniones de mensajes de error.

```ts
/* =====================================================================
 * bk-crm · Autenticación, sesión, usuarios y salud (01-auth-usuarios.md)
 * Tipos derivados de los DTO, selects y servicios de bk-crm.
 * Los nombres coinciden con ft-crm/src/lib/api/types.ts cuando el concepto
 * ya existe allí. Bloque autocontenido: compila con --strict.
 * ===================================================================== */

/* ------------------------- Compartidos (iguales a ft-crm) ------------------------- */

export type Uuid = string;
/** Instante ISO 8601 en UTC con milisegundos, p. ej. "2026-11-03T15:20:41.233Z". */
export type IsoDateTime = string;

/**
 * Enum `RoleCode` de Prisma. Nombres del seed: ADMIN «Administrador», OWNER «Propietario»,
 * OPERATOR «Operador», SUPPORT «Soporte EYAQ». No hay endpoint para listarlos.
 */
export type RoleCode = "ADMIN" | "OWNER" | "OPERATOR" | "SUPPORT";

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  /** 0 cuando total = 0 */
  totalPages: number;
}

/** Envoltorio de los listados paginados de otros módulos. Las rutas de este módulo no paginan. */
export interface Paginated<T> {
  data: T[];
  pagination: Pagination;
}

/**
 * Cuerpo de error (filtro global de bk-crm y handlers del BFF).
 * `message` es string[] solo en el 400 de validación de DTO; en el resto, string.
 */
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  /** "Bad Request", "Unauthorized", "Forbidden", "Not Found", "Conflict", "Payload Too Large"…
   * No viene en el 401 genérico ("Unauthorized"), en el 429 ni en el 500. */
  error?: string;
  /** Solo lo añade el BFF de ft-crm. */
  code?: BffErrorCode;
  /** Solo en el 500 de bk-crm: ruta sin query string. */
  path?: string;
  /** Solo en el 500 de bk-crm. */
  method?: string;
  /** Solo en el 500 de bk-crm. */
  timestamp?: IsoDateTime;
}

export interface MessageResponse {
  message: string;
}

/* ------------------------------ Mensajes de error ------------------------------ */

/** 401 posibles en cualquier ruta protegida con access token. */
export type AccessTokenErrorMessage =
  | "Unauthorized"
  | "Token de acceso inválido"
  | "Usuario no autorizado"
  | "Sesión no válida o expirada";

/** 403 del RolesGuard: el usuario no tiene ninguno de los roles exigidos. */
export type ForbiddenMessage = "No tienes permisos para realizar esta acción";

/** 429 de login, forgot-password y reset-password (sin `error`; cabecera Retry-After). */
export type ThrottleErrorMessage = "ThrottlerException: Too Many Requests";

/** 413 del parser: body de más de 100 kb. */
export type PayloadTooLargeMessage = "El cuerpo de la petición supera el tamaño máximo permitido";

/** 400 de ParseUUIDPipe en las rutas /users/:id. */
export type InvalidUuidMessage = "Validation failed (uuid is expected)";

/** 500 del filtro global. */
export type InternalErrorMessage = "Ocurrió un error interno";

/* ----------------------------------- Raíz ----------------------------------- */

/** GET / responde texto (`text/html; charset=utf-8`), no JSON. */
export type AppRootResponse = "Hello World!";

/* ------------------------------ Autenticación ------------------------------ */

/** Body de POST /auth/login. */
export interface LoginRequest {
  /** Email válido, sin espacios alrededor; bk-crm lo pasa a minúsculas para buscar. */
  email: string;
  /** Mínimo 8 caracteres; el DTO no fija máximo (el BFF de ft-crm limita a 200). */
  password: string;
}

/** Usuario dentro de la respuesta del login. */
export interface LoginUser {
  id: Uuid;
  firstName: string;
  lastName: string;
  /** En minúsculas. */
  email: string;
  /** Orden no garantizado. */
  roles: RoleCode[];
}

/** 201 de POST /auth/login (bk-crm → BFF). El navegador nunca la ve completa. */
export interface LoginResponse {
  /** JWT HS256 firmado con JWT_SECRET; dura JWT_EXPIRES_IN. */
  accessToken: string;
  /** JWT firmado con JWT_REFRESH_SECRET; dura JWT_REFRESH_EXPIRES_IN; un solo uso. */
  refreshToken: string;
  user: LoginUser;
}

export type LoginErrorMessage = "Correo o contraseña incorrectos";

/** Body de POST /auth/refresh (solo lo envía el BFF). */
export interface RefreshRequest {
  /** Último refresh token emitido para la sesión. */
  refreshToken: string;
}

/** 201 de POST /auth/refresh: reemplaza ambos tokens. */
export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

/** 401 posibles en POST /auth/refresh. */
export type RefreshErrorMessage =
  | "Refresh token inválido o expirado"
  | "Sesión no válida"
  | "Sesión revocada"
  | "Sesión expirada"
  | "Refresh token inválido"
  | "Usuario no autorizado"
  | "Refresh token ya utilizado o sesión no válida";

/** 201 de POST /auth/logout. */
export interface LogoutResponse extends MessageResponse {
  message: "Sesión cerrada correctamente";
}

/** 200 de GET /auth/me: datos y roles actuales, leídos de la base de datos en cada petición. */
export interface MeResponse {
  id: Uuid;
  /** Sesión del access token usado. */
  sessionId: Uuid;
  firstName: string;
  lastName: string;
  /** En minúsculas. */
  email: string;
  /** Orden no garantizado. */
  roles: RoleCode[];
}

/** 200 de GET /auth/test-admin (endpoint de prueba, bloqueado por el BFF). */
export interface TestAdminResponse extends MessageResponse {
  message: "Acceso autorizado para administrador";
}

/** Claims del access token. Solo el BFF lee `exp` (sin verificar la firma) para renovar a tiempo. */
export interface AccessTokenClaims {
  /** Id del usuario. */
  sub: Uuid;
  sessionId: Uuid;
  /** Email al emitir el token: puede quedar desactualizado. */
  email: string;
  /** Roles al emitir el token: pueden quedar desactualizados. Usa GET /auth/me. */
  roles: RoleCode[];
  /** Emisión, en segundos Unix. */
  iat: number;
  /** Expiración, en segundos Unix. */
  exp: number;
}

/** Claims del refresh token. */
export interface RefreshTokenClaims {
  sub: Uuid;
  sessionId: Uuid;
  /** Identificador único de cada refresh token emitido. */
  jti: Uuid;
  iat: number;
  exp: number;
}

/** Body de POST /auth/forgot-password. */
export interface ForgotPasswordRequest {
  /** Email válido, sin espacios alrededor. El DTO declara máximo 320, pero @IsEmail() ya limita a 254. */
  email: string;
}

/** 200 de POST /auth/forgot-password: siempre la misma, exista o no el correo. */
export interface ForgotPasswordResponse extends MessageResponse {
  message: "Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña";
}

/** Body de POST /auth/reset-password. */
export interface ResetPasswordRequest {
  /** Parámetro `token` del enlace, sin modificar: 64 caracteres hexadecimales en minúsculas. */
  token: string;
  /** 8 a 72 caracteres. */
  newPassword: string;
}

/** 200 de POST /auth/reset-password. */
export interface ResetPasswordResponse extends MessageResponse {
  message: "Contraseña restablecida correctamente";
}

/** 400 en POST /auth/reset-password. */
export type ResetPasswordErrorMessage =
  | "El token de recuperación no tiene un formato válido"
  | "El enlace de recuperación es inválido o ha expirado";

/* ---------------------------------- Salud ---------------------------------- */

export type HealthStatus = "ok" | "error";
export type HealthServiceStatus = "up" | "down";

/** GET /health: 200 con status "ok" o 503 con status "error" (el 503 no trae `message`). */
export interface HealthResponse {
  status: HealthStatus;
  services: {
    api: "up";
    database: HealthServiceStatus;
  };
  timestamp: IsoDateTime;
  /** Segundos enteros desde que arrancó el proceso. */
  uptimeSeconds: number;
}

/* --------------------------------- Usuarios --------------------------------- */

/** Usuario de todas las rutas /users. Nunca incluye la contraseña ni su hash. */
export interface User {
  id: Uuid;
  firstName: string;
  lastName: string;
  /** Siempre en minúsculas. */
  email: string;
  isActive: boolean;
  /** null hasta el primer inicio de sesión. */
  lastLoginAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  /** Cambia con cada login (lastLoginAt), con cada PATCH /users/:id o /status y al restablecer la contraseña; no al reemplazar roles. */
  updatedAt: IsoDateTime;
  /** Al menos uno; orden no garantizado. */
  roles: RoleCode[];
}

/** 200 de GET /users: todos los usuarios, sin paginar, por createdAt desc. */
export type UserListResponse = User[];

/** Body de POST /users (201 · User). */
export interface CreateUserRequest {
  /** 1 a 100 caracteres (antes del trim), al menos uno no blanco; se guarda con trim. */
  firstName: string;
  /** 1 a 100 caracteres (antes del trim), al menos uno no blanco; se guarda con trim. */
  lastName: string;
  /** Email válido sin espacios alrededor (máximo 254 en la práctica); único; se guarda en minúsculas. */
  email: string;
  /** 8 a 72 caracteres; no se recorta. */
  password: string;
  /** Al menos uno, sin repetidos. */
  roles: RoleCode[];
}

/**
 * Body de PATCH /users/:id (200 · User). Envía al menos un campo.
 * Los que no cambian se omiten: nunca `null` ni "".
 */
export interface UpdateUserRequest {
  /** Máximo 100 caracteres, al menos uno no blanco; se guarda con trim. */
  firstName?: string;
  /** Máximo 100 caracteres, al menos uno no blanco; se guarda con trim. */
  lastName?: string;
  /** Email válido sin espacios alrededor; único; se guarda en minúsculas. */
  email?: string;
}

/** Body de PATCH /users/:id/status (200 · User). */
export interface UpdateUserStatusRequest {
  /** Booleano JSON real. `false` revoca todas las sesiones del usuario. */
  isActive: boolean;
}

/** Body de PATCH /users/:id/roles (200 · User). Reemplaza la lista completa. */
export interface UpdateUserRolesRequest {
  /** Al menos uno, sin repetidos. */
  roles: RoleCode[];
}

export type UserNotFoundMessage = "Usuario no encontrado";

/** 400 de negocio en las rutas /users (además de los de validación). */
export type UserBadRequestMessage =
  | "Debes proporcionar al menos un campo para actualizar"
  | "Uno o más roles no están disponibles"
  | "Debes asignar al menos un rol";

/** 409 posibles en las rutas /users. */
export type UserConflictMessage =
  | "Ya existe un usuario registrado con este correo"
  | "No se puede desactivar al último administrador activo"
  | "No se puede retirar el rol al último administrador activo"
  | "La operación entró en conflicto con otro cambio; inténtalo nuevamente";

/* ------------------------- Handlers del BFF de ft-crm ------------------------- */

/** `code` que añade el BFF; bk-crm nunca lo envía. */
export type BffErrorCode = "NO_SESSION" | "SESSION_EXPIRED" | "BACKEND_UNAVAILABLE";

/** 200 de POST /api/auth/login (además fija las cookies httpOnly crm_at y crm_rt). */
export interface BffLoginResponse {
  user: LoginUser;
}

/** 200 de POST /api/auth/logout (siempre; borra las cookies). */
export interface BffLogoutResponse {
  ok: true;
}

/** 200 de POST /api/auth/forgot-password: texto del BFF, con punto final. */
export interface BffForgotPasswordResponse extends MessageResponse {
  message: "Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.";
}

/** 200 de POST /api/auth/reset-password: texto del BFF, con punto final. */
export interface BffResetPasswordResponse extends MessageResponse {
  message: "Contraseña restablecida correctamente.";
}

/** GET /api/listo: 200 si bk-crm responde GET /health con 2xx (o en modo mock); 503 si no. */
export type ReadyResponse =
  | { estado: "ok"; backend: "disponible" | "simulado" }
  | { estado: "error"; backend: string; motivo?: "timeout" | "network" | "error" };
```

Las funciones y la clave de caché propuestas para `src/lib/api/` están en [Ver el detalle de un usuario](#ver-el-detalle-de-un-usuario).
