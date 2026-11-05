# Clientes, solicitudes de reserva y reservas (calendario)

> Parte de la [referencia de la API de bk-crm para el frontend](README.md). Estado: 3 de noviembre de 2026.
>
> Desde el navegador, cada ruta se pide con `apiFetch` como `/api/backend<ruta>`, y el BFF añade el token ([Arquitectura](README.md#arquitectura-navegador--bff--bk-crm)). Las convenciones comunes (errores, sesión, roles, paginación y fechas) están en el [README](README.md#convenciones-generales). Las propias de este módulo están en [Convenciones del módulo](#convenciones-del-módulo).

Este módulo gestiona tres cosas:
- la ficha de clientes: contacto, estado comercial e intereses del catálogo;
- las solicitudes de reserva, previas a la confirmación;
- las reservas confirmadas, que forman el calendario operativo.

Lo usan las pantallas de Clientes, Solicitudes, Calendario (día, semana y mes) y Estadísticas, y el panel del cliente en la Bandeja. Un usuario que solo tenga el rol `SUPPORT` no tiene acceso a ninguna ruta (403).

## Índice

Secciones generales:
- [Convenciones del módulo](#convenciones-del-módulo)
- [Modelos](#modelos)
- [Estados y transiciones](#estados-y-transiciones)
- [Preguntas abiertas](#preguntas-abiertas)
- [Tipos TypeScript](#tipos-typescript)

Rutas:
- [Crear cliente](#crear-cliente) — `POST /customers`
- [Listar clientes](#listar-clientes) — `GET /customers`
- [Ver detalle de cliente](#ver-detalle-de-cliente) — `GET /customers/:id`
- [Editar cliente](#editar-cliente) — `PATCH /customers/:id`
- [Cambiar estado del cliente](#cambiar-estado-del-cliente) — `PATCH /customers/:id/status`
- [Registrar interés del cliente](#registrar-interés-del-cliente) — `POST /customers/:id/interests`
- [Quitar interés del cliente](#quitar-interés-del-cliente) — `DELETE /customers/:id/interests/:commercialItemId`
- [Crear solicitud de reserva](#crear-solicitud-de-reserva) — `POST /reservation-requests`
- [Listar solicitudes de reserva](#listar-solicitudes-de-reserva) — `GET /reservation-requests`
- [Ver detalle de solicitud de reserva](#ver-detalle-de-solicitud-de-reserva) — `GET /reservation-requests/:id`
- [Editar solicitud de reserva](#editar-solicitud-de-reserva) — `PATCH /reservation-requests/:id`
- [Cancelar solicitud de reserva](#cancelar-solicitud-de-reserva) — `PATCH /reservation-requests/:id/status`
- [Crear reserva manual](#crear-reserva-manual) — `POST /reservations`
- [Listar reservas (calendario)](#listar-reservas-calendario) — `GET /reservations`
- [Ver detalle de reserva](#ver-detalle-de-reserva) — `GET /reservations/:id`
- [Editar reserva](#editar-reserva) — `PATCH /reservations/:id`
- [Cambiar estado de reserva](#cambiar-estado-de-reserva) — `PATCH /reservations/:id/status`
- [Asignar o liberar responsable](#asignar-o-liberar-responsable) — `PATCH /reservations/:id/assignee`
- [Agregar observación a la reserva](#agregar-observación-a-la-reserva) — `POST /reservations/:id/notes`
- [Reprogramar reserva](#reprogramar-reserva) — `PATCH /reservations/:id/reschedule`

## Convenciones del módulo

Lo común a todo el backend está en el README: [formato de errores](README.md#formato-de-errores), [validación](README.md#peticiones-respuestas-y-validación), [roles](README.md#roles), [paginación](README.md#paginación-y-orden) y [fechas e importes](README.md#fechas-zona-horaria-e-importes). Aquí va solo lo propio de este módulo.

### Acceso

- Lectura (`GET`): ADMIN, OWNER y OPERATOR. Escritura: ADMIN y OPERATOR. `POST /reservations` es solo para ADMIN.
- SUPPORT recibe 403 en todas las rutas del módulo.
- Basta con tener uno de los roles permitidos. Además, `PATCH /reservations/:id/assignee` limita lo que puede hacer un OPERATOR (ver la ruta).
- En ft-crm, `can(roles, "customer.edit")`, `can(roles, "request.cancel")` y `can(roles, "reservation.status")` ya cubren ADMIN y OPERATOR. Para crear reservas falta una acción solo para ADMIN (p. ej. `reservation.create`).

### Errores que ves desde el navegador

- **401.** El 401 de bk-crm nunca llega al navegador. El BFF renueva la sesión y repite la llamada; si no puede, responde `{ "statusCode": 401, "message": "Tu sesión terminó. Vuelve a iniciar sesión.", "code": "SESSION_EXPIRED" }`. Sin cookies responde `"message": "Inicia sesión para continuar."` con `"code": "NO_SESSION"`. Los mensajes de bk-crm (`Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado`, `Sesión no válida o expirada`) se quedan en el BFF (`src/lib/server/session.ts`).
- **503 y 504 `BACKEND_UNAVAILABLE`.** bk-crm no respondió: red, servidor caído o más de 15 s (`CRM_BACKEND_TIMEOUT_MS`). Ver [Errores que añade el BFF](README.md#errores-que-añade-el-bff). Distinto del 503 `La zona horaria del restaurante no es válida`, que sí viene de bk-crm.
- **400 de validación.** `message` es un arreglo con los textos en inglés de class-validator. Cada texto empieza por el nombre del campo (`phone must be ...`): úsalo para marcar el campo del formulario. `property <campo> should not exist` significa que el frontend envió un campo no declarado.
- **400 `Validation failed (uuid is expected)`.** Un `:id` de la ruta no es un UUID. Llega como texto, no como arreglo.
- **Errores de negocio.** `message` es un texto en español: muéstralo tal cual.
- **413 `El cuerpo de la petición supera el tamaño máximo permitido`.** El body pasa de 100 kb, por ejemplo con un texto pegado sin límite. Pon `maxLength` en los campos de texto (5000 en notas y comentarios).
- **415.** No ocurre con `apiFetch`, que siempre envía `content-type: application/json` sin `charset`.
- **429 e `Idempotency-Key`.** Este módulo no los usa.
- **«Defensivo»** en una tabla de errores: el código puede emitir ese mensaje, pero una validación o comprobación anterior lo evita, así que no debería llegar. Los que traduce un error de la base de datos (registro desaparecido, clave foránea o valor único) solo ocurrirían si alguien cambia los datos entre la comprobación y la escritura, o fuera de la API.
- **500 `Ocurrió un error interno`.** Si la base de datos rechaza una restricción `CHECK`, Prisma lo informa como `P2039` y ningún servicio lo traduce, así que llega como 500. Las validaciones del servicio lo evitan. Por eso `Los datos o referencias del cliente son inválidos` y `Datos o relaciones de reserva inválidos` solo pueden venir de una clave foránea rota.

### Orden de las comprobaciones

1. BFF: sesión (401).
2. Parser de JSON de Express: JSON mal formado (400) o body de más de 100 kb (413).
3. Token (401) y rol (403).
4. `:id` de la ruta (400 UUID) y luego body o query (400 de validación).
5. Reglas del servicio (400, 404, 409 y 503), en el orden que indica cada ruta.

### Campos de texto y `null`

- El backend recorta espacios (trim) en nombres, notas, comentarios, motivos y búsquedas. Si después del trim queda vacío, responde 400 `<campo> should not be empty`.
- `email` se recorta y pasa a minúsculas antes de validarse: `" Carlos.Quispe@Example.com "` es válido.
- No envíes `""` para decir «sin valor». En un POST, omite el campo; en un PATCH, envía `null` para borrarlo.
- En los PATCH, omitir un campo lo conserva y `null` lo borra, si el campo lo admite. Cada ruta indica qué campos no admiten `null`.
- No hay rutas `DELETE` para clientes, solicitudes ni reservas. Tampoco hay fusión de clientes.

### Fechas e identificadores

- Envía instantes ISO 8601 con segundos y zona; `toISOString()` sirve. La API responde en UTC. Muéstralos en el `timeZone` de `GET /restaurant-config` (`configApi.get()`, `useRestaurant()` en ft-crm).
- Una fecha sin zona, sin segundos, solo con el día o con más de 3 decimales responde 400 `<campo> must match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/ regular expression`. Una fecha imposible (30 de febrero) o un offset fuera de rango (`+25:00`) responde 400 `<campo> must be a valid ISO 8601 date string`.
- Los ids que genera el backend son UUID v4. En la ruta (`ParseUUIDPipe`) se acepta cualquier texto hexadecimal de la forma 8-4-4-4-12, sea cual sea la versión. En el body y en la query (`@IsUUID()`), el UUID debe tener versión 1 a 8 y variante RFC (el cuarto grupo empieza por `8`, `9`, `a` o `b`); también se aceptan el UUID nulo y el máximo. Si no, `<campo> must be a UUID`.

### Concurrencia y reintentos

- Las escrituras de solicitudes y reservas, y la edición e intereses de clientes, usan transacciones serializables con hasta 3 intentos. `POST /customers` y `PATCH /customers/:id/status` no usan transacción. Si el conflicto sigue tras los 3 intentos, la respuesta es 409 `Conflicto concurrente; vuelve a intentarlo`: refresca los datos y deja que la persona repita la acción.
- No hay control de versión: el backend no compara `updatedAt`, así que gana la última escritura válida.
- Ningún POST del módulo es idempotente. Si el BFF responde 504, la petición pudo haberse completado: refresca el listado antes de reintentar. `POST /customers` se protege solo (409 si el teléfono o el email ya existen), y `POST /customers/:id/interests` no duplica: actualiza el mismo interés y solo vuelve a mover `lastInterestedAt`. En cambio, `POST /reservation-requests`, `POST /reservations` y `POST /reservations/:id/notes` crean un registro nuevo en cada intento.

### Funciones y claves de caché en ft-crm

Estado propuesto de `src/lib/api/endpoints.ts`. Las funciones marcadas «nueva» aún no existen; las demás ya están en ft-crm:

```ts
export const customersApi = {
  list: (query: CustomerListQuery) => apiFetch<Paginated<Customer>>("/customers", { query }),
  get: (id: string) => apiFetch<CustomerDetail>(`/customers/${id}`),
  setStatus: (id: string, status: CustomerStatus) =>
    apiFetch<Customer>(`/customers/${id}/status`, { method: "PATCH", body: { status } }),
  // nueva
  create: (body: CreateCustomerRequest) => apiFetch<Customer>("/customers", { method: "POST", body }),
  // nueva
  update: (id: string, body: UpdateCustomerRequest) =>
    apiFetch<Customer>(`/customers/${id}`, { method: "PATCH", body }),
  // nueva
  addInterest: (id: string, body: CreateCustomerInterestRequest) =>
    apiFetch<CustomerInterest>(`/customers/${id}/interests`, { method: "POST", body }),
  // nueva: responde 204, apiFetch devuelve undefined
  removeInterest: (id: string, commercialItemId: string) =>
    apiFetch<void>(`/customers/${id}/interests/${commercialItemId}`, { method: "DELETE" }),
};

export const requestsApi = {
  list: (query: ReservationRequestListQuery) =>
    apiFetch<Paginated<ReservationRequest>>("/reservation-requests", { query }),
  get: (id: string) => apiFetch<ReservationRequest>(`/reservation-requests/${id}`),
  cancel: (id: string) =>
    apiFetch<ReservationRequest>(`/reservation-requests/${id}/status`, { method: "PATCH", body: { status: "CANCELLED" } }),
  // nueva
  create: (body: CreateReservationRequestBody) =>
    apiFetch<ReservationRequest>("/reservation-requests", { method: "POST", body }),
  // nueva
  update: (id: string, body: UpdateReservationRequestBody) =>
    apiFetch<ReservationRequest>(`/reservation-requests/${id}`, { method: "PATCH", body }),
};

export const reservationsApi = {
  list: (query: ReservationListQuery) => apiFetch<Paginated<Reservation>>("/reservations", { query }),
  get: (id: string) => apiFetch<ReservationDetail>(`/reservations/${id}`),
  setStatus: (id: string, status: ReservationStatusTarget) =>
    apiFetch<Reservation>(`/reservations/${id}/status`, { method: "PATCH", body: { status } }),
  // nueva (solo ADMIN)
  create: (body: CreateReservationBody) => apiFetch<Reservation>("/reservations", { method: "POST", body }),
  // nueva
  update: (id: string, body: UpdateReservationBody) =>
    apiFetch<Reservation>(`/reservations/${id}`, { method: "PATCH", body }),
  // nueva
  assign: (id: string, body: AssignReservationBody) =>
    apiFetch<Reservation>(`/reservations/${id}/assignee`, { method: "PATCH", body }),
  // nueva
  addNote: (id: string, content: string) =>
    apiFetch<ReservationNote>(`/reservations/${id}/notes`, {
      method: "POST",
      body: { content } satisfies CreateReservationNoteBody,
    }),
  // nueva
  reschedule: (id: string, body: RescheduleReservationBody) =>
    apiFetch<Reservation>(`/reservations/${id}/reschedule`, { method: "PATCH", body }),
};
```

Claves de `src/lib/api/query-keys.ts`:

| Clave | Valor | Estado | Uso |
|---|---|---|---|
| `qk.customers(query)` | `["customers", "list", query]` | Existe | `GET /customers` |
| `qk.customer(id)` | `["customers", "detail", id]` | Existe | `GET /customers/:id` |
| `qk.customersAll` | `["customers"]` | Existe | Invalida listados y fichas de clientes |
| `qk.requests(query)` | `["reservation-requests", "list", query]` | Existe | `GET /reservation-requests` |
| `qk.request(id)` | `["reservation-requests", "detail", id]` | **Nueva** | `GET /reservation-requests/:id` |
| `qk.requestsAll` | `["reservation-requests"]` | Existe | Invalida solicitudes |
| `qk.reservations(query)` | `["reservations", "list", query]` | Existe | `GET /reservations` |
| `qk.reservation(id)` | `["reservations", "detail", id]` | Existe | `GET /reservations/:id` |
| `qk.reservationsAll` | `["reservations"]` | Existe | Invalida listados y detalles de reservas |
| `qk.conversationsAll` | `["conversations"]` | Existe | Las conversaciones incluyen el resumen del cliente |
| `qk.statsAll` | `["stats"]` | **Nueva** | Estadísticas: se calculan con solicitudes y reservas |

```ts
// src/lib/api/query-keys.ts: claves nuevas
request: (id: string) => ["reservation-requests", "detail", id] as const,
statsAll: ["stats"] as const,
```

Las respuestas de los PATCH de reservas y de clientes no traen los historiales ni los intereses. Para actualizar el detalle en caché sin perderlos, mezcla la respuesta con lo que ya había: `setQueryData(qk.reservation(id), (old) => (old ? { ...old, ...updated } : old))`. Es lo que ya hace `PrepareControl` en `reservation-detail.tsx`.

## Crear cliente
`POST /customers`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 201 · `Customer` |
| ft-crm | `customersApi.create(body: CreateCustomerRequest): Promise<Customer>` · **nueva** |
| Caché | Invalida `qk.customersAll`. |
| Cabeceras y límites | Sin `Idempotency-Key`. Si reintentas tras un 504 y el cliente ya se creó, la respuesta es 409 por teléfono o email duplicado: no se duplica. |

**Body** (`CreateCustomerRequest`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `sourceChannel` | `ContactChannel` | Sí | `WHATSAPP`, `FACEBOOK`, `INSTAGRAM`, `WEBSITE`, `PHONE`, `EMAIL` u `OTHER`. No admite `null`. Es solo el canal de origen: no habilita ningún envío. |
| `firstName` | string \| null | No | Trim. De 1 a 100 caracteres después del trim. `null` equivale a omitirlo. |
| `lastName` | string \| null | No | Igual que `firstName`. |
| `phone` | string \| null | No | Trim; de 1 a 80 caracteres. Solo dígitos, espacios, `(`, `)`, `.`, `-` y un `+` inicial opcional, con 6 a 15 dígitos (sin anexos ni letras). Con `+`: tiene que ser un número internacional válido; el país sale del prefijo. Sin `+` y con `phoneCountry`: tiene que ser válido para ese país (libphonenumber). Sin `+` ni `phoneCountry`: se guarda tal cual, sin normalizar, y solo se acepta si hay `email`. |
| `phoneCountry` | string \| null | No | Trim y mayúsculas (`"pe"` → `"PE"`). Dos letras de un país soportado (ISO 3166-1 alfa-2: `PE`, `US`, `GB`…; `UK` no existe). Exige `phone`. Si el número empieza por `+`, no se usa para validarlo, pero se guarda tal cual aunque no coincida con el prefijo. |
| `email` | string \| null | No | Trim y minúsculas antes de validar. Formato email; máx. 320 caracteres. |
| `notes` | string \| null | No | Trim. De 1 a 5000 caracteres. |

Reglas del servicio:
- Hace falta un `email` o un teléfono normalizable: internacional con `+`, o nacional con `phoneCountry`.
- El teléfono normalizado (E.164) y el email son únicos. `"+51 987 654 321"`, `"+51987654321"` y `"51987654321"` con `PE` son el mismo teléfono. El email no distingue mayúsculas.
- Un teléfono nacional guardado sin país no cuenta para la unicidad.
- El backend fija `status`, las fechas de contacto y los campos normalizados. Cualquier otro campo (`status`, `firstContactAt`, `normalizedPhone`, `providerAccountId`…) responde 400.

**Ejemplo de petición**

```ts
const customer = await customersApi.create({
  sourceChannel: "WHATSAPP",
  firstName: "Carlos",
  lastName: "Quispe",
  phone: "987 654 321",
  phoneCountry: "PE",
  email: "carlos.quispe@example.com",
  notes: "Consulta por platos de trucha",
});
```

Viaja como `POST /api/backend/customers` con este body:

```json
{
  "sourceChannel": "WHATSAPP",
  "firstName": "Carlos",
  "lastName": "Quispe",
  "phone": "987 654 321",
  "phoneCountry": "PE",
  "email": "carlos.quispe@example.com",
  "notes": "Consulta por platos de trucha"
}
```

**Respuesta** (201)

```json
{
  "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "firstName": "Carlos",
  "lastName": "Quispe",
  "phone": "987 654 321",
  "phoneCountry": "PE",
  "email": "carlos.quispe@example.com",
  "sourceChannel": "WHATSAPP",
  "status": "NEW",
  "firstContactAt": "2026-11-03T02:32:11.984Z",
  "lastContactAt": "2026-11-03T02:32:11.984Z",
  "notes": "Consulta por platos de trucha",
  "createdAt": "2026-11-03T02:32:11.991Z",
  "updatedAt": "2026-11-03T02:32:11.991Z"
}
```

`phone` vuelve tal como se escribió (con trim) y `email` en minúsculas. La forma E.164 (`+51987654321`) es interna y no se expone.

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` | Llega un campo no declarado (p. ej. `status` o `normalizedPhone`). |
| 400 | `sourceChannel must be one of the following values: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER` | Falta, es `null` o no está en el enum. |
| 400 | `firstName must be a string` · `firstName should not be empty` · `firstName must be shorter than or equal to 100 characters` | No es texto, queda vacío tras el trim o pasa de 100. Los mismos tres mensajes existen para `lastName`. |
| 400 | `phone must be a string` · `phone should not be empty` · `phone must be shorter than or equal to 80 characters` | No es texto (p. ej. un número JSON), queda vacío o pasa de 80. |
| 400 | `phoneCountry must be a string` · `phoneCountry must match /^[A-Z]{2}$/ regular expression` | No son dos letras (`""`, `"PER"`, `51`). |
| 400 | `email must be an email` · `email must be shorter than or equal to 320 characters` | Formato inválido (incluido `""`) o más de 320. |
| 400 | `notes must be a string` · `notes should not be empty` · `notes must be shorter than or equal to 5000 characters` | No es texto, queda vacío o pasa de 5000. |
| 400 | `phoneCountry debe ser un país ISO válido` | Dos letras que no son un país soportado (`ZZ`, `UK`). |
| 400 | `phoneCountry requiere un teléfono` | Llega `phoneCountry` sin `phone`. |
| 400 | `El teléfono tiene un formato inválido` | Caracteres no permitidos, menos de 6 dígitos o más de 15 (p. ej. `"+51 987 654 321 anexo 2"`). |
| 400 | `El teléfono no es válido para el país indicado` | Con `+`: no es un número válido. Sin `+`: no es válido para `phoneCountry` (p. ej. `"987654321"` con `US`). |
| 400 | `Proporciona un email válido o un teléfono internacional; para un número nacional indica phoneCountry` | No hay email ni teléfono normalizable (p. ej. solo `"987654321"`, sin país). |
| 400 | `Los campos de texto no pueden estar vacíos` · `El correo no es válido` · `Los datos o referencias del cliente son inválidos` | Defensivos. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF (`SESSION_EXPIRED` o `NO_SESSION`). Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 409 | `Ya existe un cliente con ese teléfono o correo` | El teléfono normalizado o el email ya son de otro cliente. |
| 409 | `Ya existe un cliente o interés con esos datos` | Dos altas simultáneas con el mismo contacto: la base de datos rechaza la segunda. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

Orden: validación del body → reglas de contacto (en el orden de la tabla) → duplicados (409).

**Efectos**

- Crea el cliente con `status: "NEW"` y `firstContactAt` igual a `lastContactAt`, con la hora del servidor.
- No crea conversación. Si el teléfono quedó normalizado, los mensajes de WhatsApp de ese número se asocian a este cliente en vez de crear otro, y su conversación aparece en la Bandeja con el primer mensaje.
- Un cliente creado a mano con `sourceChannel: "FACEBOOK"` no queda vinculado a Messenger: si esa persona escribe por Messenger, el backend crea otro cliente.
- No envía mensajes ni correos.

**Notas para el frontend**

- ft-crm aún no tiene pantalla de alta. Muestra la acción solo a ADMIN y OPERATOR (`can(roles, "customer.edit")` ya cubre esos roles).
- Teléfono: usa un selector de país (por defecto `PE`) más el número, y envía `phoneCountry` siempre que el número no empiece por `+`. No se asume Perú.
- Valida en el formulario lo mismo que el backend (email, o teléfono internacional, o nacional con país). Si aun así falla, muestra el mensaje en español de la respuesta.
- Omite los campos vacíos: `""` responde 400.
- Ante el 409 por duplicado, ofrece buscar el cliente existente con `customersApi.list({ search: <email o número> })`. No hay fusión de clientes.
- Después del alta, invalida `qk.customersAll` y abre la ficha con el `id` de la respuesta.

## Listar clientes
`GET /customers`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `Paginated<Customer>` |
| ft-crm | `customersApi.list(query: CustomerListQuery): Promise<Paginated<Customer>>` · existe |
| Caché | `qk.customers(query)` → `["customers", "list", query]`. |

**Query** (`CustomerListQuery`)

| Campo | Tipo | Obligatorio | Por defecto | Reglas |
|---|---|---|---|---|
| `page` | number | No | `1` | Entero de 1 a 1 000 000. |
| `limit` | number | No | `20` | Entero de 1 a 100. |
| `search` | string | No | — | Trim; de 1 a 200 caracteres. Coincidencia parcial y sin distinguir mayúsculas en `firstName`, `lastName` y `email`. En `phone`, coincidencia parcial con el texto tal como se guardó (con sus espacios). Si el texto tiene dígitos, esos dígitos se buscan también en el teléfono normalizado. |
| `status` | `CustomerStatus` | No | — | Un solo valor del enum. |
| `channel` | `ContactChannel` | No | — | Filtra por `sourceChannel` (canal de origen del cliente), no por el canal de sus conversaciones. |
| `commercialItemId` | `Uuid` | No | — | Clientes con un interés registrado en ese elemento comercial. |

**Ejemplo de petición**

```ts
const page = await customersApi.list({ page: 1, limit: 20 });
```

Viaja como `GET /api/backend/customers?page=1&limit=20`. Con búsqueda y estado, `customersApi.list({ page: 1, limit: 20, search: "quispe", status: "INTERESTED" })` viaja como `GET /api/backend/customers?page=1&limit=20&search=quispe&status=INTERESTED`.

**Respuesta** (200)

```json
{
  "data": [
    {
      "id": "b8e1d4c7-2a9f-4e63-9d15-7f0a3c6b2e81",
      "firstName": "Rosa Mamani",
      "lastName": null,
      "phone": null,
      "phoneCountry": null,
      "email": null,
      "sourceChannel": "FACEBOOK",
      "status": "NEW",
      "firstContactAt": "2026-11-02T22:15:40.120Z",
      "lastContactAt": "2026-11-03T03:05:12.447Z",
      "notes": null,
      "createdAt": "2026-11-02T22:15:40.120Z",
      "updatedAt": "2026-11-03T03:05:12.447Z"
    },
    {
      "id": "7c2e9a41-3d8b-4f16-a2c9-5e1b7d4f0a83",
      "firstName": null,
      "lastName": null,
      "phone": "+51912345678",
      "phoneCountry": null,
      "email": null,
      "sourceChannel": "WHATSAPP",
      "status": "NEW",
      "firstContactAt": "2026-11-03T01:47:09.315Z",
      "lastContactAt": "2026-11-03T02:58:33.871Z",
      "notes": null,
      "createdAt": "2026-11-03T01:47:09.315Z",
      "updatedAt": "2026-11-03T02:58:33.871Z"
    },
    {
      "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
      "firstName": "Carlos",
      "lastName": "Quispe",
      "phone": "987 654 321",
      "phoneCountry": "PE",
      "email": "carlos.quispe@example.com",
      "sourceChannel": "WHATSAPP",
      "status": "INTERESTED",
      "firstContactAt": "2026-11-03T02:32:11.984Z",
      "lastContactAt": "2026-11-03T02:40:05.120Z",
      "notes": "Consulta por platos de trucha",
      "createdAt": "2026-11-03T02:32:11.991Z",
      "updatedAt": "2026-11-03T02:41:37.502Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

El primero es un cliente de Messenger con el nombre que dio Meta. El segundo es un cliente de WhatsApp sin nombre.

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `property <parámetro> should not exist` | Llega un parámetro no declarado (p. ej. `sort` o un `_t` anticaché). |
| 400 | `page must be an integer number` · `page must not be less than 1` · `page must not be greater than 1000000` | `page` no es un entero entre 1 y 1 000 000 (`page=` vacío cuenta como 0). |
| 400 | `limit must be an integer number` · `limit must not be less than 1` · `limit must not be greater than 100` | `limit` no es un entero entre 1 y 100. |
| 400 | `search must be a string` · `search should not be empty` · `search must be shorter than or equal to 200 characters` | Vacío o solo espacios, más de 200 caracteres, o el parámetro repetido. |
| 400 | `status must be one of the following values: NEW, INTERESTED, IN_CONVERSATION, REQUESTED_RESERVATION, CONFIRMED, REJECTED, LOST, RECURRENT` | Valor fuera del enum. |
| 400 | `channel must be one of the following values: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER` | Valor fuera del enum. |
| 400 | `commercialItemId must be a UUID` | No es un UUID. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario solo tiene SUPPORT. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**

- Orden fijo: `lastContactAt` descendente y luego `id` ascendente. Los filtros se combinan con AND.
- `data` y `total` se leen en la misma transacción, así que siempre son coherentes. Si no hay resultados, `totalPages` vale 0. Una página mayor que `totalPages` devuelve `data: []` con `total > 0` (ft-crm ya lo trata en `ClientesView`).
- `search` busca cada campo por separado: «Carlos Quispe» no encuentra a un cliente con `firstName: "Carlos"` y `lastName: "Quispe"`. Busca por una sola palabra.
- Teléfonos: `987654321` encuentra `"987 654 321"` si ese número quedó normalizado (por sus dígitos). Un número nacional guardado sin país solo aparece si escribes el texto, o una parte, tal como se guardó (con sus espacios).
- Cualquier dígito del texto se busca en los teléfonos: «Mesa 4» trae también a los clientes con un 4 en el número.
- No envíes parámetros vacíos ni extra. `toSearch` ya omite `undefined`, `null` y los textos vacíos.
- Clientes creados por los webhooks:
  - Messenger (`sourceChannel: "FACEBOOK"`): sin `phone` ni `email`. `firstName` trae el nombre completo que da Meta (p. ej. «Rosa Mamani») y `lastName` queda en `null`. Si Meta no da el nombre, ambos quedan en `null`.
  - WhatsApp: `phone` con el formato `"+51912345678"` y sin nombre.
  - Texto de respaldo: el teléfono, el email o «Cliente de Messenger». Hoy `customerName` muestra «Cliente sin nombre» cuando no hay nada.
- `lastContactAt` cambia con cada mensaje entrante (WhatsApp o Messenger) y al registrar un interés. No cambia al editar el cliente, al cambiar su estado ni al enviarle mensajes.
- El listado no trae reservas, intereses ni conversación. ft-crm hace una llamada por fila para las columnas RESERVAS y CONSULTÓ.
- `ClientesView` refresca cada 60 s y solo consulta si el rol puede ver Clientes.

## Ver detalle de cliente
`GET /customers/:id`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `CustomerDetail` |
| ft-crm | `customersApi.get(id: string): Promise<CustomerDetail>` · existe |
| Caché | `qk.customer(id)` → `["customers", "detail", id]`. |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id del cliente. Si no es un UUID, responde 400. |

**Respuesta** (200)

```json
{
  "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "firstName": "Carlos",
  "lastName": "Quispe",
  "phone": "987 654 321",
  "phoneCountry": "PE",
  "email": "carlos.quispe@example.com",
  "sourceChannel": "WHATSAPP",
  "status": "INTERESTED",
  "firstContactAt": "2026-11-03T02:32:11.984Z",
  "lastContactAt": "2026-11-03T02:40:05.120Z",
  "notes": "Consulta por platos de trucha",
  "createdAt": "2026-11-03T02:32:11.991Z",
  "updatedAt": "2026-11-03T02:41:37.502Z",
  "interests": [
    {
      "id": "d14f8b2a-6e3c-4a97-8b51-0c2e7f9d3a68",
      "firstInterestedAt": "2026-11-03T02:40:05.120Z",
      "lastInterestedAt": "2026-11-03T02:40:05.120Z",
      "notes": "Consultó disponibilidad y precio",
      "commercialItem": {
        "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
        "nameEs": "Trucha a la parrilla",
        "nameEn": "Grilled trout",
        "type": "DISH",
        "isActive": true,
        "approvalStatus": "APPROVED"
      }
    },
    {
      "id": "9e5b1c7d-2f4a-4b83-a6d0-3c8e1f5b7a29",
      "firstInterestedAt": "2026-11-03T02:38:12.640Z",
      "lastInterestedAt": "2026-11-03T02:38:12.640Z",
      "notes": null,
      "commercialItem": {
        "id": "2b8f4c6d-1e7a-4d39-8c52-9a0e3f7b1d64",
        "nameEs": "Almuerzo familiar",
        "nameEn": null,
        "type": "SERVICE",
        "isActive": false,
        "approvalStatus": "APPROVED"
      }
    }
  ]
}
```

El segundo interés apunta a un elemento que hoy está inactivo: el detalle muestra el estado actual del catálogo, no el que tenía al registrarse.

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario solo tiene SUPPORT. |
| 404 | `Cliente no encontrado` | El cliente no existe. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**

- `interests` viene ordenado por `lastInterestedAt` descendente y luego por `id` ascendente: el más reciente es `interests[0]` (lo usa `latestInterestName` para la columna CONSULTÓ).
- Cada interés trae el estado actual del elemento comercial (`isActive`, `approvalStatus`): puede estar inactivo o sin aprobar. Al menos uno de `nameEs` y `nameEn` tiene valor; muestra `nameEs ?? nameEn` (`itemName`).
- El detalle no incluye solicitudes, reservas ni conversaciones. Pídelas aparte con `customerId`: `requestsApi.list({ customerId })`, `reservationsApi.list({ customerId })` y `conversationsApi.list({ customerId })`.
- OWNER y OPERATOR también pueden leerlo. ft-crm lo comparte en caché entre la tabla de Clientes, el panel de la Bandeja y el canal que muestra el detalle de reserva.
- Con un id inexistente, muestra «Cliente no encontrado» en lugar de un error genérico (`error.isNotFound`).

## Editar cliente
`PATCH /customers/:id`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `Customer` |
| ft-crm | `customersApi.update(id: string, body: UpdateCustomerRequest): Promise<Customer>` · **nueva** |
| Caché | Mezcla la respuesta en `qk.customer(id)` (no trae `interests`) e invalida `qk.customersAll`. Si cambió el nombre, el teléfono o el email, invalida también `qk.conversationsAll`, `qk.requestsAll` y `qk.reservationsAll`: incluyen el resumen del cliente. |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id del cliente. Si no es un UUID, responde 400. |

**Body** (`UpdateCustomerRequest`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `sourceChannel` | `ContactChannel` | No | Valor del enum; no admite `null`. En una identidad de Messenger solo se acepta `FACEBOOK`. |
| `firstName` | string \| null | No | Trim; de 1 a 100 caracteres. `null` lo borra. |
| `lastName` | string \| null | No | Trim; de 1 a 100 caracteres. `null` lo borra. |
| `phone` | string \| null | No | Mismas reglas que al crear. `null` borra el teléfono y también su país. |
| `phoneCountry` | string \| null | No | Mismas reglas que al crear. No se hereda: si envías `phone` sin `phoneCountry`, el país queda en `null`. Si envías solo `phoneCountry`, el backend vuelve a normalizar el teléfono actual con ese país. |
| `email` | string \| null | No | Mismas reglas que al crear. `null` lo borra. |
| `notes` | string \| null | No | Trim; de 1 a 5000 caracteres. `null` lo borra. |

Reglas del servicio:
- Hay que enviar al menos un campo; `null` cuenta como campo.
- El contacto se valida con el resultado final: tras el cambio, el cliente tiene que conservar un email o un teléfono normalizable. Las identidades de Messenger están exentas.
- El teléfono y el email no pueden ser de otro cliente.
- `status`, las fechas de contacto, los campos normalizados y cualquier otro campo responden 400.

**Ejemplo de petición**

```ts
const updated = await customersApi.update("3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42", {
  firstName: "Carlos Alberto",
  notes: "Prefiere atención por correo",
});
```

Viaja como `PATCH /api/backend/customers/3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42` con este body:

```json
{
  "firstName": "Carlos Alberto",
  "notes": "Prefiere atención por correo"
}
```

Para cambiar un teléfono nacional, reenvía siempre el país: `{ "phone": "912 345 678", "phoneCountry": "PE" }`.

**Respuesta** (200)

```json
{
  "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "firstName": "Carlos Alberto",
  "lastName": "Quispe",
  "phone": "987 654 321",
  "phoneCountry": "PE",
  "email": "carlos.quispe@example.com",
  "sourceChannel": "WHATSAPP",
  "status": "INTERESTED",
  "firstContactAt": "2026-11-03T02:32:11.984Z",
  "lastContactAt": "2026-11-03T02:40:05.120Z",
  "notes": "Prefiere atención por correo",
  "createdAt": "2026-11-03T02:32:11.991Z",
  "updatedAt": "2026-11-03T03:25:18.330Z"
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Debes proporcionar al menos un campo para actualizar` | El body está vacío (`{}`). Se comprueba antes de buscar al cliente. |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega un campo no declarado (p. ej. `status`). |
| 400 | `sourceChannel must be one of the following values: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER` | Valor fuera del enum o `null`. |
| 400 | `firstName must be a string` · `firstName should not be empty` · `firstName must be shorter than or equal to 100 characters` | Igual para `lastName`. |
| 400 | `phone must be a string` · `phone should not be empty` · `phone must be shorter than or equal to 80 characters` | Ver [Crear cliente](#crear-cliente). |
| 400 | `phoneCountry must be a string` · `phoneCountry must match /^[A-Z]{2}$/ regular expression` | No son dos letras. |
| 400 | `email must be an email` · `email must be shorter than or equal to 320 characters` | Formato inválido o más de 320. |
| 400 | `notes must be a string` · `notes should not be empty` · `notes must be shorter than or equal to 5000 characters` | No es texto, queda vacío o pasa de 5000. |
| 400 | `No se puede cambiar el canal de una identidad de Messenger` | El cliente lo creó el webhook de Messenger y llega un `sourceChannel` distinto de `FACEBOOK`. |
| 400 | `phoneCountry debe ser un país ISO válido` | Dos letras que no son un país soportado. |
| 400 | `phoneCountry requiere un teléfono` | Llega `phoneCountry` para un cliente sin teléfono, o un `phoneCountry` no nulo junto con `phone: null`. En este último caso, si el cliente quedaría sin email (y no es de Messenger), responde antes el error de contacto. |
| 400 | `El teléfono tiene un formato inválido` | Caracteres no permitidos, menos de 6 dígitos o más de 15. |
| 400 | `El teléfono no es válido para el país indicado` | El número no es válido (con `+`) o no es válido para el país. |
| 400 | `Proporciona un email válido o un teléfono internacional; para un número nacional indica phoneCountry` | Tras el cambio, el cliente quedaría sin email y sin teléfono normalizable (p. ej. `{ "email": null }` en un cliente sin teléfono, o un número nacional sin `phoneCountry`). No aplica a las identidades de Messenger. |
| 400 | `Los campos de texto no pueden estar vacíos` · `El correo no es válido` · `Los datos o referencias del cliente son inválidos` | Defensivos. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Cliente no encontrado` | El cliente no existe. |
| 404 | `Cliente o interés no encontrado` | Defensivo. |
| 409 | `Ya existe un cliente con ese teléfono o correo` | El teléfono normalizado o el email ya son de otro cliente. |
| 409 | `Ya existe un cliente o interés con esos datos` | Otra petición tomó el mismo teléfono o email y los 3 intentos chocaron. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

Orden: `:id` y validación del body → body vacío → cliente (404) → canal de Messenger → reglas de contacto → `phoneCountry` con `phone: null` → duplicados (409).

**Efectos**

- Actualiza los campos enviados y `updatedAt`. No cambia `status`, `firstContactAt` ni `lastContactAt`.
- El resumen del cliente (`firstName`, `lastName`, `phone`, `email`) que traen las conversaciones, solicitudes y reservas cambia con él.
- **Teléfono y WhatsApp.** Las respuestas de WhatsApp van al teléfono normalizado del cliente, y la ventana de 24 h se mide con los mensajes que llegaron desde ese número. Por eso, en un cliente con conversación de WhatsApp:
  - Borrar el teléfono, o dejar un número nacional sin `phoneCountry`, hace que `POST /conversations/:id/messages` responda 400 `Conversación sin destinatario habilitado`.
  - Cambiar el número hace que las respuestas vayan al número nuevo. La ventana queda cerrada (409 `Ventana de WhatsApp cerrada; se requiere una plantilla aprobada`) hasta que ese número escriba.
  - Si el número anterior vuelve a escribir, el backend crea otro cliente con ese número.
- **Messenger.** Las respuestas van al identificador de Messenger, que no se edita: cambiar el teléfono o el email no las afecta. El nombre automático solo se aplica a clientes con `firstName` y `lastName` en `null`: si les pones un nombre, se respeta; si borras ambos, el siguiente mensaje de Messenger puede volver a llenar `firstName`.

**Notas para el frontend**

- Envía solo los campos modificados. Omitir conserva; `null` borra (salvo `sourceChannel`).
- Teléfono nacional: cada vez que envíes `phone`, reenvía `phoneCountry` aunque no haya cambiado. Si no lo haces, el país se borra y el número deja de estar normalizado; si además el cliente no tiene email, la respuesta es 400.
- Si el cliente tiene conversación de WhatsApp, avisa antes de cambiar o borrar su teléfono (ver Efectos).
- Identidad de Messenger: la respuesta no indica si un cliente `FACEBOOK` la tiene, así que no puedes saber de antemano si el canal está bloqueado ([pregunta abierta](#preguntas-abiertas)). Si llega el 400 `No se puede cambiar el canal de una identidad de Messenger`, muestra el mensaje y devuelve el selector a `FACEBOOK`. Esas identidades sí admiten agregar o borrar teléfono y email.
- Un cliente creado a mano con `FACEBOOK` no es una identidad de Messenger: le aplica la regla de contacto normal y puede cambiar de canal.
- No hay fusión: si el teléfono o el email ya son de otro cliente, la respuesta es 409. Ofrece abrir ese cliente.
- Para actualizar la caché sin perder los intereses: `setQueryData<CustomerDetail>(qk.customer(id), (old) => (old ? { ...old, ...updated } : old))`.

## Cambiar estado del cliente
`PATCH /customers/:id/status`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `Customer` |
| ft-crm | `customersApi.setStatus(id: string, status: CustomerStatus): Promise<Customer>` · existe (sin pantalla que la use) |
| Caché | Mezcla la respuesta en `qk.customer(id)` e invalida `qk.customersAll`. |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id del cliente. Si no es un UUID, responde 400. |

**Body** (`UpdateCustomerStatusRequest`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `status` | `CustomerStatus` | Sí | `NEW`, `INTERESTED`, `IN_CONVERSATION`, `REQUESTED_RESERVATION`, `CONFIRMED`, `REJECTED`, `LOST` o `RECURRENT`. No admite `null`. Cualquier otro campo responde 400. |

**Ejemplo de petición**

```ts
const customer = await customersApi.setStatus("3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42", "INTERESTED");
```

Viaja como `PATCH /api/backend/customers/3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42/status` con este body:

```json
{ "status": "INTERESTED" }
```

**Respuesta** (200)

```json
{
  "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "firstName": "Carlos",
  "lastName": "Quispe",
  "phone": "987 654 321",
  "phoneCountry": "PE",
  "email": "carlos.quispe@example.com",
  "sourceChannel": "WHATSAPP",
  "status": "INTERESTED",
  "firstContactAt": "2026-11-03T02:32:11.984Z",
  "lastContactAt": "2026-11-03T02:40:05.120Z",
  "notes": "Consulta por platos de trucha",
  "createdAt": "2026-11-03T02:32:11.991Z",
  "updatedAt": "2026-11-03T02:41:37.502Z"
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega otro campo además de `status` (p. ej. `notes`). |
| 400 | `status must be one of the following values: NEW, INTERESTED, IN_CONVERSATION, REQUESTED_RESERVATION, CONFIRMED, REJECTED, LOST, RECURRENT` | Falta, es `null` o no está en el enum. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Cliente o interés no encontrado` | El cliente no existe. El texto es distinto del 404 del detalle (`Cliente no encontrado`). |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

**Efectos**

- Cambia `status` y `updatedAt`. No toca las fechas de contacto ni otros recursos.
- No crea solicitudes ni reservas, y no notifica a nadie.

**Notas para el frontend**

- No hay reglas de transición: el backend acepta pasar de cualquier estado a cualquier otro, incluido el mismo. El flujo lo decide la UI (ver [Estados y transiciones](#estados-y-transiciones)).
- El estado nunca cambia solo. Crear una solicitud o una reserva, o recibir mensajes, no lo modifica: el código tiene esa integración pendiente. Si la UI quiere marcar `REQUESTED_RESERVATION` al crear una solicitud, tiene que llamar a esta ruta aparte (decisión abierta).
- Muestra el selector solo a ADMIN y OPERATOR (`can(roles, "customer.edit")`). Usa las etiquetas de `CUSTOMER_STATUS` de `src/lib/domain/statuses.ts`.
- Trata el 404 por su código (`error.isNotFound`), no por el texto.

## Registrar interés del cliente
`POST /customers/:id/interests`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `CustomerInterest` (también al repetir) |
| ft-crm | `customersApi.addInterest(id: string, body: CreateCustomerInterestRequest): Promise<CustomerInterest>` · **nueva** |
| Caché | Invalida `qk.customersAll` (cubre la ficha y los listados: cambia `lastContactAt` y el filtro por `commercialItemId`). |
| Cabeceras y límites | Sin `Idempotency-Key`, pero repetir no duplica: actualiza el mismo interés. |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id del cliente. Si no es un UUID, responde 400. |

**Body** (`CreateCustomerInterestRequest`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `commercialItemId` | `Uuid` | Sí | Elemento comercial existente. Puede estar inactivo o sin aprobar. |
| `notes` | string \| null | No | Trim; de 1 a 5000 caracteres. Al crear, omitirlo o enviar `null` deja la nota vacía. Si el interés ya existe, omitirlo conserva la nota anterior y `null` la borra. |

**Ejemplo de petición**

```ts
const interest = await customersApi.addInterest("3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42", {
  commercialItemId: "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  notes: "Consultó disponibilidad y precio",
});
```

Viaja como `POST /api/backend/customers/3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42/interests` con este body:

```json
{
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "notes": "Consultó disponibilidad y precio"
}
```

**Respuesta** (200)

```json
{
  "id": "d14f8b2a-6e3c-4a97-8b51-0c2e7f9d3a68",
  "firstInterestedAt": "2026-11-03T02:40:05.120Z",
  "lastInterestedAt": "2026-11-03T02:40:05.120Z",
  "notes": "Consultó disponibilidad y precio",
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

La respuesta no incluye `customerId`: el elemento se identifica con `commercialItem.id`.

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega un campo no declarado. |
| 400 | `commercialItemId must be a UUID` | Falta, es `null` o no es un UUID. |
| 400 | `notes must be a string` · `notes should not be empty` · `notes must be shorter than or equal to 5000 characters` | No es texto, queda vacío tras el trim o pasa de 5000. |
| 400 | `Los datos o referencias del cliente son inválidos` · `Los campos de texto no pueden estar vacíos` | Defensivos. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Cliente no encontrado` | El cliente no existe. Se comprueba primero. |
| 404 | `Elemento comercial no encontrado` | El elemento comercial no existe. |
| 409 | `Ya existe un cliente o interés con esos datos` | Registros simultáneos del mismo interés chocaron en los 3 intentos. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

**Efectos**

- Crea el interés o actualiza el existente: hay uno solo por par cliente–elemento. Al repetir conserva `id` y `firstInterestedAt`, mueve `lastInterestedAt` a la hora actual y aplica la regla de `notes`.
- Actualiza el `lastContactAt` del cliente a la hora actual (si es posterior): para el backend, registrar una consulta cuenta como contacto. El cliente sube en `GET /customers`.
- No publica, aprueba ni activa el elemento comercial.

**Notas para el frontend**

- A diferencia de solicitudes y reservas, aquí se aceptan elementos inactivos o sin aprobar. Aun así, conviene ofrecer los activos en el selector.
- Para editar la nota de un interés existente, vuelve a llamar a esta ruta con el mismo `commercialItemId` y la nota nueva (o `null` para borrarla). No hay una ruta que edite solo la nota: la llamada también mueve `lastInterestedAt` y el `lastContactAt` del cliente a la hora actual.
- Deshabilita el botón mientras la petición está en curso: un doble clic no duplica, pero sí mueve `lastInterestedAt` dos veces.
- Después invalida `qk.customersAll`. La columna CONSULTÓ de Clientes lee `interests[0]` del detalle.

## Quitar interés del cliente
`DELETE /customers/:id/interests/:commercialItemId`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 204 · sin cuerpo (`void`) |
| ft-crm | `customersApi.removeInterest(id: string, commercialItemId: string): Promise<void>` · **nueva** |
| Caché | Invalida `qk.customersAll` (la ficha cambia y el filtro por `commercialItemId` también). |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id del cliente. Si no es un UUID, responde 400. |
| `commercialItemId` | `Uuid` | Id del **elemento comercial** (`interest.commercialItem.id`), no el `id` del interés. Si no es un UUID, responde 400. |

**Respuesta** (204)

Sin cuerpo. `apiFetch` devuelve `undefined`.

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` o `:commercialItemId` no son UUID. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Cliente no encontrado` | El cliente no existe. |
| 404 | `Interés no encontrado` | El cliente no tiene interés en ese elemento. También ocurre al repetir el DELETE. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |

**Efectos**

- Borra solo la relación cliente–elemento. No borra el cliente ni el elemento.
- No cambia `lastContactAt` ni `updatedAt` del cliente.

**Notas para el frontend**

- Construye la ruta con `interest.commercialItem.id`.
- Si quitas el interés de forma optimista y llega el 404 `Interés no encontrado`, trátalo como hecho: otra persona ya lo quitó.
- Después invalida `qk.customersAll` para refrescar la ficha y la columna CONSULTÓ.

## Crear solicitud de reserva
`POST /reservation-requests`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 201 · `ReservationRequest` |
| ft-crm | `requestsApi.create(body: CreateReservationRequestBody): Promise<ReservationRequest>` · **nueva** |
| Caché | Invalida `qk.requestsAll` y `qk.statsAll` (nueva). |
| Cabeceras y límites | Sin `Idempotency-Key`: cada POST crea una solicitud con otro `code`. Tras un 504, revisa el listado antes de reintentar. |

**Body** (`CreateReservationRequestBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `customerId` | `Uuid` | Sí | Cliente existente. No admite `null`. |
| `sourceChannel` | `ContactChannel` | Sí | Canal por el que llegó la solicitud. No se hereda del cliente. No admite `null`. |
| `commercialItemId` | `Uuid` \| null | No | Elemento existente, activo (`isActive`) y `APPROVED`. |
| `reservationAt` | `IsoDateTime` \| null | No | ISO 8601 con segundos y zona: `YYYY-MM-DDTHH:mm:ss[.sss]` más `Z` o `±HH:mm` (regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z\|[+-]\d{2}:\d{2})$`). Fecha real y estrictamente posterior a la hora del servidor. |
| `numberOfPeople` | number \| null | No | Entero JSON (no texto) de 1 a 2147483647. El máximo es técnico, no un aforo. |
| `quotedPrice` | `MoneyString` \| null | No | Texto decimal que cumple `^(?:0\|[1-9]\d{0,7})(?:\.\d{1,2})?$`: de `"0"` a `"99999999.99"`, hasta 2 decimales, sin signo, sin ceros a la izquierda y sin exponente. `"150.5"` es válido y vuelve como `"150.50"`. |
| `currency` | `CurrencyCode` \| null | No | `PEN` o `USD`. Solo va con `quotedPrice`: si hay precio y omites la moneda, se usa la del restaurante. |
| `comments` | string \| null | No | Trim; de 1 a 5000 caracteres. |
| `specialRequirements` | string \| null | No | Trim; de 1 a 5000 caracteres. |

Reglas del servicio:
- `status` lo calcula el backend: `READY_TO_SEND` si hay `reservationAt` y `numberOfPeople`; si falta alguno, `INCOMPLETE_DATA`.
- Precio y moneda van juntos. Con precio y sin `currency`, se usa la moneda del restaurante; con precio y `currency: null`, o con moneda y sin precio, la respuesta es 400.
- No se valida aforo, horario de atención ni solapamientos.
- `code`, `status`, `createdAt` y cualquier otro campo responden 400.

**Ejemplo de petición**

```ts
const request = await requestsApi.create({
  customerId: "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  sourceChannel: "PHONE",
  commercialItemId: "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  reservationAt: "2026-11-07T20:00:00-05:00",
  numberOfPeople: 4,
  quotedPrice: "150.00",
  comments: "Consulta por una reserva familiar",
  specialRequirements: "Una silla para bebé",
});
```

Viaja como `POST /api/backend/reservation-requests` con este body:

```json
{
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "sourceChannel": "PHONE",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "reservationAt": "2026-11-07T20:00:00-05:00",
  "numberOfPeople": 4,
  "quotedPrice": "150.00",
  "comments": "Consulta por una reserva familiar",
  "specialRequirements": "Una silla para bebé"
}
```

No envía `currency`: el backend toma la del restaurante (`PEN`).

**Respuesta** (201)

```json
{
  "id": "c7a3e9f1-4b2d-4e8a-9f60-2d5b8c1e7a93",
  "code": "RES-2026-000042",
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "sourceChannel": "PHONE",
  "reservationAt": "2026-11-08T01:00:00.000Z",
  "numberOfPeople": 4,
  "quotedPrice": "150.00",
  "currency": "PEN",
  "comments": "Consulta por una reserva familiar",
  "specialRequirements": "Una silla para bebé",
  "status": "READY_TO_SEND",
  "createdAt": "2026-11-03T02:35:20.418Z",
  "updatedAt": "2026-11-03T02:35:20.418Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

`reservationAt` vuelve en UTC: las 20:00 del 7 de noviembre en Lima son `2026-11-08T01:00:00.000Z`.

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` | Llega un campo no declarado (p. ej. `status` o `code`). |
| 400 | `customerId must be a UUID` | Falta, es `null` o no es un UUID. |
| 400 | `sourceChannel must be one of the following values: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER` | Falta, es `null` o no está en el enum. |
| 400 | `commercialItemId must be a UUID` | No es un UUID. |
| 400 | `reservationAt must be a string` · `reservationAt must be a valid ISO 8601 date string` · `reservationAt must match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z\|[+-]\d{2}:\d{2})$/ regular expression` | No es texto (p. ej. un timestamp numérico), no es una fecha real o le faltan los segundos o la zona. |
| 400 | `numberOfPeople must be an integer number` · `numberOfPeople must not be less than 1` · `numberOfPeople must not be greater than 2147483647` | No es un entero JSON (`"4"` da los tres mensajes), es menor que 1 o pasa del máximo. |
| 400 | `quotedPrice must be a string` · `quotedPrice must match /^(?:0\|[1-9]\d{0,7})(?:\.\d{1,2})?$/ regular expression` | Llega como número (`150`) o con otro formato (`"-1.00"`, `"1.234"`, `"0150.00"`, `"1e2"`). |
| 400 | `currency must be one of the following values: PEN, USD` | Otra moneda (p. ej. `EUR`). |
| 400 | `comments must be a string` · `comments should not be empty` · `comments must be shorter than or equal to 5000 characters` | Igual para `specialRequirements`. |
| 400 | `El elemento comercial debe estar activo y aprobado` | El elemento está inactivo o no está `APPROVED`. |
| 400 | `La fecha de reserva debe ser válida y futura` | `reservationAt` no es posterior a la hora del servidor. |
| 400 | `El precio y la moneda deben estar presentes juntos` | Llega `currency` sin `quotedPrice`, o `quotedPrice` con `currency: null`. |
| 400 | `Datos o relaciones de reserva inválidos` | Defensivo: la base de datos rechazó una clave foránea. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Cliente no encontrado` | `customerId` no existe. |
| 404 | `Elemento comercial no encontrado` | `commercialItemId` no existe. |
| 409 | `Configura el restaurante antes de crear solicitudes o reservas` | Aún no existe la configuración del restaurante (`PUT /restaurant-config`). Se comprueba primero. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 409 | `El código o la solicitud ya están vinculados a una reserva` | Defensivo: colisión de un valor único en la base de datos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |
| 503 | `La zona horaria del restaurante no es válida` | Caso límite: el `timeZone` guardado no es una zona IANA válida. `PUT /restaurant-config` ya la valida. |

Orden: configuración (409) → cliente (404) → elemento (404 o 400) → fecha futura (400) → precio y moneda (400) → código (503).

**Efectos**

- Crea la solicitud con su `code` `RES-<año>-<secuencia>`:
  - La secuencia es global, tiene al menos 6 dígitos y no se reinicia cada año. Puede tener saltos: un intento fallido también consume un número.
  - El año es el de la creación en la zona horaria del restaurante.
- No modifica al cliente: ni su estado ni sus fechas de contacto.
- No aparece en el calendario (`GET /reservations` solo lee reservas) y no avisa a nadie: el envío al dueño no existe todavía.

**Notas para el frontend**

- Es la única forma de crear solicitudes: ni Samanta ni los webhooks las crean. ft-crm aún no tiene el formulario «Nueva solicitud», y el panel de la Bandeja dice que «Samanta la crea…», lo que no ocurre en modo live.
- Arma `reservationAt` con la fecha y la hora que elige la persona en la zona del restaurante y conviértelo a un instante. `toISOString()` sirve.
- Envía `quotedPrice` como texto. Para el selector de moneda, propone por defecto el `currency` de `GET /restaurant-config`.
- En el selector de elementos, ofrece solo los activos y aprobados: `catalogApi.items({ isActive: true, approvalStatus: "APPROVED" })`.
- Si la respuesta es 409 `Configura el restaurante…`, lleva a la persona a Ajustes (solo un ADMIN puede guardar la configuración).
- Deshabilita el botón mientras la petición está en curso: un doble envío crea dos solicitudes.

## Listar solicitudes de reserva
`GET /reservation-requests`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `Paginated<ReservationRequest>` |
| ft-crm | `requestsApi.list(query: ReservationRequestListQuery): Promise<Paginated<ReservationRequest>>` · existe |
| Caché | `qk.requests(query)` → `["reservation-requests", "list", query]`. |

**Query** (`ReservationRequestListQuery`)

| Campo | Tipo | Obligatorio | Por defecto | Reglas |
|---|---|---|---|---|
| `page` | number | No | `1` | Entero de 1 a 1 000 000. |
| `limit` | number | No | `20` | Entero de 1 a 100. |
| `customerId` | `Uuid` | No | — | Solicitudes de ese cliente. |
| `dateFrom` | `IsoDateTime` | No | — | Mismo formato con segundos y zona que `reservationAt`. Límite inferior **incluido**: `reservationAt >= dateFrom`. |
| `dateTo` | `IsoDateTime` | No | — | Mismo formato. Límite superior **excluido**: `reservationAt < dateTo`. Con ambos, `dateFrom` tiene que ser anterior a `dateTo`. |
| `status` | `ReservationRequestStatus` | No | — | Un solo valor de los 9 del enum. |
| `channel` | `ContactChannel` | No | — | Filtra por el `sourceChannel` de la solicitud. |
| `commercialItemId` | `Uuid` | No | — | Solicitudes de ese elemento comercial. |
| `search` | string | No | — | Trim; de 1 a 200 caracteres. Coincidencia parcial y sin distinguir mayúsculas en `code` y en el nombre y apellido del cliente. En el `phone` del cliente, coincidencia con el texto tal como se guardó; y, si el texto tiene dígitos, en su teléfono normalizado. No busca por email. |

**Ejemplo de petición**

```ts
const page = await requestsApi.list({
  page: 1,
  limit: 20,
  customerId: "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  dateFrom: "2026-11-02T05:00:00.000Z",
  dateTo: "2026-11-09T05:00:00.000Z",
  status: "READY_TO_SEND",
});
```

Viaja como `GET /api/backend/reservation-requests?page=1&limit=20&customerId=3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42&dateFrom=2026-11-02T05%3A00%3A00.000Z&dateTo=2026-11-09T05%3A00%3A00.000Z&status=READY_TO_SEND`. Es la semana del lunes 2 al domingo 8 de noviembre en Lima.

La respuesta de ejemplo corresponde a `requestsApi.list({ page: 1, limit: 2 })`, sin filtros: las dos solicitudes más recientes de 43.

**Respuesta** (200)

```json
{
  "data": [
    {
      "id": "4e1b8d6f-0a3c-4f92-87d5-b6c2e9a1f304",
      "code": "RES-2026-000043",
      "customerId": "b8e1d4c7-2a9f-4e63-9d15-7f0a3c6b2e81",
      "commercialItemId": null,
      "sourceChannel": "FACEBOOK",
      "reservationAt": null,
      "numberOfPeople": null,
      "quotedPrice": null,
      "currency": null,
      "comments": "Pregunta por almuerzo para el domingo",
      "specialRequirements": null,
      "status": "INCOMPLETE_DATA",
      "createdAt": "2026-11-03T03:10:02.115Z",
      "updatedAt": "2026-11-03T03:10:02.115Z",
      "customer": {
        "id": "b8e1d4c7-2a9f-4e63-9d15-7f0a3c6b2e81",
        "firstName": "Rosa Mamani",
        "lastName": null,
        "phone": null,
        "email": null
      },
      "commercialItem": null
    },
    {
      "id": "c7a3e9f1-4b2d-4e8a-9f60-2d5b8c1e7a93",
      "code": "RES-2026-000042",
      "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
      "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
      "sourceChannel": "PHONE",
      "reservationAt": "2026-11-08T01:00:00.000Z",
      "numberOfPeople": 4,
      "quotedPrice": "150.00",
      "currency": "PEN",
      "comments": "Consulta por una reserva familiar",
      "specialRequirements": "Una silla para bebé",
      "status": "READY_TO_SEND",
      "createdAt": "2026-11-03T02:35:20.418Z",
      "updatedAt": "2026-11-03T02:35:20.418Z",
      "customer": {
        "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
        "firstName": "Carlos",
        "lastName": "Quispe",
        "phone": "987 654 321",
        "email": "carlos.quispe@example.com"
      },
      "commercialItem": {
        "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
        "nameEs": "Trucha a la parrilla",
        "nameEn": "Grilled trout",
        "type": "DISH",
        "isActive": true,
        "approvalStatus": "APPROVED"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 2, "total": 43, "totalPages": 22 }
}
```

La primera es de un cliente de Messenger, todavía sin fecha ni número de personas.

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `property <parámetro> should not exist` | Llega un parámetro no declarado (p. ej. `orderBy`). |
| 400 | `page must be an integer number` · `page must not be less than 1` · `page must not be greater than 1000000` | `page` no es un entero entre 1 y 1 000 000. |
| 400 | `limit must be an integer number` · `limit must not be less than 1` · `limit must not be greater than 100` | `limit` no es un entero entre 1 y 100. |
| 400 | `customerId must be a UUID` · `commercialItemId must be a UUID` | No son UUID. |
| 400 | `dateFrom must be a string` · `dateFrom must be a valid ISO 8601 date string` · `dateFrom must match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z\|[+-]\d{2}:\d{2})$/ regular expression` | Parámetro repetido, fecha imposible o sin segundos ni zona. Un `+` sin codificar llega como espacio y da los dos últimos. Los mismos mensajes existen para `dateTo`. |
| 400 | `status must be one of the following values: INCOMPLETE_DATA, READY_TO_SEND, SENT_TO_OWNER, WAITING_RESPONSE, ACCEPTED, REJECTED, MODIFICATION_REQUESTED, RENEGOTIATING, CANCELLED` | Valor fuera del enum. |
| 400 | `channel must be one of the following values: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER` | Valor fuera del enum. |
| 400 | `search must be a string` · `search should not be empty` · `search must be shorter than or equal to 200 characters` | Vacío o solo espacios, más de 200 caracteres, o el parámetro repetido. |
| 400 | `dateFrom debe ser anterior a dateTo y las fechas deben ser válidas` | `dateFrom` es igual o posterior a `dateTo`. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario solo tiene SUPPORT. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**

- Orden fijo: `createdAt` descendente y luego `id` ascendente. Los filtros se combinan con AND.
- El rango filtra por `reservationAt`, no por `createdAt`. Con un rango, las solicitudes sin fecha no aparecen. Calcula los límites como medianoche en la zona del restaurante, igual que el calendario.
- Estadísticas (`EstadisticasView`) pide las solicitudes del periodo con este rango: las cuenta por fecha de reserva, no por fecha de alta, y deja fuera las que no tienen `reservationAt`.
- `status` acepta un solo valor. Para una pestaña con varios estados hay que pedir cada uno (es lo que hace la pestaña Esperando de `SolicitudesView`).
- Con el backend actual solo se alcanzan `INCOMPLETE_DATA`, `READY_TO_SEND` y `CANCELLED`. Los KPI y las pestañas Esperando, Aceptadas y Rechazadas siempre darán 0 (ver [Estados y transiciones](#estados-y-transiciones)).
- Para un conteo barato usa `limit: 1` y lee `pagination.total`.
- Las filas y el total se leen en paralelo, fuera de una transacción: con escrituras simultáneas, el total puede no coincidir un momento con las filas.
- `customer` es un resumen. Un cliente de Messenger no trae `phone` ni `email` salvo que se los hayan agregado en el CRM, y puede traer `firstName` en `null` si Meta no dio el nombre.

## Ver detalle de solicitud de reserva
`GET /reservation-requests/:id`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `ReservationRequest` |
| ft-crm | `requestsApi.get(id: string): Promise<ReservationRequest>` · existe (sin pantalla que la use) |
| Caché | `qk.request(id)` → `["reservation-requests", "detail", id]` · **nueva**. Queda dentro de `qk.requestsAll`. |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la solicitud. Si no es un UUID, responde 400. |

**Respuesta** (200)

```json
{
  "id": "c7a3e9f1-4b2d-4e8a-9f60-2d5b8c1e7a93",
  "code": "RES-2026-000042",
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "sourceChannel": "PHONE",
  "reservationAt": "2026-11-08T01:00:00.000Z",
  "numberOfPeople": 4,
  "quotedPrice": "150.00",
  "currency": "PEN",
  "comments": "Consulta por una reserva familiar",
  "specialRequirements": "Una silla para bebé",
  "status": "READY_TO_SEND",
  "createdAt": "2026-11-03T02:35:20.418Z",
  "updatedAt": "2026-11-03T02:35:20.418Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario solo tiene SUPPORT. |
| 404 | `Solicitud de reserva no encontrada` | La solicitud no existe. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**

- Devuelve el mismo recurso que el listado: `customer` es un resumen (`id`, `firstName`, `lastName`, `phone`, `email`) y `commercialItem` es `null` si no hay elemento.
- Úsalo para abrir una solicitud por id (p. ej. desde un enlace) sin depender de la página del listado en la que esté.
- Muestra las acciones de editar y cancelar solo si `status` es `INCOMPLETE_DATA` o `READY_TO_SEND` y el rol es ADMIN u OPERATOR. Editar en otro estado responde 409. Cancelar una solicitud ya cancelada responde 200 sin cambios; en los demás estados, 409.

## Editar solicitud de reserva
`PATCH /reservation-requests/:id`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `ReservationRequest` |
| ft-crm | `requestsApi.update(id: string, body: UpdateReservationRequestBody): Promise<ReservationRequest>` · **nueva** |
| Caché | Guarda la respuesta en `qk.request(id)` (nueva) e invalida `qk.requestsAll` y `qk.statsAll` (nueva). |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la solicitud. Si no es un UUID, responde 400. |

**Body** (`UpdateReservationRequestBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `customerId` | `Uuid` | No | Cliente existente; no admite `null`. Cambiarlo pasa la solicitud a otro cliente. |
| `sourceChannel` | `ContactChannel` | No | Valor del enum; no admite `null`. |
| `commercialItemId` | `Uuid` \| null | No | Si cambia, el nuevo elemento debe existir, estar activo y `APPROVED`. Reenviar el actual es válido aunque ya esté inactivo. `null` lo quita. |
| `reservationAt` | `IsoDateTime` \| null | No | Mismo formato con segundos y zona. Si llega, tiene que ser futura, aunque sea la misma fecha que ya tenía. `null` la borra. |
| `numberOfPeople` | number \| null | No | Entero JSON de 1 a 2147483647. `null` lo borra. |
| `quotedPrice` | `MoneyString` \| null | No | Mismo formato que al crear. `null` borra el precio y, si no envías `currency`, también la moneda. |
| `currency` | `CurrencyCode` \| null | No | `PEN` o `USD`. Tiene que quedar coherente con el precio. |
| `comments` | string \| null | No | Trim; de 1 a 5000 caracteres. `null` lo borra. |
| `specialRequirements` | string \| null | No | Trim; de 1 a 5000 caracteres. `null` lo borra. |

Reglas del servicio:
- Hay que enviar al menos un campo; `null` cuenta como campo.
- Solo se edita en `INCOMPLETE_DATA` o `READY_TO_SEND`.
- `status` se recalcula en cada edición con la fecha y el número de personas que quedan.
- Precio y moneda, según lo que envíes:

| Envías | Resultado |
|---|---|
| `quotedPrice` nuevo, sin `currency` | Conserva la moneda actual. Si no había, usa la del restaurante (409 si el restaurante no está configurado). |
| `quotedPrice: null`, sin `currency` | Borra el precio y la moneda. |
| `currency` sola | Válida solo si ya hay precio; si no, 400. |
| `currency: null` con precio, o `quotedPrice: null` con una `currency` | 400 `El precio y la moneda deben estar presentes juntos`. |

`status`, `code` y cualquier otro campo responden 400.

**Ejemplo de petición**

```ts
const request = await requestsApi.update("c7a3e9f1-4b2d-4e8a-9f60-2d5b8c1e7a93", {
  numberOfPeople: 5,
  quotedPrice: "180.00",
  specialRequirements: "Una silla para bebé y mesa en terraza",
});
```

Viaja como `PATCH /api/backend/reservation-requests/c7a3e9f1-4b2d-4e8a-9f60-2d5b8c1e7a93` con este body:

```json
{
  "numberOfPeople": 5,
  "quotedPrice": "180.00",
  "specialRequirements": "Una silla para bebé y mesa en terraza"
}
```

**Respuesta** (200)

```json
{
  "id": "c7a3e9f1-4b2d-4e8a-9f60-2d5b8c1e7a93",
  "code": "RES-2026-000042",
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "sourceChannel": "PHONE",
  "reservationAt": "2026-11-08T01:00:00.000Z",
  "numberOfPeople": 5,
  "quotedPrice": "180.00",
  "currency": "PEN",
  "comments": "Consulta por una reserva familiar",
  "specialRequirements": "Una silla para bebé y mesa en terraza",
  "status": "READY_TO_SEND",
  "createdAt": "2026-11-03T02:35:20.418Z",
  "updatedAt": "2026-11-03T03:15:44.071Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega un campo no declarado (p. ej. `status` o `code`). |
| 400 | `customerId must be a UUID` | No es un UUID o es `null`. |
| 400 | `sourceChannel must be one of the following values: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER` | Valor fuera del enum o `null`. |
| 400 | `commercialItemId must be a UUID` | No es un UUID. |
| 400 | `reservationAt must be a string` · `reservationAt must be a valid ISO 8601 date string` · `reservationAt must match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z\|[+-]\d{2}:\d{2})$/ regular expression` | Ver [Crear solicitud de reserva](#crear-solicitud-de-reserva). |
| 400 | `numberOfPeople must be an integer number` · `numberOfPeople must not be less than 1` · `numberOfPeople must not be greater than 2147483647` | No es un entero JSON entre 1 y 2147483647. |
| 400 | `quotedPrice must be a string` · `quotedPrice must match /^(?:0\|[1-9]\d{0,7})(?:\.\d{1,2})?$/ regular expression` | Llega como número o con otro formato. |
| 400 | `currency must be one of the following values: PEN, USD` | Otra moneda. |
| 400 | `comments must be a string` · `comments should not be empty` · `comments must be shorter than or equal to 5000 characters` | Igual para `specialRequirements`. |
| 400 | `Proporciona al menos un campo para actualizar` | El body está vacío (`{}`). Se comprueba antes de buscar la solicitud. |
| 400 | `El elemento comercial debe estar activo y aprobado` | El nuevo `commercialItemId` está inactivo o no está `APPROVED`. |
| 400 | `La fecha de reserva debe ser válida y futura` | El `reservationAt` enviado no es futuro (también si es la misma fecha, ya pasada). |
| 400 | `El precio y la moneda deben estar presentes juntos` | El precio y la moneda no quedan coherentes (ver la tabla de arriba). |
| 400 | `Datos o relaciones de reserva inválidos` | Defensivo: la base de datos rechazó una clave foránea. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Solicitud de reserva no encontrada` | La solicitud no existe. |
| 404 | `Cliente no encontrado` | El nuevo `customerId` no existe. |
| 404 | `Elemento comercial no encontrado` | El nuevo `commercialItemId` no existe. |
| 404 | `Solicitud o reserva no encontrada` | Defensivo. |
| 409 | `La solicitud no admite modificaciones en su estado actual` | La solicitud no está en `INCOMPLETE_DATA` ni en `READY_TO_SEND` (p. ej. está `CANCELLED`). |
| 409 | `Configura el restaurante antes de crear solicitudes o reservas` | Se fija un precio en una solicitud sin moneda, sin enviar `currency`, y el restaurante no está configurado. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 409 | `El código o la solicitud ya están vinculados a una reserva` | Defensivo. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

Orden: `:id` y validación del body → body vacío → solicitud (404) → estado (409) → cliente nuevo (404) → elemento nuevo (404 o 400) → fecha futura (400) → precio y moneda (409 o 400).

**Efectos**

- Actualiza los campos enviados, recalcula `status` (`INCOMPLETE_DATA` ⇄ `READY_TO_SEND`) y cambia `updatedAt`.
- No modifica al cliente ni crea reservas.

**Notas para el frontend**

- Envía solo los campos modificados. Omitir conserva; `null` borra, salvo `customerId` y `sourceChannel`.
- No reenvíes `reservationAt` si no cambió: si la fecha guardada ya pasó, reenviarla responde 400. Si no la envías, la fecha pasada se conserva y puedes editar el resto.
- Borrar la fecha o el número de personas devuelve la solicitud a `INCOMPLETE_DATA`; completar ambos la pasa a `READY_TO_SEND`. Muestra el `status` de la respuesta.
- El precio no se copia del catálogo: si cambian el catálogo o la moneda del restaurante, el precio guardado no cambia.
- Ante el 409 `La solicitud no admite modificaciones…`, recarga la solicitud: otra persona la canceló.

## Cancelar solicitud de reserva
`PATCH /reservation-requests/:id/status`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `ReservationRequest` |
| ft-crm | `requestsApi.cancel(id: string): Promise<ReservationRequest>` · existe (sin pantalla que la use) |
| Caché | Guarda la respuesta en `qk.request(id)` (nueva) e invalida `qk.requestsAll` y `qk.statsAll` (nueva). |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la solicitud. Si no es un UUID, responde 400. |

**Body** (`CancelReservationRequestBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `status` | `"CANCELLED"` | Sí | Único valor aceptado. Cualquier otro estado, `null` o un campo extra responden 400. |

**Ejemplo de petición**

```ts
const request = await requestsApi.cancel("4e1b8d6f-0a3c-4f92-87d5-b6c2e9a1f304");
```

Viaja como `PATCH /api/backend/reservation-requests/4e1b8d6f-0a3c-4f92-87d5-b6c2e9a1f304/status` con este body:

```json
{ "status": "CANCELLED" }
```

**Respuesta** (200)

```json
{
  "id": "4e1b8d6f-0a3c-4f92-87d5-b6c2e9a1f304",
  "code": "RES-2026-000043",
  "customerId": "b8e1d4c7-2a9f-4e63-9d15-7f0a3c6b2e81",
  "commercialItemId": null,
  "sourceChannel": "FACEBOOK",
  "reservationAt": null,
  "numberOfPeople": null,
  "quotedPrice": null,
  "currency": null,
  "comments": "Pregunta por almuerzo para el domingo",
  "specialRequirements": null,
  "status": "CANCELLED",
  "createdAt": "2026-11-03T03:10:02.115Z",
  "updatedAt": "2026-11-03T03:12:09.880Z",
  "customer": {
    "id": "b8e1d4c7-2a9f-4e63-9d15-7f0a3c6b2e81",
    "firstName": "Rosa Mamani",
    "lastName": null,
    "phone": null,
    "email": null
  },
  "commercialItem": null
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega otro campo además de `status`. |
| 400 | `status must be one of the following values: CANCELLED` | Falta, es `null` o llega otro valor (`READY_TO_SEND`, `ACCEPTED`, `REJECTED`…). |
| 400 | `Solo se permite cancelar solicitudes en esta fase` | Defensivo: la validación del body lo intercepta antes. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Solicitud de reserva no encontrada` | La solicitud no existe. |
| 404 | `Solicitud o reserva no encontrada` | Defensivo. |
| 409 | `La solicitud no admite modificaciones en su estado actual` | La solicitud está en un estado distinto de `INCOMPLETE_DATA`, `READY_TO_SEND` o `CANCELLED`. Hoy ninguna ruta lleva a esos estados. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

**Efectos**

- Pasa la solicitud a `CANCELLED` y cambia `updatedAt`. Es un estado final: la solicitud no se puede editar ni reactivar.
- Si ya estaba cancelada, responde 200 con el mismo recurso y el mismo `updatedAt` (idempotente).
- No borra la solicitud ni toca al cliente.

**Notas para el frontend**

- Pide confirmación antes de cancelar: no hay vuelta atrás.
- Muestra la acción solo a ADMIN y OPERATOR (`can(roles, "request.cancel")`) y solo en `INCOMPLETE_DATA` o `READY_TO_SEND`.
- Si una edición y una cancelación llegan a la vez, la cancelación no se pierde: la edición se aplica antes o responde 409. Refresca la solicitud tras cualquier 409.
- Ciclo de vida actual: `INCOMPLETE_DATA` ⇄ `READY_TO_SEND` (lo calcula el backend) → `CANCELLED` (manual y final). Ver [Estados y transiciones](#estados-y-transiciones).

## Crear reserva manual
`POST /reservations`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 201 · `Reservation` |
| ft-crm | `reservationsApi.create(body: CreateReservationBody): Promise<Reservation>` · **nueva** |
| Caché | Invalida `qk.reservationsAll` y `qk.statsAll` (nueva). |
| Cabeceras y límites | Sin `Idempotency-Key`: cada POST crea una reserva con otro `code`. Tras un 504, revisa el calendario antes de reintentar. |

**Body** (`CreateReservationBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `customerId` | `Uuid` | Sí | Cliente existente. |
| `reservationAt` | `IsoDateTime` | Sí | ISO 8601 con segundos y zona (`Z` o `±HH:mm`), hasta 3 decimales. Fecha real y estrictamente posterior a la hora del servidor. |
| `numberOfPeople` | number | Sí | Entero JSON de 1 a 2147483647. El máximo es técnico, no un aforo. |
| `commercialItemId` | `Uuid` \| null | No | Elemento existente, activo y `APPROVED`. |
| `notes` | string \| null | No | Texto general de la reserva. Trim; de 1 a 5000 caracteres. |

Reglas del servicio:
- La reserva nace en `CONFIRMED`, sin responsable y sin solicitud vinculada (`reservationRequestId: null`).
- No se valida aforo, horario de atención, mesas ni solapamientos.
- `reservationRequestId`, `code`, `status`, `assignedUserId` y cualquier otro campo responden 400.

**Ejemplo de petición**

```ts
const reservation = await reservationsApi.create({
  customerId: "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  reservationAt: "2026-11-07T20:00:00-05:00",
  numberOfPeople: 4,
  commercialItemId: "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  notes: "Reserva registrada manualmente por administración",
});
```

Viaja como `POST /api/backend/reservations` con este body:

```json
{
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "reservationAt": "2026-11-07T20:00:00-05:00",
  "numberOfPeople": 4,
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "notes": "Reserva registrada manualmente por administración"
}
```

**Respuesta** (201)

```json
{
  "assignedUserId": null,
  "assignedUser": null,
  "id": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
  "code": "R-2026-000015",
  "reservationRequestId": null,
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "reservationAt": "2026-11-08T01:00:00.000Z",
  "numberOfPeople": 4,
  "status": "CONFIRMED",
  "notes": "Reserva registrada manualmente por administración",
  "createdAt": "2026-11-03T02:45:30.512Z",
  "updatedAt": "2026-11-03T02:45:30.512Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` | Llega un campo no declarado (p. ej. `reservationRequestId`, `status` o `assignedUserId`). |
| 400 | `customerId must be a UUID` | Falta, es `null` o no es un UUID. |
| 400 | `reservationAt must be a string` · `reservationAt must be a valid ISO 8601 date string` · `reservationAt must match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z\|[+-]\d{2}:\d{2})$/ regular expression` | Falta, es `null` (en ambos casos llegan los tres), no es una fecha real o le faltan los segundos o la zona. |
| 400 | `numberOfPeople must be an integer number` · `numberOfPeople must not be less than 1` · `numberOfPeople must not be greater than 2147483647` | Falta o es `null` (llegan los tres), no es un entero JSON o está fuera de rango. |
| 400 | `commercialItemId must be a UUID` | No es un UUID. |
| 400 | `notes must be a string` · `notes should not be empty` · `notes must be shorter than or equal to 5000 characters` | No es texto, queda vacío tras el trim o pasa de 5000. |
| 400 | `El elemento comercial debe estar activo y aprobado` | El elemento está inactivo o no está `APPROVED`. |
| 400 | `La fecha de reserva debe ser válida y futura` | `reservationAt` no es posterior a la hora del servidor. |
| 400 | `Datos o relaciones de reserva inválidos` | Defensivo: la base de datos rechazó una clave foránea. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (p. ej. OPERATOR, OWNER o SUPPORT). |
| 404 | `Cliente no encontrado` | `customerId` no existe. |
| 404 | `Elemento comercial no encontrado` | `commercialItemId` no existe. |
| 409 | `Configura el restaurante antes de crear solicitudes o reservas` | Aún no existe la configuración del restaurante. Se comprueba primero. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 409 | `El código o la solicitud ya están vinculados a una reserva` | Defensivo: colisión de un valor único en la base de datos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |
| 503 | `La zona horaria del restaurante no es válida` | Caso límite: el `timeZone` guardado no es una zona IANA válida. |

Orden: configuración (409) → cliente (404) → elemento (404 o 400) → fecha futura (400) → código (503).

**Efectos**

- Crea la reserva en `CONFIRMED` con su `code` `R-<año>-<secuencia>`:
  - La secuencia es propia de las reservas, tiene al menos 6 dígitos, puede tener saltos y no se reinicia cada año.
  - El año es el de la creación en la zona del restaurante.
  - El código no cambia nunca, tampoco al reprogramar.
- Aparece en `GET /reservations` desde ese momento.
- No aprueba ni vincula ninguna solicitud, no modifica al cliente y no avisa a nadie.

**Notas para el frontend**

- Es la única forma de crear reservas: con el backend actual no existe el paso «solicitud aceptada → reserva». Sin esta pantalla, el calendario estará vacío en modo live.
- Muestra la acción solo a ADMIN. ft-crm no tiene una acción para esto: añade p. ej. `"reservation.create": ["ADMIN"]` en `permissions.ts`.
- Arma `reservationAt` con la fecha y la hora elegidas en la zona del restaurante; `toISOString()` sirve.
- En el selector de elementos, ofrece solo los activos y aprobados.
- Deshabilita el botón mientras la petición está en curso: un doble envío crea dos reservas.
- Después invalida `qk.reservationsAll` y, si la reserva cae en el periodo visible, el calendario la mostrará al refrescar.

## Listar reservas (calendario)
`GET /reservations`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `Paginated<Reservation>` |
| ft-crm | `reservationsApi.list(query: ReservationListQuery): Promise<Paginated<Reservation>>` · existe |
| Caché | `qk.reservations(query)` → `["reservations", "list", query]`. El calendario usa `qk.reservations({ scope: "calendario", dateFrom, dateTo })`. |

**Query** (`ReservationListQuery`)

| Campo | Tipo | Obligatorio | Por defecto | Reglas |
|---|---|---|---|---|
| `page` | number | No | `1` | Entero de 1 a 1 000 000. |
| `limit` | number | No | `20` | Entero de 1 a 100. |
| `dateFrom` | `IsoDateTime` | No | — | Con segundos y zona. Límite **incluido**: `reservationAt >= dateFrom`. |
| `dateTo` | `IsoDateTime` | No | — | Con segundos y zona. Límite **excluido**: `reservationAt < dateTo`. Con ambos, `dateFrom` tiene que ser anterior a `dateTo`. |
| `customerId` | `Uuid` | No | — | Reservas de ese cliente. |
| `commercialItemId` | `Uuid` | No | — | Reservas de ese elemento comercial. |
| `assignedUserId` | `Uuid` | No | — | Reservas asignadas a ese usuario. |
| `status` | `ReservationStatus` | No | — | Un solo valor del enum, incluido `RESCHEDULED`. |
| `excludeCancelled` | boolean | No | — | En la URL solo `true` o `false`, en minúsculas. `true` oculta las `CANCELLED`; `false` o no enviarlo no filtra. No se combina con `status=CANCELLED`. |
| `search` | string | No | — | Trim; de 1 a 200 caracteres. Coincidencia parcial y sin distinguir mayúsculas en `code` y en el nombre y apellido del cliente. En el `phone` del cliente, coincidencia con el texto tal como se guardó; y, si el texto tiene dígitos, en su teléfono normalizado. No busca por email. |

**Ejemplo de petición**

La semana del lunes 2 al domingo 8 de noviembre en Lima, como la pide `CalendarioView` con `reservationsPageQuery`:

```ts
const page = await reservationsApi.list({
  dateFrom: "2026-11-02T05:00:00.000Z",
  dateTo: "2026-11-09T05:00:00.000Z",
  excludeCancelled: true,
  page: 1,
  limit: 100,
});
```

Viaja como `GET /api/backend/reservations?dateFrom=2026-11-02T05%3A00%3A00.000Z&dateTo=2026-11-09T05%3A00%3A00.000Z&excludeCancelled=true&page=1&limit=100`.

**Respuesta** (200)

```json
{
  "data": [
    {
      "assignedUserId": null,
      "assignedUser": null,
      "id": "0b4e7d2a-9c1f-4a58-b3e6-2f8d5c7a9e14",
      "code": "R-2026-000014",
      "reservationRequestId": null,
      "customerId": "b8e1d4c7-2a9f-4e63-9d15-7f0a3c6b2e81",
      "commercialItemId": null,
      "reservationAt": "2026-11-07T23:30:00.000Z",
      "numberOfPeople": 2,
      "status": "UPCOMING",
      "notes": null,
      "createdAt": "2026-11-03T01:10:44.207Z",
      "updatedAt": "2026-11-03T01:58:02.639Z",
      "customer": {
        "id": "b8e1d4c7-2a9f-4e63-9d15-7f0a3c6b2e81",
        "firstName": "Rosa Mamani",
        "lastName": null,
        "phone": null,
        "email": null
      },
      "commercialItem": null
    },
    {
      "assignedUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
      "assignedUser": {
        "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
        "firstName": "María",
        "lastName": "Huamán",
        "isActive": true,
        "isEligible": true
      },
      "id": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
      "code": "R-2026-000015",
      "reservationRequestId": null,
      "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
      "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
      "reservationAt": "2026-11-08T18:00:00.000Z",
      "numberOfPeople": 6,
      "status": "UPCOMING",
      "notes": "Se amplió el grupo",
      "createdAt": "2026-11-03T02:45:30.512Z",
      "updatedAt": "2026-11-03T03:20:41.093Z",
      "customer": {
        "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
        "firstName": "Carlos",
        "lastName": "Quispe",
        "phone": "987 654 321",
        "email": "carlos.quispe@example.com"
      },
      "commercialItem": {
        "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
        "nameEs": "Trucha a la parrilla",
        "nameEn": "Grilled trout",
        "type": "DISH",
        "isActive": true,
        "approvalStatus": "APPROVED"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 100, "total": 2, "totalPages": 1 }
}
```

La primera reserva es el sábado 7 a las 18:30 en Lima; la segunda, el domingo 8 a las 13:00.

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `property <parámetro> should not exist` | Llega un parámetro no declarado (p. ej. `view`). |
| 400 | `page must be an integer number` · `page must not be less than 1` · `page must not be greater than 1000000` | `page` no es un entero entre 1 y 1 000 000. |
| 400 | `limit must be an integer number` · `limit must not be less than 1` · `limit must not be greater than 100` | `limit` no es un entero entre 1 y 100. |
| 400 | `customerId must be a UUID` · `commercialItemId must be a UUID` · `assignedUserId must be a UUID` | No son UUID. |
| 400 | `dateFrom must be a string` · `dateFrom must be a valid ISO 8601 date string` · `dateFrom must match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z\|[+-]\d{2}:\d{2})$/ regular expression` | Parámetro repetido, fecha imposible o sin segundos ni zona. Un `+` sin codificar llega como espacio. Los mismos mensajes existen para `dateTo`. |
| 400 | `status must be one of the following values: CONFIRMED, UPCOMING, IN_SERVICE, COMPLETED, RESCHEDULED, CANCELLED, NO_SHOW` | Valor fuera del enum. |
| 400 | `excludeCancelled must be a boolean value` | Algo distinto de `true` o `false` (p. ej. `TRUE`, `1` o `yes`). |
| 400 | `search must be a string` · `search should not be empty` · `search must be shorter than or equal to 200 characters` | Vacío o solo espacios, más de 200 caracteres, o el parámetro repetido. |
| 400 | `No combines status=CANCELLED con excludeCancelled=true` | Llegan los dos filtros a la vez. |
| 400 | `dateFrom debe ser anterior a dateTo y las fechas deben ser válidas` | `dateFrom` es igual o posterior a `dateTo`. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario solo tiene SUPPORT. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**

- Las vistas de día, semana y mes usan esta ruta. Solo lee reservas: las solicitudes nunca aparecen en el calendario.
- El rango es semiabierto (`dateFrom <= reservationAt < dateTo`). Puedes enviar un solo límite y consultar fechas pasadas.
- El backend filtra instantes, no días. Calcula la medianoche en la zona del restaurante y conviértela en instante, como hace `periodRange` en `calendar-utils.ts`:
  - Un día en Lima: `dateFrom=2026-11-07T05:00:00.000Z` y `dateTo=2026-11-08T05:00:00.000Z` (equivalen a `…T00:00:00-05:00`).
  - Semana o mes: el inicio del periodo y el inicio del siguiente.
  - Si envías offsets positivos, construye la URL con `toSearch` o `URLSearchParams`: así el `+` viaja como `%2B`.
- Orden fijo: `reservationAt` ascendente y luego `id` ascendente. El máximo es 100 por página: para un periodo completo usa `limit: 100` y recorre las páginas hasta `totalPages` (`collectPages`, que ft-crm corta en 20 páginas).
- Agrupa por día con la zona del restaurante, nunca por el día UTC (`groupByDay`). Una cena a las 20:00 en Lima ya es el día siguiente en UTC.
- Sin `excludeCancelled` se incluyen las canceladas; las finalizadas (`COMPLETED`, `NO_SHOW`) siempre se incluyen.
- No hay filtro de reservas sin responsable. Para «Mis reservas», filtra con `assignedUserId` igual al `id` de `GET /auth/me`.
- El listado no trae `noteHistory` ni `rescheduleHistory`: solo los trae el detalle.
- Para un conteo barato usa `limit: 1` y lee `pagination.total` (columna RESERVAS de Clientes).
- Las filas y el total se leen en paralelo, fuera de una transacción, y cada página es una consulta aparte. Si cambian reservas mientras recorres las páginas, una puede repetirse o faltar. `groupByDay` ya descarta las repetidas.

## Ver detalle de reserva
`GET /reservations/:id`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `ReservationDetail` |
| ft-crm | `reservationsApi.get(id: string): Promise<ReservationDetail>` · existe |
| Caché | `qk.reservation(id)` → `["reservations", "detail", id]`. |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la reserva. Si no es un UUID, responde 400. |

**Respuesta** (200)

```json
{
  "assignedUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
  "assignedUser": {
    "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
    "firstName": "María",
    "lastName": "Huamán",
    "isActive": true,
    "isEligible": true
  },
  "id": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
  "code": "R-2026-000015",
  "reservationRequestId": null,
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "reservationAt": "2026-11-08T18:00:00.000Z",
  "numberOfPeople": 6,
  "status": "UPCOMING",
  "notes": "Se amplió el grupo",
  "createdAt": "2026-11-03T02:45:30.512Z",
  "updatedAt": "2026-11-03T03:20:41.093Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  },
  "noteHistory": [
    {
      "id": "a9c3e7b1-5d2f-4a86-8e14-6f0b2d9c3e57",
      "reservationId": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
      "authorUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
      "content": "Cliente solicita mesa cerca de la ventana",
      "createdAt": "2026-11-03T02:52:47.905Z",
      "author": {
        "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
        "firstName": "María",
        "lastName": "Huamán"
      }
    }
  ],
  "rescheduleHistory": [
    {
      "id": "f4e8a2c6-1b9d-4f73-b2a5-7c3e0d8f1a96",
      "previousReservationAt": "2026-11-08T01:00:00.000Z",
      "newReservationAt": "2026-11-08T18:00:00.000Z",
      "reason": "Cliente solicitó cambio de horario",
      "changedByUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
      "createdAt": "2026-11-03T03:01:19.664Z",
      "changedBy": {
        "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
        "firstName": "María",
        "lastName": "Huamán"
      }
    }
  ]
}
```

Es la reserva `R-2026-000015` de los ejemplos de este archivo, después de asignarla, agregar una observación, editarla, reprogramarla y marcarla como preparada (`UPCOMING`).

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario solo tiene SUPPORT. |
| 404 | `Reserva no encontrada` | La reserva no existe. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**

- Devuelve lo mismo que el listado más `noteHistory` y `rescheduleHistory`. Ambos vienen ordenados por `createdAt` ascendente (luego por `id`), sin paginar.
- `assignedUser.isEligible` se calcula en cada lectura: el responsable está activo y hoy tiene ADMIN u OPERATOR. Si es `false`, muestra un aviso: un ADMIN puede reasignar la reserva. Si el usuario se borra de la base de datos, `assignedUserId` pasa a `null`.
- `notes` es el texto general, editable con el PATCH. `noteHistory` son las observaciones con autor, que se crean con `POST /reservations/:id/notes`. Son independientes.
- Con las rutas actuales, `reservationRequestId` siempre es `null`: la etiqueta «Aceptada por el dueño» de `ReservationSummary` nunca se mostrará en modo live.
- La reserva no trae canal. ft-crm muestra el `sourceChannel` del cliente con `customersApi.get(customerId)`.
- `ReservationDetailPanel` carga la reserva por id, así que el panel sigue abierto aunque la reserva salga del periodo visible tras reprogramarla.
- Usa `RESERVATION_STATUS_TRANSITIONS` y la hora de la reserva para decidir qué acciones mostrar (ver [Estados y transiciones](#estados-y-transiciones)).

## Editar reserva
`PATCH /reservations/:id`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `Reservation` (sin historiales) |
| ft-crm | `reservationsApi.update(id: string, body: UpdateReservationBody): Promise<Reservation>` · **nueva** |
| Caché | Mezcla la respuesta en `qk.reservation(id)` e invalida `qk.reservationsAll` (refresca el calendario y el `rescheduleHistory` del detalle) y `qk.statsAll` (nueva). |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la reserva. Si no es un UUID, responde 400. |

**Body** (`UpdateReservationBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `customerId` | `Uuid` | No | Cliente existente; no admite `null`. |
| `reservationAt` | `IsoDateTime` | No | Con segundos y zona; no admite `null`. Si llega, tiene que ser futura, aunque sea el mismo instante. Si cambia el instante, la reserva pasa a `RESCHEDULED` y se agrega una entrada al historial. |
| `numberOfPeople` | number | No | Entero JSON de 1 a 2147483647; no admite `null`. |
| `commercialItemId` | `Uuid` \| null | No | Si cambia, el nuevo elemento debe existir, estar activo y `APPROVED`. Reenviar el actual es válido aunque ya esté inactivo. `null` lo quita. |
| `notes` | string \| null | No | Texto general. Trim; de 1 a 5000 caracteres. `null` lo borra. |

Reglas del servicio:
- Hay que enviar al menos un campo; `null` cuenta como campo.
- Solo se edita en `CONFIRMED`, `UPCOMING` o `RESCHEDULED`.
- `status`, `code`, `assignedUserId`, `reservationRequestId` y cualquier otro campo responden 400.

**Ejemplo de petición**

```ts
const reservation = await reservationsApi.update("e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74", {
  numberOfPeople: 6,
  notes: "Se amplió el grupo",
});
```

Viaja como `PATCH /api/backend/reservations/e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74` con este body:

```json
{
  "numberOfPeople": 6,
  "notes": "Se amplió el grupo"
}
```

**Respuesta** (200)

```json
{
  "assignedUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
  "assignedUser": {
    "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
    "firstName": "María",
    "lastName": "Huamán",
    "isActive": true,
    "isEligible": true
  },
  "id": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
  "code": "R-2026-000015",
  "reservationRequestId": null,
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "reservationAt": "2026-11-08T01:00:00.000Z",
  "numberOfPeople": 6,
  "status": "CONFIRMED",
  "notes": "Se amplió el grupo",
  "createdAt": "2026-11-03T02:45:30.512Z",
  "updatedAt": "2026-11-03T02:57:10.226Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega un campo no declarado (p. ej. `status` o `assignedUserId`). |
| 400 | `customerId must be a UUID` | No es un UUID o es `null`. |
| 400 | `reservationAt must be a string` · `reservationAt must be a valid ISO 8601 date string` · `reservationAt must match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z\|[+-]\d{2}:\d{2})$/ regular expression` | Es `null` (llegan los tres), no es una fecha real o le faltan los segundos o la zona. |
| 400 | `numberOfPeople must be an integer number` · `numberOfPeople must not be less than 1` · `numberOfPeople must not be greater than 2147483647` | Es `null` (llegan los tres), no es un entero JSON o está fuera de rango. |
| 400 | `commercialItemId must be a UUID` | No es un UUID. |
| 400 | `notes must be a string` · `notes should not be empty` · `notes must be shorter than or equal to 5000 characters` | No es texto, queda vacío tras el trim o pasa de 5000. |
| 400 | `Proporciona al menos un campo para actualizar` | El body está vacío (`{}`). Se comprueba antes de buscar la reserva. |
| 400 | `El elemento comercial debe estar activo y aprobado` | El nuevo elemento está inactivo o no está `APPROVED`. |
| 400 | `La fecha de reserva debe ser válida y futura` | El `reservationAt` enviado no es futuro (también si es el mismo instante, ya pasado). |
| 400 | `Datos o relaciones de reserva inválidos` | Defensivo: la base de datos rechazó una clave foránea. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Reserva no encontrada` | La reserva no existe. |
| 404 | `Cliente no encontrado` | El nuevo `customerId` no existe. |
| 404 | `Elemento comercial no encontrado` | El nuevo `commercialItemId` no existe. |
| 404 | `Solicitud o reserva no encontrada` | Defensivo. |
| 409 | `La reserva no admite edición o reprogramación en su estado actual` | La reserva está en `IN_SERVICE`, `COMPLETED`, `CANCELLED` o `NO_SHOW`. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 409 | `El código o la solicitud ya están vinculados a una reserva` | Defensivo. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

Orden: `:id` y validación del body → body vacío → reserva (404) → estado (409) → cliente nuevo (404) → elemento nuevo (404 o 400) → fecha futura (400).

**Efectos**

- Actualiza los campos enviados y `updatedAt`. El `code` nunca cambia.
- Si `reservationAt` cambia de instante, en la misma transacción:
  - el estado pasa a `RESCHEDULED`;
  - se agrega una entrada a `rescheduleHistory` con la fecha anterior, la nueva, `reason: null` y el usuario del token como autor.
- Si llega el mismo instante (aunque sea con otro offset), no se agrega historial y el estado no cambia.
- No cambia el responsable ni las observaciones, y no avisa a nadie.

**Notas para el frontend**

- Para cambiar la fecha con un motivo, usa [Reprogramar reserva](#reprogramar-reserva); este PATCH guarda el cambio con `reason: null`.
- Envía solo los campos modificados. Si la hora de la reserva ya pasó, no reenvíes `reservationAt`: la respuesta sería 400. Sin `reservationAt`, puedes editar las notas de una reserva pasada.
- Habilita la edición solo en `CONFIRMED`, `UPCOMING` y `RESCHEDULED`.
- La respuesta no trae `noteHistory` ni `rescheduleHistory`: mézclala con el detalle en caché y luego invalida `qk.reservationsAll`.
- Si una cancelación llega a la vez que esta edición, la cancelación no se pierde: la edición se aplica antes o responde 409.

## Cambiar estado de reserva
`PATCH /reservations/:id/status`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `Reservation` (sin historiales) |
| ft-crm | `reservationsApi.setStatus(id: string, status: ReservationStatusTarget): Promise<Reservation>` · existe (la usa «Marcar como preparada») |
| Caché | Mezcla la respuesta en `qk.reservation(id)` e invalida `qk.reservationsAll` (ya lo hace `PrepareControl`) y `qk.statsAll` (nueva). |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la reserva. Si no es un UUID, responde 400. |

**Body** (`UpdateReservationStatusBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `status` | `ReservationStatusTarget` | Sí | `CONFIRMED`, `UPCOMING`, `IN_SERVICE`, `COMPLETED`, `CANCELLED` o `NO_SHOW`. `RESCHEDULED` no se acepta: lo pone el backend al cambiar la fecha. |

Reglas del servicio:
- Solo se aceptan las transiciones de `RESERVATION_STATUS_TRANSITIONS` (ver [Estados y transiciones](#estados-y-transiciones)).
- `IN_SERVICE` y `NO_SHOW` exigen que haya llegado la hora: `reservationAt <= ahora`, según el reloj del servidor y sin tolerancia.
- Enviar el estado actual responde 200 sin cambios, incluso en un estado final.

**Ejemplo de petición**

```ts
const reservation = await reservationsApi.setStatus("e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74", "UPCOMING");
```

Viaja como `PATCH /api/backend/reservations/e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74/status` con este body:

```json
{ "status": "UPCOMING" }
```

**Respuesta** (200)

```json
{
  "assignedUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
  "assignedUser": {
    "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
    "firstName": "María",
    "lastName": "Huamán",
    "isActive": true,
    "isEligible": true
  },
  "id": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
  "code": "R-2026-000015",
  "reservationRequestId": null,
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "reservationAt": "2026-11-08T18:00:00.000Z",
  "numberOfPeople": 6,
  "status": "UPCOMING",
  "notes": "Se amplió el grupo",
  "createdAt": "2026-11-03T02:45:30.512Z",
  "updatedAt": "2026-11-03T03:20:41.093Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega otro campo además de `status`. |
| 400 | `status must be one of the following values: CONFIRMED, UPCOMING, IN_SERVICE, COMPLETED, CANCELLED, NO_SHOW` | Falta, es `null`, no está en la lista o es `RESCHEDULED`. |
| 400 | `Estado no habilitado en esta fase` | Defensivo: la validación del body lo intercepta antes. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Reserva no encontrada` | La reserva no existe. |
| 404 | `Solicitud o reserva no encontrada` | Defensivo. |
| 409 | `Transición de reserva no permitida` | El destino no está permitido desde el estado actual (p. ej. `UPCOMING` → `CONFIRMED`, o cualquier cambio desde un estado final). |
| 409 | `Todavía no ha llegado la hora de la reserva` | Se pide `IN_SERVICE` o `NO_SHOW` y `reservationAt` sigue en el futuro. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

Orden: reserva (404) → mismo estado (200 sin cambios) → transición permitida (409) → hora de la reserva (409).

**Efectos**

- Cambia `status` y `updatedAt`. Con el mismo estado no cambia nada, ni siquiera `updatedAt`.
- Cancelar no borra la reserva (no hay rutas `DELETE`): sigue en el calendario salvo que filtres con `excludeCancelled=true`.
- No cambia el responsable ni avisa a nadie. Ningún proceso del backend cambia estados por la hora.

**Notas para el frontend**

- Muestra solo los botones de `RESERVATION_STATUS_TRANSITIONS[status]` (ya está en `types.ts`).
- Habilita `IN_SERVICE` y `NO_SHOW` solo cuando `reservationAt <= ahora`. El backend usa su reloj, sin margen: si el del navegador va adelantado, aún puedes recibir el 409.
- `UPCOMING` es la «preparada» de ft-crm (`PREPARED_STATUS`). No hay vuelta directa a `CONFIRMED` (409). Si se reprograma, la reserva pasa a `RESCHEDULED`, y desde ahí sí puede volver a `CONFIRMED`.
- Pide confirmación para `CANCELLED`, `COMPLETED` y `NO_SHOW`: son finales y no se reactivan.
- Ante un 409, refresca el detalle: otra persona pudo cambiar el estado. `PrepareControl` ya invalida `qk.reservationsAll` en `onSettled`.

## Asignar o liberar responsable
`PATCH /reservations/:id/assignee`

| | |
|---|---|
| Roles | ADMIN, OPERATOR (un OPERATOR solo toma reservas libres o gestiona su propia asignación) |
| Respuesta | 200 · `Reservation` (sin historiales) |
| ft-crm | `reservationsApi.assign(id: string, body: AssignReservationBody): Promise<Reservation>` · **nueva** |
| Caché | Mezcla la respuesta en `qk.reservation(id)` e invalida `qk.reservationsAll` (cambia el filtro por `assignedUserId`). |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la reserva. Si no es un UUID, responde 400. |

**Body** (`AssignReservationBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `assignedUserId` | `Uuid` \| null | Sí | Usuario existente, activo y con rol ADMIN u OPERATOR. `null` libera la reserva. La clave es obligatoria: `{}` responde 400. |

Reglas del servicio:
- Solo en `CONFIRMED`, `UPCOMING`, `RESCHEDULED` o `IN_SERVICE`.
- ADMIN puede asignar, reemplazar o quitar a cualquier usuario elegible. Si un usuario tiene ADMIN y OPERATOR, aplican las reglas de ADMIN.
- OPERATOR (sin ADMIN) solo puede:
  - tomar una reserva libre para sí mismo (`assignedUserId` = su id);
  - reenviar su propia asignación, o `null` en una reserva libre (200 sin cambios);
  - liberar (`null`) una reserva asignada a él.
- La elegibilidad se comprueba antes que la igualdad: reenviar un responsable que ya no es elegible responde 400.

**Ejemplo de petición**

```ts
const reservation = await reservationsApi.assign("e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74", {
  assignedUserId: "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
});
```

Viaja como `PATCH /api/backend/reservations/e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74/assignee` con este body:

```json
{ "assignedUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35" }
```

Para liberar: `reservationsApi.assign(id, { assignedUserId: null })`.

**Respuesta** (200)

```json
{
  "assignedUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
  "assignedUser": {
    "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
    "firstName": "María",
    "lastName": "Huamán",
    "isActive": true,
    "isEligible": true
  },
  "id": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
  "code": "R-2026-000015",
  "reservationRequestId": null,
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "reservationAt": "2026-11-08T01:00:00.000Z",
  "numberOfPeople": 4,
  "status": "CONFIRMED",
  "notes": "Reserva registrada manualmente por administración",
  "createdAt": "2026-11-03T02:45:30.512Z",
  "updatedAt": "2026-11-03T02:50:02.318Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega otro campo (p. ej. `userId`). |
| 400 | `assignedUserId must be a UUID` | Falta la clave (`{}`), es `""` o no es un UUID. |
| 400 | `El responsable debe estar activo y tener rol OPERATOR o ADMIN` | El usuario elegido está inactivo o no tiene ADMIN ni OPERATOR (p. ej. un OWNER). |
| 400 | `Datos o relaciones de reserva inválidos` | Defensivo: la base de datos rechazó una clave foránea. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 403 | `Un operador solo puede tomar una reserva libre o gestionar su propia asignación` | Un OPERATOR sin ADMIN intenta asignar a otra persona, o tocar una reserva asignada a otra persona. |
| 404 | `Reserva no encontrada` | La reserva no existe. |
| 404 | `Responsable no encontrado` | `assignedUserId` no corresponde a ningún usuario. |
| 404 | `Solicitud o reserva no encontrada` | Defensivo. |
| 409 | `No se modifica el responsable de una reserva finalizada` | La reserva está en `COMPLETED`, `CANCELLED` o `NO_SHOW`. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

Orden: reserva (404) → estado final (409) → reglas de OPERATOR (403) → responsable (404) → elegibilidad (400) → mismo responsable (200 sin cambios).

**Efectos**

- Cambia `assignedUserId`, `assignedUser` y `updatedAt`. Con el mismo responsable no cambia nada, ni siquiera `updatedAt`.
- No notifica al responsable y no cambia la asignación de la conversación del cliente (son independientes).
- La asignación no limita quién puede operar la reserva: cualquier ADMIN u OPERATOR puede editarla o cambiar su estado.

**Notas para el frontend**

- ADMIN: arma el selector con `usersApi.list()` (`GET /users`, solo ADMIN) y quédate con los usuarios `isActive` que tengan `ADMIN` u `OPERATOR` en `roles`.
- OPERATOR: no puede listar usuarios. Muestra «Tomar» si la reserva está libre (`{ assignedUserId: <id de GET /auth/me> }`) y «Liberar» si es suya (`{ assignedUserId: null }`). Oculta ambas cuando está asignada a otra persona.
- Dos operadores que toman la misma reserva libre a la vez: uno recibe 200 y el otro 403. Refresca el detalle tras el 403.
- Si `assignedUser.isEligible` es `false`, avisa de que el responsable ya no puede atenderla y ofrece a un ADMIN reasignarla.
- Para «Mis reservas», filtra el calendario con `assignedUserId`.

## Agregar observación a la reserva
`POST /reservations/:id/notes`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 201 · `ReservationNote` |
| ft-crm | `reservationsApi.addNote(id: string, content: string): Promise<ReservationNote>` · **nueva** |
| Caché | Agrega la nota al final de `noteHistory` en `qk.reservation(id)` con `setQueryData`, o invalida `qk.reservation(id)`. El listado no cambia. |
| Cabeceras y límites | Sin `Idempotency-Key`: cada POST crea otra observación. |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la reserva. Si no es un UUID, responde 400. |

**Body** (`CreateReservationNoteBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `content` | string | Sí | Trim; de 1 a 5000 caracteres. No admite `null`. |

El autor sale del token. Enviar `authorUserId` u otro campo responde 400.

**Ejemplo de petición**

```ts
const note = await reservationsApi.addNote(
  "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
  "Cliente solicita mesa cerca de la ventana",
);
```

Viaja como `POST /api/backend/reservations/e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74/notes` con este body:

```json
{ "content": "Cliente solicita mesa cerca de la ventana" }
```

**Respuesta** (201)

```json
{
  "id": "a9c3e7b1-5d2f-4a86-8e14-6f0b2d9c3e57",
  "reservationId": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
  "authorUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
  "content": "Cliente solicita mesa cerca de la ventana",
  "createdAt": "2026-11-03T02:52:47.905Z",
  "author": {
    "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
    "firstName": "María",
    "lastName": "Huamán"
  }
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega otro campo (p. ej. `authorUserId`). |
| 400 | `content must be a string` · `content should not be empty` · `content must be shorter than or equal to 5000 characters` | Falta o es `null` (llegan los tres), no es texto, queda vacío tras el trim o pasa de 5000. |
| 400 | `Datos o relaciones de reserva inválidos` | Defensivo: la base de datos rechazó una clave foránea. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Reserva no encontrada` | La reserva no existe. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

**Efectos**

- Crea una observación con el usuario del token como autor y la hora del servidor.
- No modifica el campo `notes` ni el `updatedAt` de la reserva, y no cambia su estado.
- No hay rutas para editar ni borrar observaciones.

**Notas para el frontend**

- Se permite en cualquier estado, incluidos los finales: sirve para aclaraciones posteriores.
- Deshabilita el botón mientras la petición está en curso: un doble clic crea dos observaciones.
- La respuesta trae `author` con nombre y apellido. Agrégala al final de `noteHistory` (orden por `createdAt` ascendente) o recarga el detalle.
- `notes` (texto general, editable con el PATCH) y `noteHistory` son independientes: muéstralos por separado.

## Reprogramar reserva
`PATCH /reservations/:id/reschedule`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `Reservation` (sin historiales) |
| ft-crm | `reservationsApi.reschedule(id: string, body: RescheduleReservationBody): Promise<Reservation>` · **nueva** |
| Caché | Mezcla la respuesta en `qk.reservation(id)` e invalida `qk.reservationsAll` (la reserva puede salir del periodo visible y el detalle gana una entrada en `rescheduleHistory`) y `qk.statsAll` (nueva). |

**Parámetros de ruta**

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la reserva. Si no es un UUID, responde 400. |

**Body** (`RescheduleReservationBody`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `reservationAt` | `IsoDateTime` | Sí | Con segundos y zona (`Z` o `±HH:mm`), hasta 3 decimales. Fecha real y estrictamente posterior a la hora del servidor. No admite `null`. |
| `reason` | string \| null | No | Motivo. Trim; de 1 a 5000 caracteres. |

Reglas del servicio:
- Solo en `CONFIRMED`, `UPCOMING` o `RESCHEDULED`.
- El autor sale del token. Enviar `changedByUserId` u otro campo responde 400.

**Ejemplo de petición**

```ts
const reservation = await reservationsApi.reschedule("e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74", {
  reservationAt: "2026-11-08T13:00:00-05:00",
  reason: "Cliente solicitó cambio de horario",
});
```

Viaja como `PATCH /api/backend/reservations/e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74/reschedule` con este body:

```json
{
  "reservationAt": "2026-11-08T13:00:00-05:00",
  "reason": "Cliente solicitó cambio de horario"
}
```

**Respuesta** (200)

```json
{
  "assignedUserId": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
  "assignedUser": {
    "id": "5d9a1f3c-2e7b-4b48-9c06-8a4e1d7f2b35",
    "firstName": "María",
    "lastName": "Huamán",
    "isActive": true,
    "isEligible": true
  },
  "id": "e2b7c4d9-8f1a-4c36-a5e2-9b0d3f6a1c74",
  "code": "R-2026-000015",
  "reservationRequestId": null,
  "customerId": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
  "commercialItemId": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
  "reservationAt": "2026-11-08T18:00:00.000Z",
  "numberOfPeople": 6,
  "status": "RESCHEDULED",
  "notes": "Se amplió el grupo",
  "createdAt": "2026-11-03T02:45:30.512Z",
  "updatedAt": "2026-11-03T03:01:19.664Z",
  "customer": {
    "id": "3f6c2a8e-91b4-4d2f-8a7e-5c1d9b0e7f42",
    "firstName": "Carlos",
    "lastName": "Quispe",
    "phone": "987 654 321",
    "email": "carlos.quispe@example.com"
  },
  "commercialItem": {
    "id": "6a2d9e14-7c3b-4f85-b0e2-1d8c4a9f3e57",
    "nameEs": "Trucha a la parrilla",
    "nameEn": "Grilled trout",
    "type": "DISH",
    "isActive": true,
    "approvalStatus": "APPROVED"
  }
}
```

**Errores**

| Código | Mensaje | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Llega otro campo (p. ej. `changedByUserId`). |
| 400 | `reservationAt must be a string` · `reservationAt must be a valid ISO 8601 date string` · `reservationAt must match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z\|[+-]\d{2}:\d{2})$/ regular expression` | Falta o es `null` (llegan los tres), no es una fecha real o le faltan los segundos o la zona. |
| 400 | `reason must be a string` · `reason should not be empty` · `reason must be shorter than or equal to 5000 characters` | No es texto, queda vacío tras el trim o pasa de 5000. |
| 400 | `La fecha de reserva debe ser válida y futura` | `reservationAt` no es posterior a la hora del servidor. |
| 400 | `Datos o relaciones de reserva inválidos` | Defensivo: la base de datos rechazó una clave foránea. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` · `Inicia sesión para continuar.` | Los responde el BFF. Ver [Convenciones del módulo](#errores-que-ves-desde-el-navegador). |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. solo OWNER o SUPPORT). |
| 404 | `Reserva no encontrada` | La reserva no existe. |
| 404 | `Solicitud o reserva no encontrada` | Defensivo. |
| 409 | `La reserva no admite edición o reprogramación en su estado actual` | La reserva está en `IN_SERVICE`, `COMPLETED`, `CANCELLED` o `NO_SHOW`. Se comprueba antes que la fecha. |
| 409 | `Conflicto concurrente; vuelve a intentarlo` | La transacción siguió en conflicto tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body pasa de 100 kb. |

Orden: reserva (404) → estado (409) → fecha futura (400) → mismo instante (200 sin cambios).

**Efectos**

- Si el instante es distinto, en una sola transacción:
  - `reservationAt` cambia y el estado pasa a `RESCHEDULED` (también desde `UPCOMING`);
  - se agrega una entrada a `rescheduleHistory` con `previousReservationAt`, `newReservationAt`, `reason` y `changedByUserId` (el usuario del token).
- Si es el mismo instante (aunque sea con otro offset), responde 200 sin cambios: no hay historial, se ignora `reason` y `updatedAt` no cambia.
- El `code`, el responsable y las observaciones no cambian. No avisa al cliente ni a nadie.
- Con dos reprogramaciones simultáneas, ambas se aplican en orden y el historial queda encadenado (cada `previousReservationAt` es el `newReservationAt` anterior).

**Notas para el frontend**

- Úsala para «Reprogramar» con motivo. Muestra la acción solo en `CONFIRMED`, `UPCOMING` y `RESCHEDULED`.
- Si quieres detectar «sin cambios», compara `updatedAt` de la respuesta con el que tenías.
- Para volver a `CONFIRMED` después de reprogramar, usa `PATCH /reservations/:id/status`.
- La reserva puede salir del periodo visible: refresca el calendario. El panel de detalle de ft-crm la sigue mostrando porque la carga por id.

## Modelos

Recursos que devuelve el módulo. «Null» indica si el campo puede llegar en `null`; los campos siempre están presentes. Las fechas son instantes ISO 8601 en UTC.

### `Customer`

Respuesta de `POST /customers`, `GET /customers`, `PATCH /customers/:id` y `PATCH /customers/:id/status`.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Identificador del cliente. |
| `firstName` | string | Sí | Nombre (1–100). En Messenger, el nombre completo que da Meta; en WhatsApp, `null` hasta que alguien lo edite. |
| `lastName` | string | Sí | Apellido (1–100). Los webhooks no lo llenan. |
| `phone` | string | Sí | Teléfono tal como se escribió, con trim (hasta 80). WhatsApp: `+` y los dígitos (`"+51912345678"`). |
| `phoneCountry` | string | Sí | País ISO alfa-2 en mayúsculas enviado con el teléfono. `null` si no se indicó o se borró el teléfono. |
| `email` | string | Sí | Email en minúsculas (hasta 320). |
| `sourceChannel` | `ContactChannel` | No | Canal de origen. Los webhooks crean `WHATSAPP` o `FACEBOOK`. |
| `status` | `CustomerStatus` | No | Estado comercial. Nace en `NEW`. |
| `firstContactAt` | `IsoDateTime` | No | Primer contacto (alta). No cambia. |
| `lastContactAt` | `IsoDateTime` | No | Último mensaje entrante o interés registrado. Nunca retrocede. |
| `notes` | string | Sí | Notas internas (1–5000). |
| `createdAt` | `IsoDateTime` | No | Alta del registro. |
| `updatedAt` | `IsoDateTime` | No | Última modificación. |

La API no expone `normalizedPhone`, `normalizedEmail`, `providerAccountId` ni `externalContactId` (identidad de Messenger).

### `CustomerDetail`

Respuesta de `GET /customers/:id`: `Customer` más `interests: CustomerInterest[]`, ordenado por `lastInterestedAt` descendente y luego por `id` ascendente.

### `CustomerInterest`

Respuesta de `POST /customers/:id/interests` y elementos de `CustomerDetail.interests`.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del interés. Ninguna ruta lo usa: el DELETE recibe el id del elemento. |
| `firstInterestedAt` | `IsoDateTime` | No | Primer registro. |
| `lastInterestedAt` | `IsoDateTime` | No | Último registro; cambia al repetir el POST. |
| `notes` | string | Sí | Nota del interés (1–5000). |
| `commercialItem` | `CommercialItemSummary` | No | Elemento comercial, con su estado actual. |

### `CommercialItemSummary`

Resumen del catálogo dentro de intereses, solicitudes y reservas.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del elemento comercial. |
| `nameEs` | string | Sí | Nombre en español. Al menos uno de los dos nombres tiene valor. |
| `nameEn` | string | Sí | Nombre en inglés. |
| `type` | `CommercialItemType` | No | `DISH`, `BEVERAGE`, `SERVICE`, `PROMOTION` o `EVENT`. |
| `isActive` | boolean | No | Estado actual; un registro antiguo puede apuntar a un elemento inactivo. |
| `approvalStatus` | `CommercialApprovalStatus` | No | `DRAFT`, `APPROVED` o `REJECTED`. |

### `CustomerSummary`

Cliente dentro de solicitudes, reservas y conversaciones. Refleja los datos actuales del cliente.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del cliente. |
| `firstName` | string | Sí | Nombre. |
| `lastName` | string | Sí | Apellido. |
| `phone` | string | Sí | Teléfono tal como se guardó. |
| `email` | string | Sí | Email en minúsculas. |

### `ReservationRequest`

Respuesta de todas las rutas de `/reservation-requests`.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id de la solicitud. |
| `code` | string | No | `RES-<año>-<secuencia>`. Único; lo genera el backend. |
| `customerId` | `Uuid` | No | Cliente. Editable. |
| `commercialItemId` | `Uuid` | Sí | Elemento comercial. |
| `sourceChannel` | `ContactChannel` | No | Canal por el que llegó la solicitud; no se hereda del cliente. |
| `reservationAt` | `IsoDateTime` | Sí | Fecha y hora pedidas. |
| `numberOfPeople` | number | Sí | Personas (≥ 1). |
| `quotedPrice` | `MoneyString` | Sí | Precio cotizado, con 2 decimales. Hay precio si y solo si hay `currency`. |
| `currency` | `CurrencyCode` | Sí | Moneda del precio. |
| `comments` | string | Sí | Comentarios (1–5000). |
| `specialRequirements` | string | Sí | Requerimientos especiales (1–5000). |
| `status` | `ReservationRequestStatus` | No | Estado (ver abajo). |
| `createdAt` | `IsoDateTime` | No | Alta; ordena el listado. |
| `updatedAt` | `IsoDateTime` | No | Última modificación. |
| `customer` | `CustomerSummary` | No | Resumen del cliente. |
| `commercialItem` | `CommercialItemSummary` | Sí | Resumen del elemento, o `null`. |

### `Reservation`

Respuesta de `GET /reservations` y de las escrituras de reservas, salvo las observaciones.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `assignedUserId` | `Uuid` | Sí | Responsable. |
| `assignedUser` | `AssignedUser` | Sí | Datos del responsable, o `null`. |
| `id` | `Uuid` | No | Id de la reserva. |
| `code` | string | No | `R-<año>-<secuencia>`. Único; no cambia nunca. |
| `reservationRequestId` | `Uuid` | Sí | Solicitud de origen. Siempre `null` con las rutas actuales. |
| `customerId` | `Uuid` | No | Cliente. |
| `commercialItemId` | `Uuid` | Sí | Elemento comercial. |
| `reservationAt` | `IsoDateTime` | No | Fecha y hora de la reserva; ordena el calendario. |
| `numberOfPeople` | number | No | Personas (≥ 1). |
| `status` | `ReservationStatus` | No | Estado (ver abajo). |
| `notes` | string | Sí | Texto general editable (1–5000). Distinto de `noteHistory`. |
| `createdAt` | `IsoDateTime` | No | Alta. |
| `updatedAt` | `IsoDateTime` | No | Última modificación. Agregar una observación no lo cambia. |
| `customer` | `CustomerSummary` | No | Resumen del cliente. |
| `commercialItem` | `CommercialItemSummary` | Sí | Resumen del elemento, o `null`. |

### `AssignedUser`

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del usuario. |
| `firstName` | string | No | Nombre. |
| `lastName` | string | No | Apellido. |
| `isActive` | boolean | No | Si el usuario está activo. |
| `isEligible` | boolean | No | Se calcula en cada lectura: activo y con ADMIN u OPERATOR. |

### `ReservationDetail`

Respuesta de `GET /reservations/:id`: `Reservation` más `noteHistory: ReservationNote[]` y `rescheduleHistory: ReservationRescheduleEntry[]`, ambos por `createdAt` ascendente y luego por `id`, sin paginar.

### `ReservationNote`

Respuesta de `POST /reservations/:id/notes` y elementos de `noteHistory`.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id de la observación. |
| `reservationId` | `Uuid` | No | Reserva. |
| `authorUserId` | `Uuid` | No | Autor (el usuario del token). |
| `content` | string | No | Texto (1–5000, con trim). |
| `createdAt` | `IsoDateTime` | No | Hora de creación. |
| `author` | `PublicUser` | No | `{ id, firstName, lastName }` del autor. |

### `ReservationRescheduleEntry`

Elementos de `rescheduleHistory`. No trae `reservationId`.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id de la entrada. |
| `previousReservationAt` | `IsoDateTime` | No | Fecha anterior. |
| `newReservationAt` | `IsoDateTime` | No | Fecha nueva (siempre distinta de la anterior). |
| `reason` | string | Sí | Motivo. `null` si la fecha se cambió con `PATCH /reservations/:id` o sin motivo. |
| `changedByUserId` | `Uuid` | No | Quién reprogramó (el usuario del token). |
| `createdAt` | `IsoDateTime` | No | Hora del cambio. |
| `changedBy` | `PublicUser` | No | `{ id, firstName, lastName }` de quien reprogramó. |

### `Paginated<T>`

`{ data: T[], pagination: { page, limit, total, totalPages } }`. `page` y `limit` repiten los valores usados; `totalPages` es `Math.ceil(total / limit)` y vale 0 si no hay resultados. Ver [Paginación y orden](README.md#paginación-y-orden).

## Estados y transiciones

### Estado del cliente (`CustomerStatus`)

| Valor | Etiqueta en ft-crm | Cómo se llega |
|---|---|---|
| `NEW` | Nuevo | Al crear el cliente, a mano o con su primer mensaje de WhatsApp o Messenger. |
| `INTERESTED` | Interesado | Solo con `PATCH /customers/:id/status`. |
| `IN_CONVERSATION` | En conversación | Solo con `PATCH /customers/:id/status`. |
| `REQUESTED_RESERVATION` | Solicitó reserva | Solo con `PATCH /customers/:id/status`. |
| `CONFIRMED` | Confirmado | Solo con `PATCH /customers/:id/status`. |
| `REJECTED` | Rechazado | Solo con `PATCH /customers/:id/status`. |
| `LOST` | Perdido | Solo con `PATCH /customers/:id/status`. |
| `RECURRENT` | Recurrente | Solo con `PATCH /customers/:id/status`. |

- Transiciones: de cualquier estado a cualquier otro, incluido el mismo, con `PATCH /customers/:id/status` (ADMIN, OPERATOR). No hay transición prohibida ni error de transición.
- Automáticas: ninguna. Mensajes, intereses, solicitudes y reservas no cambian el estado. El código tiene pendiente integrar `REQUESTED_RESERVATION` y `CONFIRMED` con las reservas.
- Un valor fuera del enum responde 400 `status must be one of the following values: NEW, INTERESTED, IN_CONVERSATION, REQUESTED_RESERVATION, CONFIRMED, REJECTED, LOST, RECURRENT`.

### Estado de la solicitud (`ReservationRequestStatus`)

| Valor | Etiqueta en ft-crm | Significado hoy |
|---|---|---|
| `INCOMPLETE_DATA` | Negociando | Automático: falta `reservationAt` o `numberOfPeople`. |
| `READY_TO_SEND` | Lista para enviar | Automático: hay `reservationAt` y `numberOfPeople`. |
| `SENT_TO_OWNER` | Enviada al dueño | Reservado para el flujo del dueño. Ninguna ruta lo asigna. |
| `WAITING_RESPONSE` | Esperando al dueño | Igual: ninguna ruta lo asigna. |
| `ACCEPTED` | Aceptada | Igual: ninguna ruta lo asigna. |
| `REJECTED` | Rechazada | Igual: ninguna ruta lo asigna. |
| `MODIFICATION_REQUESTED` | Cambios solicitados | Igual: ninguna ruta lo asigna. |
| `RENEGOTIATING` | Renegociando | Igual: ninguna ruta lo asigna. |
| `CANCELLED` | Cancelada | Manual y final. |

| Desde | Hacia | Cómo | Roles |
|---|---|---|---|
| (alta) | `INCOMPLETE_DATA` o `READY_TO_SEND` | `POST /reservation-requests`; lo calcula el backend | ADMIN, OPERATOR |
| `INCOMPLETE_DATA` | `READY_TO_SEND` | `PATCH /reservation-requests/:id` que deja fecha y personas | ADMIN, OPERATOR |
| `READY_TO_SEND` | `INCOMPLETE_DATA` | `PATCH /reservation-requests/:id` con `reservationAt: null` o `numberOfPeople: null` | ADMIN, OPERATOR |
| `INCOMPLETE_DATA`, `READY_TO_SEND` | `CANCELLED` | `PATCH /reservation-requests/:id/status` con `{ "status": "CANCELLED" }` | ADMIN, OPERATOR |
| `CANCELLED` | `CANCELLED` | La misma ruta: 200 sin cambios | ADMIN, OPERATOR |

Errores de una transición no permitida:
- Editar o cancelar fuera de `INCOMPLETE_DATA` y `READY_TO_SEND` (salvo cancelar una ya cancelada): 409 `La solicitud no admite modificaciones en su estado actual`.
- Pedir otro estado en `PATCH /reservation-requests/:id/status`: 400 `status must be one of the following values: CANCELLED`.

### Estado de la reserva (`ReservationStatus`)

| Valor | Etiqueta en ft-crm | Significado |
|---|---|---|
| `CONFIRMED` | Confirmada | Estado inicial de toda reserva. |
| `UPCOMING` | Preparada | Manual (`PREPARED_STATUS` en ft-crm). |
| `IN_SERVICE` | En servicio | Manual; exige que haya llegado la hora. |
| `COMPLETED` | Completada | Final; solo desde `IN_SERVICE`. |
| `RESCHEDULED` | Reprogramada | Automático al cambiar `reservationAt`; no se puede pedir. |
| `CANCELLED` | Cancelada | Final. |
| `NO_SHOW` | No asistió | Final; exige que haya llegado la hora. |

Transiciones con `PATCH /reservations/:id/status` (ADMIN, OPERATOR):

| Desde | Hacia |
|---|---|
| `CONFIRMED` | `UPCOMING`, `IN_SERVICE`\*, `CANCELLED`, `NO_SHOW`\* |
| `UPCOMING` | `IN_SERVICE`\*, `CANCELLED`, `NO_SHOW`\* |
| `RESCHEDULED` | `CONFIRMED`, `UPCOMING`, `IN_SERVICE`\*, `CANCELLED`, `NO_SHOW`\* |
| `IN_SERVICE` | `COMPLETED` |
| `COMPLETED`, `CANCELLED`, `NO_SHOW` | Ninguno |

\* Solo si `reservationAt <= ahora`, según el reloj del servidor y sin tolerancia. Enviar el estado actual responde 200 sin cambios, también en los estados finales.

Transición automática: `CONFIRMED`, `UPCOMING` o `RESCHEDULED` → `RESCHEDULED`, cuando `PATCH /reservations/:id` o `PATCH /reservations/:id/reschedule` cambian `reservationAt` a otro instante (ADMIN, OPERATOR). Ningún proceso cambia estados por la hora: una reserva pasada sigue en `CONFIRMED` hasta que alguien la marque.

Para volver de `UPCOMING` a `CONFIRMED` no hay transición directa (409). Reprogramar la pasa a `RESCHEDULED`, y desde ahí sí puede volver a `CONFIRMED`.

Qué permite cada estado:

| Estado | Editar (`PATCH /:id`) | Reprogramar | Responsable | Observaciones |
|---|---|---|---|---|
| `CONFIRMED`, `UPCOMING`, `RESCHEDULED` | Sí | Sí | Sí | Sí |
| `IN_SERVICE` | No | No | Sí | Sí |
| `COMPLETED`, `CANCELLED`, `NO_SHOW` | No | No | No | Sí |

Errores de una transición u operación no permitida:
- 409 `Transición de reserva no permitida`: el destino no está en la tabla.
- 409 `Todavía no ha llegado la hora de la reserva`: `IN_SERVICE` o `NO_SHOW` antes de `reservationAt`.
- 400 `status must be one of the following values: CONFIRMED, UPCOMING, IN_SERVICE, COMPLETED, CANCELLED, NO_SHOW`: se pidió `RESCHEDULED` u otro valor.
- 409 `La reserva no admite edición o reprogramación en su estado actual`: editar o reprogramar fuera de `CONFIRMED`, `UPCOMING` y `RESCHEDULED`.
- 409 `No se modifica el responsable de una reserva finalizada`: cambiar el responsable en `COMPLETED`, `CANCELLED` o `NO_SHOW`.

## Preguntas abiertas

1. La respuesta de clientes no expone la identidad de proveedor (`providerAccountId`/`externalContactId`). Por eso el frontend no sabe de antemano si un cliente `FACEBOOK` viene de Messenger (canal bloqueado y contacto opcional): solo lo descubre al recibir el 400 `No se puede cambiar el canal de una identidad de Messenger`. ¿Se añadirá un indicador, por ejemplo `hasProviderIdentity`?
2. `PATCH /customers/:id/status` acepta cualquier transición, y el estado del cliente no se sincroniza con solicitudes, reservas ni conversaciones (hay un TODO en `customers.service.ts`). ¿Qué flujo debe imponer la UI? Por ejemplo, ¿pasar a `REQUESTED_RESERVATION` al crear una solicitud?
3. No hay ruta para enviar una solicitud al dueño, aceptarla o convertirla en reserva: `reservationRequestId` siempre es `null` y los estados `SENT_TO_OWNER`, `WAITING_RESPONSE`, `ACCEPTED`, `REJECTED`, `MODIFICATION_REQUESTED` y `RENEGOTIATING` no se alcanzan. Samanta tampoco crea solicitudes. ¿Deben aparecer ya en los filtros y KPI de la UI? ¿Cuándo llega el flujo de aprobación?
4. `GET /reservations` devuelve como máximo 100 reservas por página y no tiene filtro de reservas sin responsable. ¿El calendario necesita un modo sin paginación o un filtro tipo `unassigned`?
5. Los mensajes de validación (400) llegan en inglés y como arreglo, y los de negocio en español como texto. ¿El frontend debe traducir los de validación, o el backend los personalizará?
6. No existe fusión de clientes: si un cliente (también uno de Messenger) recibe un teléfono o email que ya es de otro, la respuesta es 409 `Ya existe un cliente con ese teléfono o correo`. ¿Se planea un flujo de fusión o de vinculación de identidades?
7. Cambiar el teléfono de un cliente con conversación de WhatsApp cambia el destinatario de las respuestas; y si el número anterior vuelve a escribir, el backend crea otro cliente. ¿Es el comportamiento deseado, o `PATCH /customers/:id` debería impedirlo o advertirlo?
8. Ningún POST del módulo admite `Idempotency-Key`: un reintento tras un 504 del BFF duplica solicitudes, reservas y observaciones. ¿Se añadirá idempotencia a esas rutas?
9. Las búsquedas no admiten el nombre completo («Carlos Quispe»), las de solicitudes y reservas no buscan por email, y cualquier dígito del texto se busca en los teléfonos. ¿Se mejorará la búsqueda?
10. `GET /customers` no trae el número de reservas ni el último interés, y ft-crm hace dos llamadas por fila para mostrarlos. ¿Se añadirán esos campos al listado?
11. `PATCH /customers/:id/status` responde 404 `Cliente o interés no encontrado` y el resto de rutas de clientes `Cliente no encontrado`. ¿Se unificará el texto?
12. `GET /reservation-requests` solo filtra por `reservationAt`: no hay filtro por fecha de alta (`createdAt`). Estadísticas cuenta hoy las solicitudes por fecha de reserva y omite las que no tienen fecha. ¿Es el criterio deseado, o hace falta un filtro por `createdAt`?

## Tipos TypeScript

Bloque autocontenido: compila con `tsc --noEmit --strict --target es2022 --lib es2022,dom --module esnext --moduleResolution bundler`.
- Los tipos compartidos (`Uuid`, `IsoDateTime`, `Paginated<T>`…) repiten la definición de `ft-crm/src/lib/api/types.ts`. `ApiErrorBody` usa la forma ampliada de [05](05-implementacion-ft-crm.md#22-typests): `code?: BffErrorCode` y los campos del 500 (`path`, `method`, `timestamp`). En el frontend, decláralos una sola vez.
- Los tipos que ft-crm ya tiene (`Customer`, `ReservationRequest`, `Reservation`, `ReservationDetail`…) coinciden con el backend.
- Los nuevos siguen el estilo de cada familia: `…Request` en clientes (como `UpdateCustomerStatusRequest`) y `…Body` en solicitudes y reservas (como `CancelReservationRequestBody`).

```ts
/**
 * bk-crm · Clientes, solicitudes de reserva y reservas (calendario). Estado: 3/11/2026.
 * Forma real de las respuestas: select de Prisma y mapeos de los servicios.
 * Los tipos compartidos repiten la definición de ft-crm/src/lib/api/types.ts.
 */

/* ================================ Comunes ================================ */

export type Uuid = string;

/**
 * Instante ISO 8601.
 * - Respuestas: UTC con milisegundos ("2026-11-08T01:00:00.000Z").
 * - Envío (body y query): con segundos y zona explícita (Z o ±HH:mm), hasta 3 decimales.
 *   toISOString() sirve. Sin zona, sin segundos o solo con la fecha → 400.
 */
export type IsoDateTime = string;

/** Importe en texto: de "0" a "99999999.99", hasta 2 decimales. La API lo devuelve con 2 ("150.00"). */
export type MoneyString = string;

export type RoleCode = "ADMIN" | "OWNER" | "OPERATOR" | "SUPPORT";

export const CONTACT_CHANNELS = ["WHATSAPP", "FACEBOOK", "INSTAGRAM", "WEBSITE", "PHONE", "EMAIL", "OTHER"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export type CurrencyCode = "PEN" | "USD";

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  /** 0 cuando total = 0 */
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  pagination: Pagination;
}

/** Límite máximo de `limit` en todos los listados paginados. */
export const MAX_PAGE_SIZE = 100;

/** `code` que añade el BFF de este frontend; bk-crm nunca lo envía. */
export type BffErrorCode = "NO_SESSION" | "SESSION_EXPIRED" | "BACKEND_UNAVAILABLE";

/** Cuerpo de error NestJS: `message` es string (negocio) o string[] (validación). */
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  /** "Bad Request"… No llega en los errores del BFF ni en el 500. */
  error?: string;
  /** Solo lo agrega el BFF de este frontend. */
  code?: BffErrorCode;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  path?: string;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  method?: string;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  timestamp?: IsoDateTime;
}

/** Error 500 del filtro global de bk-crm: no expone detalles internos. */
export interface InternalErrorResponse {
  statusCode: 500;
  message: "Ocurrió un error interno";
  path: string;
  method: string;
  timestamp: IsoDateTime;
}

export const COMMERCIAL_ITEM_TYPES = ["DISH", "BEVERAGE", "SERVICE", "PROMOTION", "EVENT"] as const;
export type CommercialItemType = (typeof COMMERCIAL_ITEM_TYPES)[number];
export type CommercialApprovalStatus = "DRAFT" | "APPROVED" | "REJECTED";

/** Embebido compacto en solicitudes, reservas e intereses (sin precio). Es el estado actual del catálogo. */
export interface CommercialItemSummary {
  id: Uuid;
  /** Al menos uno de los dos nombres tiene valor. */
  nameEs: string | null;
  nameEn: string | null;
  type: CommercialItemType;
  isActive: boolean;
  approvalStatus: CommercialApprovalStatus;
}

/* ================================ Clientes ================================ */

export const CUSTOMER_STATUSES = [
  "NEW",
  "INTERESTED",
  "IN_CONVERSATION",
  "REQUESTED_RESERVATION",
  "CONFIRMED",
  "REJECTED",
  "LOST",
  "RECURRENT",
] as const;
/** Estado comercial. El backend no valida transiciones ni lo cambia solo. */
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export interface Customer {
  id: Uuid;
  /** Messenger: nombre completo que da Meta (o null). WhatsApp: null hasta que alguien lo edite. */
  firstName: string | null;
  lastName: string | null;
  /** Tal como se escribió (con trim). WhatsApp: "+51912345678". La forma E.164 no se expone. */
  phone: string | null;
  /** ISO 3166-1 alfa-2 en mayúsculas ("PE"); null si no se indicó o se borró el teléfono. */
  phoneCountry: string | null;
  /** En minúsculas. */
  email: string | null;
  /** Canal de origen. Los webhooks crean WHATSAPP o FACEBOOK. */
  sourceChannel: ContactChannel;
  /** Nace en NEW; solo cambia con PATCH /customers/:id/status. */
  status: CustomerStatus;
  firstContactAt: IsoDateTime;
  /** Mensajes entrantes e intereses registrados. Nunca retrocede. */
  lastContactAt: IsoDateTime;
  notes: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CustomerInterest {
  id: Uuid;
  firstInterestedAt: IsoDateTime;
  /** Se mueve a la hora actual cada vez que se repite el POST. */
  lastInterestedAt: IsoDateTime;
  notes: string | null;
  commercialItem: CommercialItemSummary;
}

export interface CustomerDetail extends Customer {
  /** Ordenados por lastInterestedAt descendente y luego por id ascendente. */
  interests: CustomerInterest[];
}

/** Cliente embebido en solicitudes, reservas y conversaciones. */
export interface CustomerSummary {
  id: Uuid;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
}

/** Query de GET /customers. No envíes textos vacíos ni parámetros extra (400). */
export interface CustomerListQuery {
  /** 1–1 000 000; por defecto 1. */
  page?: number;
  /** 1–100; por defecto 20. */
  limit?: number;
  /** 1–200 tras el trim. Busca en nombre, apellido, teléfono o correo por separado (no el nombre completo). */
  search?: string;
  status?: CustomerStatus;
  /** Filtra sourceChannel (el parámetro se llama `channel`). */
  channel?: ContactChannel;
  /** Clientes con un interés en ese elemento. */
  commercialItemId?: Uuid;
}

/** Body de POST /customers. Exige un email o un teléfono normalizable. */
export interface CreateCustomerRequest {
  sourceChannel: ContactChannel;
  /** 1–100 tras el trim. */
  firstName?: string | null;
  /** 1–100 tras el trim. */
  lastName?: string | null;
  /** Internacional con "+", o nacional con phoneCountry; sin país no se normaliza y solo se acepta si hay email. 6–15 dígitos; máx. 80 caracteres. */
  phone?: string | null;
  /** ISO alfa-2 ("PE"); exige phone. */
  phoneCountry?: string | null;
  /** Máx. 320; se guarda en minúsculas. */
  email?: string | null;
  /** 1–5000 tras el trim. */
  notes?: string | null;
}

/** Body de PATCH /customers/:id. Omitir = conservar; null = borrar. Al menos un campo. */
export interface UpdateCustomerRequest {
  /** No admite null. En una identidad de Messenger solo se acepta "FACEBOOK". */
  sourceChannel?: ContactChannel;
  firstName?: string | null;
  lastName?: string | null;
  /** Con un número nacional, reenvía también phoneCountry (no se hereda). null borra también el país. */
  phone?: string | null;
  phoneCountry?: string | null;
  email?: string | null;
  notes?: string | null;
}

/** Body de PATCH /customers/:id/status. Cualquier estado, sin reglas de transición. */
export interface UpdateCustomerStatusRequest {
  status: CustomerStatus;
}

/** Body de POST /customers/:id/interests (crea o actualiza el interés). */
export interface CreateCustomerInterestRequest {
  /** Puede estar inactivo o sin aprobar. */
  commercialItemId: Uuid;
  /** 1–5000 tras el trim. Si el interés ya existe: omitir conserva la nota; null la borra. */
  notes?: string | null;
}

/* ========================= Solicitudes de reserva ========================= */

export const RESERVATION_REQUEST_STATUSES = [
  "INCOMPLETE_DATA",
  "READY_TO_SEND",
  "SENT_TO_OWNER",
  "WAITING_RESPONSE",
  "ACCEPTED",
  "REJECTED",
  "MODIFICATION_REQUESTED",
  "RENEGOTIATING",
  "CANCELLED",
] as const;
/** Hoy solo se alcanzan INCOMPLETE_DATA y READY_TO_SEND (calculados) y CANCELLED (manual). */
export type ReservationRequestStatus = (typeof RESERVATION_REQUEST_STATUSES)[number];

/** Estados en los que la solicitud admite edición y cancelación. */
export const RESERVATION_REQUEST_EDITABLE_STATUSES: readonly ReservationRequestStatus[] = [
  "INCOMPLETE_DATA",
  "READY_TO_SEND",
];

export interface ReservationRequest {
  id: Uuid;
  /** "RES-<año>-<secuencia>", p. ej. "RES-2026-000042". */
  code: string;
  customerId: Uuid;
  commercialItemId: Uuid | null;
  sourceChannel: ContactChannel;
  /** null mientras falta la fecha. */
  reservationAt: IsoDateTime | null;
  numberOfPeople: number | null;
  /** Presente si y solo si currency también lo está. */
  quotedPrice: MoneyString | null;
  currency: CurrencyCode | null;
  comments: string | null;
  specialRequirements: string | null;
  /** Lo calcula el backend: READY_TO_SEND si hay reservationAt y numberOfPeople. */
  status: ReservationRequestStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  customer: CustomerSummary;
  commercialItem: CommercialItemSummary | null;
}

/** Query de GET /reservation-requests. Rango: dateFrom <= reservationAt < dateTo. */
export interface ReservationRequestListQuery {
  page?: number;
  limit?: number;
  customerId?: Uuid;
  /** Filtra reservationAt >= dateFrom. */
  dateFrom?: IsoDateTime;
  /** Filtra reservationAt < dateTo. */
  dateTo?: IsoDateTime;
  /** Un solo estado. */
  status?: ReservationRequestStatus;
  /** Filtra el sourceChannel de la solicitud. */
  channel?: ContactChannel;
  commercialItemId?: Uuid;
  /** Busca en el código y en el nombre, apellido o teléfono del cliente (no en el email). */
  search?: string;
}

/** Body de POST /reservation-requests. */
export interface CreateReservationRequestBody {
  customerId: Uuid;
  sourceChannel: ContactChannel;
  /** Activo y APPROVED. */
  commercialItemId?: Uuid | null;
  /** Estrictamente futura. */
  reservationAt?: IsoDateTime | null;
  /** Entero >= 1 (número JSON, no texto). */
  numberOfPeople?: number | null;
  quotedPrice?: MoneyString | null;
  /** Solo junto con quotedPrice; si hay precio y se omite, se usa la moneda del restaurante. */
  currency?: CurrencyCode | null;
  comments?: string | null;
  specialRequirements?: string | null;
}

/** Body de PATCH /reservation-requests/:id. Omitir = conservar; null = borrar. Al menos un campo. */
export interface UpdateReservationRequestBody {
  /** No admite null. */
  customerId?: Uuid;
  /** No admite null. */
  sourceChannel?: ContactChannel;
  commercialItemId?: Uuid | null;
  /** Si llega, tiene que ser futura aunque no cambie. */
  reservationAt?: IsoDateTime | null;
  numberOfPeople?: number | null;
  /** null borra el precio y, si no se envía currency, también la moneda. */
  quotedPrice?: MoneyString | null;
  currency?: CurrencyCode | null;
  comments?: string | null;
  specialRequirements?: string | null;
}

/** Body de PATCH /reservation-requests/:id/status (solo permite cancelar). */
export interface CancelReservationRequestBody {
  status: "CANCELLED";
}

/* ========================== Reservas (calendario) ========================== */

export const RESERVATION_STATUSES = [
  "CONFIRMED",
  "UPCOMING",
  "IN_SERVICE",
  "COMPLETED",
  "RESCHEDULED",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
/** Valores que acepta PATCH /reservations/:id/status (RESCHEDULED lo pone el backend). */
export type ReservationStatusTarget = Exclude<ReservationStatus, "RESCHEDULED">;

/** Transiciones permitidas por PATCH /reservations/:id/status (reservation-rules.ts). */
export const RESERVATION_STATUS_TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatusTarget[]>> = {
  CONFIRMED: ["UPCOMING", "IN_SERVICE", "CANCELLED", "NO_SHOW"],
  UPCOMING: ["IN_SERVICE", "CANCELLED", "NO_SHOW"],
  RESCHEDULED: ["CONFIRMED", "UPCOMING", "IN_SERVICE", "CANCELLED", "NO_SHOW"],
  IN_SERVICE: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/** Destinos que además exigen reservationAt <= ahora (reloj del servidor); si no, 409. */
export const RESERVATION_STATUSES_REQUIRING_ARRIVAL: readonly ReservationStatusTarget[] = ["IN_SERVICE", "NO_SHOW"];

/** Estados que admiten PATCH /reservations/:id y PATCH /reservations/:id/reschedule. */
export const RESERVATION_EDITABLE_STATUSES: readonly ReservationStatus[] = ["CONFIRMED", "UPCOMING", "RESCHEDULED"];

/** Estados que admiten PATCH /reservations/:id/assignee. */
export const RESERVATION_ASSIGNABLE_STATUSES: readonly ReservationStatus[] = [
  "CONFIRMED",
  "UPCOMING",
  "RESCHEDULED",
  "IN_SERVICE",
];

/** Estados finales: no admiten cambio de estado, edición, reprogramación ni responsable. Sí observaciones. */
export const RESERVATION_FINAL_STATUSES: readonly ReservationStatus[] = ["COMPLETED", "CANCELLED", "NO_SHOW"];

/** true si PATCH /reservations/:id/status aceptaría `target` ahora (el mismo estado siempre responde 200). */
export function canSetReservationStatus(
  reservation: Pick<Reservation, "status" | "reservationAt">,
  target: ReservationStatusTarget,
  now: Date = new Date(),
): boolean {
  if (reservation.status === target) return true;
  if (!RESERVATION_STATUS_TRANSITIONS[reservation.status].includes(target)) return false;
  return !RESERVATION_STATUSES_REQUIRING_ARRIVAL.includes(target) || Date.parse(reservation.reservationAt) <= now.getTime();
}

/** Responsable de la reserva. */
export interface AssignedUser {
  id: Uuid;
  firstName: string;
  lastName: string;
  isActive: boolean;
  /** Se calcula en cada lectura: activo y con ADMIN u OPERATOR. */
  isEligible: boolean;
}

export interface Reservation {
  assignedUserId: Uuid | null;
  assignedUser: AssignedUser | null;
  id: Uuid;
  /** "R-<año>-<secuencia>", p. ej. "R-2026-000015". No cambia al reprogramar. */
  code: string;
  /** Siempre null con las rutas actuales. */
  reservationRequestId: Uuid | null;
  customerId: Uuid;
  commercialItemId: Uuid | null;
  reservationAt: IsoDateTime;
  numberOfPeople: number;
  status: ReservationStatus;
  /** Texto general editable (distinto de noteHistory). */
  notes: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  customer: CustomerSummary;
  commercialItem: CommercialItemSummary | null;
}

export interface PublicUser {
  id: Uuid;
  firstName: string;
  lastName: string;
}

/** Observación con autor (respuesta de POST /reservations/:id/notes). */
export interface ReservationNote {
  id: Uuid;
  reservationId: Uuid;
  authorUserId: Uuid;
  content: string;
  createdAt: IsoDateTime;
  author: PublicUser;
}

/** Entrada del historial de reprogramaciones. */
export interface ReservationRescheduleEntry {
  id: Uuid;
  previousReservationAt: IsoDateTime;
  newReservationAt: IsoDateTime;
  /** null si la fecha se cambió con PATCH /reservations/:id o se reprogramó sin motivo. */
  reason: string | null;
  changedByUserId: Uuid;
  createdAt: IsoDateTime;
  changedBy: PublicUser;
}

/** GET /reservations/:id. Historiales por createdAt ascendente, sin paginar. */
export interface ReservationDetail extends Reservation {
  noteHistory: ReservationNote[];
  rescheduleHistory: ReservationRescheduleEntry[];
}

/** Query de GET /reservations. Rango: dateFrom <= reservationAt < dateTo. */
export interface ReservationListQuery {
  page?: number;
  limit?: number;
  customerId?: Uuid;
  /** Incluido: reservationAt >= dateFrom. */
  dateFrom?: IsoDateTime;
  /** Excluido: reservationAt < dateTo. */
  dateTo?: IsoDateTime;
  commercialItemId?: Uuid;
  assignedUserId?: Uuid;
  /** Busca en el código y en el nombre, apellido o teléfono del cliente (no en el email). */
  search?: string;
  /** Viaja como "true"/"false"; true no se combina con status "CANCELLED". */
  excludeCancelled?: boolean;
  /** Un solo estado, incluido RESCHEDULED. */
  status?: ReservationStatus;
}

/** Body de PATCH /reservations/:id/status. */
export interface UpdateReservationStatusBody {
  status: ReservationStatusTarget;
}

/** Body de POST /reservations (solo ADMIN). Siempre crea la reserva en CONFIRMED. */
export interface CreateReservationBody {
  customerId: Uuid;
  /** Estrictamente futura. */
  reservationAt: IsoDateTime;
  /** Entero >= 1. */
  numberOfPeople: number;
  /** Activo y APPROVED. */
  commercialItemId?: Uuid | null;
  notes?: string | null;
}

/** Body de PATCH /reservations/:id. Cambiar reservationAt deja la reserva en RESCHEDULED y agrega historial. */
export interface UpdateReservationBody {
  /** No admite null. */
  customerId?: Uuid;
  /** No admite null; si llega, tiene que ser futura aunque no cambie. */
  reservationAt?: IsoDateTime;
  /** No admite null. */
  numberOfPeople?: number;
  commercialItemId?: Uuid | null;
  notes?: string | null;
}

/** Body de PATCH /reservations/:id/assignee. null libera; la clave es obligatoria. */
export interface AssignReservationBody {
  assignedUserId: Uuid | null;
}

/** Body de POST /reservations/:id/notes. */
export interface CreateReservationNoteBody {
  /** 1–5000 tras el trim. */
  content: string;
}

/** Body de PATCH /reservations/:id/reschedule. */
export interface RescheduleReservationBody {
  /** Estrictamente futura. Si es el mismo instante, no hay cambios. */
  reservationAt: IsoDateTime;
  /** 1–5000 tras el trim. */
  reason?: string | null;
}

/* ============================== Mapa de rutas ============================== */

/** Código de éxito, parámetros, query, body y respuesta de cada ruta del módulo. */
export interface ClientesReservasRoutes {
  "POST /customers": { status: 201; body: CreateCustomerRequest; response: Customer };
  "GET /customers": { status: 200; query: CustomerListQuery; response: Paginated<Customer> };
  "GET /customers/:id": { status: 200; params: { id: Uuid }; response: CustomerDetail };
  "PATCH /customers/:id": { status: 200; params: { id: Uuid }; body: UpdateCustomerRequest; response: Customer };
  "PATCH /customers/:id/status": {
    status: 200;
    params: { id: Uuid };
    body: UpdateCustomerStatusRequest;
    response: Customer;
  };
  "POST /customers/:id/interests": {
    status: 200;
    params: { id: Uuid };
    body: CreateCustomerInterestRequest;
    response: CustomerInterest;
  };
  "DELETE /customers/:id/interests/:commercialItemId": {
    status: 204;
    params: { id: Uuid; commercialItemId: Uuid };
    response: void;
  };
  "POST /reservation-requests": { status: 201; body: CreateReservationRequestBody; response: ReservationRequest };
  "GET /reservation-requests": {
    status: 200;
    query: ReservationRequestListQuery;
    response: Paginated<ReservationRequest>;
  };
  "GET /reservation-requests/:id": { status: 200; params: { id: Uuid }; response: ReservationRequest };
  "PATCH /reservation-requests/:id": {
    status: 200;
    params: { id: Uuid };
    body: UpdateReservationRequestBody;
    response: ReservationRequest;
  };
  "PATCH /reservation-requests/:id/status": {
    status: 200;
    params: { id: Uuid };
    body: CancelReservationRequestBody;
    response: ReservationRequest;
  };
  "POST /reservations": { status: 201; body: CreateReservationBody; response: Reservation };
  "GET /reservations": { status: 200; query: ReservationListQuery; response: Paginated<Reservation> };
  "GET /reservations/:id": { status: 200; params: { id: Uuid }; response: ReservationDetail };
  "PATCH /reservations/:id": { status: 200; params: { id: Uuid }; body: UpdateReservationBody; response: Reservation };
  "PATCH /reservations/:id/status": {
    status: 200;
    params: { id: Uuid };
    body: UpdateReservationStatusBody;
    response: Reservation;
  };
  "PATCH /reservations/:id/assignee": {
    status: 200;
    params: { id: Uuid };
    body: AssignReservationBody;
    response: Reservation;
  };
  "POST /reservations/:id/notes": {
    status: 201;
    params: { id: Uuid };
    body: CreateReservationNoteBody;
    response: ReservationNote;
  };
  "PATCH /reservations/:id/reschedule": {
    status: 200;
    params: { id: Uuid };
    body: RescheduleReservationBody;
    response: Reservation;
  };
}
```
