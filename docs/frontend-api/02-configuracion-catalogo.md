# Configuración del restaurante y catálogo comercial

> Parte de la [referencia de la API de bk-crm para el frontend](README.md). Estado: 3 de noviembre de 2026.
>
> Desde el navegador, cada ruta se pide con `apiFetch` como `/api/backend<ruta>` y el BFF añade el token (ver [Arquitectura](README.md#arquitectura-navegador--bff--bk-crm)). Las convenciones comunes (formato de errores, sesión, roles, paginación, fechas e importes) están en el [README](README.md#convenciones-generales) y aquí no se repiten.

Este módulo gestiona la ficha global del restaurante (contacto, políticas, idiomas y horario semanal) y el catálogo comercial: categorías y elementos (platos, bebidas, servicios, promociones y eventos) con variantes, imágenes, FAQs, horarios y detalles de promoción o evento.

En ft-crm lo usan las pestañas de Ajustes (Empresa, Horarios, Políticas, Samanta y Servicios) y `useRestaurant()`, que da la zona horaria y la moneda a toda la app. El catálogo también alimenta a Samanta y a los elementos que se eligen en solicitudes, reservas e intereses de clientes.

**Reglas comunes a las 13 rutas**

- Todas exigen sesión. Leer: ADMIN, OWNER y OPERATOR. Escribir: solo ADMIN. SUPPORT recibe 403 en todas (ver [Roles](README.md#roles)).
- No usan cabeceras propias. El BFF añade `Authorization: Bearer` y `apiFetch` añade `Content-Type: application/json` cuando hay body. Sin ese `Content-Type`, el body no se interpreta y la respuesta es 400 como si faltaran todos los campos.
- No tienen límite de intentos (nunca responden 429) ni piden `Idempotency-Key`.
- El body admite hasta 100 kb; si se supera, 413. Solo un elemento comercial con muchas variantes, FAQs o textos largos puede acercarse a ese tamaño.
- Un `Content-Type` con un `charset` que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) responde 415 (con `charset=latin1`: `unsupported charset "LATIN1"`). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre.
- Los 401 de bk-crm (`Unauthorized`, `Token de acceso inválido`, `Usuario no autorizado`, `Sesión no válida o expirada`) no llegan al navegador. El BFF renueva la sesión y repite la llamada; si no puede, responde 401 `Tu sesión terminó. Vuelve a iniciar sesión.` (`code: "SESSION_EXPIRED"`). Sin cookies responde 401 `Inicia sesión para continuar.` (`code: "NO_SESSION"`). Ver [Sesión](README.md#sesión-srclibserversessionts).
- Si bk-crm no responde en 15 s (`CRM_BACKEND_TIMEOUT_MS`, valor por defecto), el BFF responde 504 `BACKEND_UNAVAILABLE`; si no hay conexión, 503 con el mismo `code` (ver [Errores que añade el BFF](README.md#errores-que-añade-el-bff)).
- Si la base de datos rechaza una restricción `CHECK`, Prisma 7 lo informa como `P2039`, ningún servicio lo traduce y la respuesta es 500 `Ocurrió un error interno`. Las validaciones previas lo evitan, salvo en los casos que indica cada ruta. Prisma 7 ya no emite `P2004`: los mensajes que los servicios reservan para ese código no llegan nunca.
- Los máximos de texto los cuenta class-validator, que toma un emoji con selector de variante (`❤️`) como 1 carácter; PostgreSQL lo cuenta como 2. Un texto al límite con esos emojis en una columna de largo fijo (nombres, `address`, `altTextEs`, `questionEs`…) no cabe y responde 500 (Prisma `P2000`, sin traducir). El `maxLength` del navegador y el `.max()` de zod cuentan unidades UTF-16 y lo evitan.
- Los textos se recortan (trim) antes de validar. Un texto opcional vacío o con solo espacios da 400: para borrarlo, envía `null`.
- Los UUID del body y de la query (`categoryId`, `approvalResponsibleId`) deben tener versión 1 a 8 y variante RFC (también pasan el nulo y el máximo); si no, `<campo> must be a UUID`. Los `:id` de la ruta aceptan cualquier 8-4-4-4-12 hexadecimal. Los ids que genera el backend (v4) cumplen ambas reglas.
- Importes: strings con hasta 2 decimales. La respuesta siempre trae 2 (`"25"` → `"25.00"`).
- Ninguna escritura guarda auditoría (quién cambió qué): está pendiente (`TODO`) en los servicios. Solo queda el `updatedAt` del recurso.
- Los ejemplos usan datos ficticios.

## Índice

- [Integración con ft-crm](#integración-con-ft-crm)
- [Obtener la configuración del restaurante](#obtener-la-configuración-del-restaurante) — `GET /restaurant-config`
- [Guardar la configuración del restaurante (crear o reemplazar)](#guardar-la-configuración-del-restaurante-crear-o-reemplazar) — `PUT /restaurant-config`
- [Crear categoría comercial](#crear-categoría-comercial) — `POST /commercial-categories`
- [Listar categorías comerciales](#listar-categorías-comerciales) — `GET /commercial-categories`
- [Ver detalle de una categoría comercial](#ver-detalle-de-una-categoría-comercial) — `GET /commercial-categories/:id`
- [Editar categoría comercial](#editar-categoría-comercial) — `PATCH /commercial-categories/:id`
- [Activar o desactivar una categoría comercial](#activar-o-desactivar-una-categoría-comercial) — `PATCH /commercial-categories/:id/status`
- [Crear elemento comercial](#crear-elemento-comercial) — `POST /commercial-items`
- [Listar elementos comerciales](#listar-elementos-comerciales) — `GET /commercial-items`
- [Ver detalle de un elemento comercial](#ver-detalle-de-un-elemento-comercial) — `GET /commercial-items/:id`
- [Editar elemento comercial](#editar-elemento-comercial) — `PATCH /commercial-items/:id`
- [Activar o desactivar un elemento comercial](#activar-o-desactivar-un-elemento-comercial) — `PATCH /commercial-items/:id/status`
- [Cambiar la aprobación de un elemento comercial](#cambiar-la-aprobación-de-un-elemento-comercial) — `PATCH /commercial-items/:id/approval`
- [Modelos](#modelos)
- [Estados y transiciones](#estados-y-transiciones)
- [Preguntas abiertas](#preguntas-abiertas)
- [Tipos TypeScript](#tipos-typescript)

## Integración con ft-crm

Funciones de `src/lib/api/endpoints.ts` y claves de `src/lib/api/query-keys.ts` para cada ruta:

| Ruta | Función | Estado | Caché |
|---|---|---|---|
| `GET /restaurant-config` | `configApi.get()` | existe | `qk.config` |
| `PUT /restaurant-config` | `configApi.put(body)` | existe | `setQueryData(qk.config, respuesta)` |
| `POST /commercial-categories` | `catalogApi.createCategory(body)` | nueva | invalida `qk.categories` |
| `GET /commercial-categories` | `catalogApi.categories()` | existe | `qk.categories` |
| `GET /commercial-categories/:id` | `catalogApi.category(id)` | nueva | `qk.category(id)` (nueva) |
| `PATCH /commercial-categories/:id` | `catalogApi.updateCategory(id, body)` | nueva | invalida `qk.categories` y `qk.itemsAll` |
| `PATCH /commercial-categories/:id/status` | `catalogApi.setCategoryActive(id, isActive)` | nueva | invalida `qk.categories` y `qk.itemsAll` |
| `POST /commercial-items` | `catalogApi.create(body)` | existe (ampliar su tipo de body) | invalida `qk.itemsAll` |
| `GET /commercial-items` | `catalogApi.items(query)` | existe | `qk.items(query)` |
| `GET /commercial-items/:id` | `catalogApi.item(id)` | nueva | `qk.item(id)` (nueva) |
| `PATCH /commercial-items/:id` | `catalogApi.update(id, body)` | nueva | `setQueryData(qk.item(id), respuesta)` e invalida `qk.itemsAll` |
| `PATCH /commercial-items/:id/status` | `catalogApi.setActive(id, isActive)` | existe | `setQueryData(qk.item(id), respuesta)` e invalida `qk.itemsAll` |
| `PATCH /commercial-items/:id/approval` | `catalogApi.setApproval(id, approvalStatus)` | existe | `setQueryData(qk.item(id), respuesta)` e invalida `qk.itemsAll` |

Propuesta para las funciones y claves que faltan, con el mismo estilo que el resto de `endpoints.ts` (los tipos están en [Tipos TypeScript](#tipos-typescript)):

```ts
// src/lib/api/endpoints.ts: se añaden a catalogApi
export const catalogApi = {
  // …funciones actuales: categories, items, create, setActive, setApproval
  category: (id: string) => apiFetch<CommercialCategory>(`/commercial-categories/${id}`),
  createCategory: (body: CreateCommercialCategoryRequest) =>
    apiFetch<CommercialCategory>("/commercial-categories", { method: "POST", body }),
  updateCategory: (id: string, body: UpdateCommercialCategoryRequest) =>
    apiFetch<CommercialCategory>(`/commercial-categories/${id}`, { method: "PATCH", body }),
  setCategoryActive: (id: string, isActive: boolean) =>
    apiFetch<CommercialCategory>(`/commercial-categories/${id}/status`, {
      method: "PATCH",
      body: { isActive } satisfies UpdateCommercialCategoryStatusRequest,
    }),
  item: (id: string) => apiFetch<CommercialItem>(`/commercial-items/${id}`),
  update: (id: string, body: UpdateCommercialItemRequest) =>
    apiFetch<CommercialItem>(`/commercial-items/${id}`, { method: "PATCH", body }),
};

// src/lib/api/query-keys.ts: claves nuevas
export const qk = {
  // …claves actuales
  category: (id: string) => ["commercial-categories", "detail", id] as const,
  item: (id: string) => ["commercial-items", "detail", id] as const,
};
```

- Las claves de detalle cuelgan de `qk.categories` y `qk.itemsAll`: invalidar esos prefijos también refresca los detalles.
- `qk.items(query)` no lleva el segmento `"list"`. El detalle usa `"detail"` para no confundirse con el objeto de query.
- El detalle de cliente (en `interests`), las solicitudes y las reservas traen un resumen `commercialItem` (`id`, `nameEs`, `nameEn`, `type`, `isActive`, `approvalStatus`). Si una pantalla lo muestra, después de editar, activar o aprobar un elemento invalida también `qk.customersAll`, `qk.requestsAll` y `qk.reservationsAll`.

## Obtener la configuración del restaurante
`GET /restaurant-config`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `RestaurantConfig` |
| ft-crm | `configApi.get(): Promise<RestaurantConfig>` — existe. La consulta vive en `useRestaurant()` (`src/lib/restaurant.tsx`) y la comparten todas las pestañas de Ajustes. |
| Caché | `qk.config` (`["restaurant-config"]`). |

No tiene parámetros de ruta, query ni body. Si se envía query, se ignora.

**Respuesta**

```json
{
  "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e",
  "businessName": "Fogón Andino",
  "logoUrl": "https://cdn.example.com/fogon-andino/logo.png",
  "description": "Cocina peruana y parrillas al carbón.",
  "address": "Calle Las Begonias 120, San Isidro, Lima",
  "latitude": -12.0951234,
  "longitude": -77.0345678,
  "whatsappNumber": "+51987654321",
  "ownerWhatsappNumber": "+51912345678",
  "email": "reservas@example.com",
  "website": "https://www.example.com",
  "currency": "PEN",
  "timeZone": "America/Lima",
  "reservationPolicy": "Las reservas están sujetas a disponibilidad.",
  "cancellationPolicy": "Las cancelaciones deben solicitarse con 2 horas de anticipación.",
  "responseTimeoutMinutes": 15,
  "approvalResponsibleId": "8d2f4b6a-0c1e-4a3b-9d5f-7e9a1b3c5d7f",
  "approvalResponsible": {
    "id": "8d2f4b6a-0c1e-4a3b-9d5f-7e9a1b3c5d7f",
    "firstName": "Rosa",
    "lastName": "Huamán",
    "email": "rosa.huaman@example.com"
  },
  "languages": ["ES", "EN"],
  "schedules": [
    { "dayOfWeek": "MONDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "TUESDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "WEDNESDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "THURSDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "FRIDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:30" },
    { "dayOfWeek": "SATURDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:30" },
    { "dayOfWeek": "SUNDAY", "isOpen": false, "openTime": null, "closeTime": null }
  ],
  "createdAt": "2026-09-02T15:10:42.117Z",
  "updatedAt": "2026-10-28T21:04:37.502Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OWNER ni OPERATOR (p. ej. solo SUPPORT). |
| 404 | `Configuración del restaurante no encontrada` | Aún no se guardó ninguna configuración con `PUT /restaurant-config`. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**
- Es un recurso único: no tiene `:id`, `POST` ni `DELETE`. Existe (200) o no existe (404).
- Un 404 significa «restaurante sin configurar», no un fallo. A ADMIN muéstrale el formulario inicial y a OWNER u OPERATOR un aviso. No reintentes un 404: `useRestaurant()` ya lo excluye del `retry`, y `ConfigGate` (`src/features/ajustes/config/config-ui.tsx`) distingue cargando, 404 y error.
- `timeZone` y `currency` sirven a toda la app. Muestra las fechas en esa zona, no en la del navegador (ver [Fechas](README.md#fechas-zona-horaria-e-importes)). Sin configuración, ft-crm usa `America/Lima` (`DEFAULT_TIME_ZONE`) y `PEN`.
- `languages` llega ordenado `ES`, `EN`, `PT`, y `schedules` de `MONDAY` a `SUNDAY`. Una configuración guardada por la API siempre tiene los 7 días.
- `latitude` y `longitude` son `number` o `null`, nunca strings.
- `approvalResponsible` solo trae `id`, `firstName`, `lastName` y `email`, y es `null` si no hay responsable. OWNER y OPERATOR solo pueden ver su nombre aquí, porque `GET /users` es solo para ADMIN.
- Sin configuración fallan otras rutas: crear solicitudes o reservas responde 409 `Configura el restaurante antes de crear solicitudes o reservas`, y generar un borrador de Samanta responde 409 `Configura el restaurante antes de usar Samanta`.
- Hoy ningún proceso del backend usa `logoUrl`, `website`, `latitude`, `longitude`, `whatsappNumber`, `email` ni `responseTimeoutMinutes`: se guardan y se devuelven solo para la UI. Desde el 10/11, el envío de solicitudes al propietario (M9.1) usa `ownerWhatsappNumber` y exige `approvalResponsibleId` (un usuario OWNER): sin los dos, no se envía nada.

## Guardar la configuración del restaurante (crear o reemplazar)
`PUT /restaurant-config`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `RestaurantConfig`, también la primera vez (nunca 201) |
| ft-crm | `configApi.put(body: PutRestaurantConfigRequest): Promise<RestaurantConfig>` — existe. La llama `useConfigSave()` (`src/features/ajustes/config/use-config-save.ts`): relee la configuración y arma el body con `toPutRequest()`. |
| Caché | `setQueryData(qk.config, respuesta)`: actualiza la zona horaria y la moneda de toda la app sin otro GET. |

**Body**

Es un reemplazo completo: cada PUT envía la configuración entera.

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `businessName` | string | Sí | Se recorta. De 1 a 150 caracteres. No admite `null`. |
| `logoUrl` | string \| null | No | Se recorta. URL con protocolo `http://` o `https://` obligatorio y un host con dominio de nivel superior (`https://cdn.example.com/logo.png`) o una IP. `localhost`, `ftp://` o sin protocolo dan 400. Máx. 2048. Omitido o `null` → se guarda `null`. `""` → 400. |
| `description` | string \| null | No | Se recorta. De 1 a 2000. Omitido o `null` → `null`. `""` o solo espacios → 400. |
| `address` | string | Sí | Se recorta. De 1 a 300. |
| `latitude` | number \| null | Junto con `longitude` | Número JSON (un string da 400), finito, con hasta 7 decimales, de −90 a 90. Si envías una coordenada, la otra es obligatoria. Las dos omitidas o `null` → sin coordenadas. |
| `longitude` | number \| null | Junto con `latitude` | Número JSON, finito, con hasta 7 decimales, de −180 a 180. |
| `whatsappNumber` | string | Sí | Se recorta. Formato E.164: `+`, un primer dígito de 1 a 9 y de 8 a 15 dígitos en total, sin espacios ni guiones (`^\+[1-9]\d{7,14}$`, p. ej. `+51987654321`). Máx. 16. |
| `ownerWhatsappNumber` | string \| null | No | Desde el 10/11 (M9.1). WhatsApp **personal** del propietario, adonde se le envían las solicitudes para aprobar. Mismo formato E.164 y distinto de `whatsappNumber`. **Si lo omites, se conserva el valor guardado** (a diferencia de los demás opcionales); `null` lo borra y deja de enviar solicitudes al propietario. |
| `email` | string | Sí | Se recorta y pasa a minúsculas antes de validar. Email válido. El DTO declara un máximo de 320, pero el validador rechaza más de 254 caracteres (o más de 64 antes de la `@`). |
| `website` | string \| null | No | Mismas reglas que `logoUrl`. |
| `currency` | `CurrencyCode` | Sí | `PEN` o `USD`, en mayúsculas. |
| `timeZone` | string | Sí | Se recorta. Zona IANA que acepte `Intl` (p. ej. `America/Lima` o `UTC`). Máx. 64. Se guarda tal como llega: `america/lima` también pasa y se guarda en minúsculas. |
| `reservationPolicy` | string | Sí | Se recorta. De 1 a 5000. |
| `cancellationPolicy` | string | Sí | Se recorta. De 1 a 5000. |
| `responseTimeoutMinutes` | integer | Sí | Entero de 1 a 1440 (minutos). Se convierte con `Number()`: `"15"` → 15; `""` y `null` dan 400. |
| `approvalResponsibleId` | `Uuid` \| null | No | UUID de un usuario existente, activo y con rol OWNER. Omitido o `null` → sin responsable. `""` → 400. |
| `languages` | `LanguageCode[]` | Sí | Array de 1 a 3 valores distintos: `ES`, `EN`, `PT` (en mayúsculas). El orden no importa: se devuelven como `ES`, `EN`, `PT`. |
| `schedules` | `RestaurantScheduleInput[]` | Sí | Exactamente 7 objetos, uno por día (`dayOfWeek` sin repetir). El orden no importa. |
| `schedules[].dayOfWeek` | `DayOfWeek` | Sí | `MONDAY` … `SUNDAY`. |
| `schedules[].isOpen` | boolean | Sí | Booleano JSON (`"true"` → 400). |
| `schedules[].openTime` | `HhMm` \| null | Si `isOpen` es `true` | `HH:mm` de 24 h (`00:00` a `23:59`), anterior a `closeTime`. No se recorta: `" 09:00"` da 400. Con `isOpen: false`, omítelo o envía `null`. |
| `schedules[].closeTime` | `HhMm` \| null | Si `isOpen` es `true` | `HH:mm`, posterior a `openTime`. No puede cruzar la medianoche y `24:00` no existe: el cierre más tardío es `23:59`. Con `isOpen: false`, omítelo o envía `null`. |
| Cualquier otro campo | — | Prohibido | 400 `property <campo> should not exist` (p. ej. `id`, `approvalResponsible`, `createdAt`, `updatedAt`). Dentro de un horario: `schedules.<i>.property <campo> should not exist`. |

**Ejemplo de petición**

La pestaña Políticas cambia solo la política de cancelación. `useConfigSave()` relee la configuración, aplica el cambio y envía el objeto completo:

```ts
const current = await configApi.get();
const body: PutRestaurantConfigRequest = {
  ...toPutRequest(current),
  cancellationPolicy: "Las cancelaciones deben solicitarse con 3 horas de anticipación.",
};
const saved = await configApi.put(body);
queryClient.setQueryData(qk.config, saved);
```

`PUT /api/backend/restaurant-config`:

```json
{
  "businessName": "Fogón Andino",
  "logoUrl": "https://cdn.example.com/fogon-andino/logo.png",
  "description": "Cocina peruana y parrillas al carbón.",
  "address": "Calle Las Begonias 120, San Isidro, Lima",
  "latitude": -12.0951234,
  "longitude": -77.0345678,
  "whatsappNumber": "+51987654321",
  "ownerWhatsappNumber": "+51912345678",
  "email": "reservas@example.com",
  "website": "https://www.example.com",
  "currency": "PEN",
  "timeZone": "America/Lima",
  "reservationPolicy": "Las reservas están sujetas a disponibilidad.",
  "cancellationPolicy": "Las cancelaciones deben solicitarse con 3 horas de anticipación.",
  "responseTimeoutMinutes": 15,
  "approvalResponsibleId": "8d2f4b6a-0c1e-4a3b-9d5f-7e9a1b3c5d7f",
  "languages": ["ES", "EN"],
  "schedules": [
    { "dayOfWeek": "MONDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "TUESDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "WEDNESDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "THURSDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "FRIDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:30" },
    { "dayOfWeek": "SATURDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:30" },
    { "dayOfWeek": "SUNDAY", "isOpen": false, "openTime": null, "closeTime": null }
  ]
}
```

La primera configuración (formulario inicial, `mode: "create"`) también es un PUT completo. ft-crm la envía con los 7 días cerrados, sin coordenadas y sin responsable. Un body mínimo válido puede omitir los opcionales:

```json
{
  "businessName": "Fogón Andino",
  "address": "Calle Las Begonias 120, San Isidro, Lima",
  "whatsappNumber": "+51987654321",
  "ownerWhatsappNumber": "+51912345678",
  "email": " Reservas@Example.com ",
  "currency": "PEN",
  "timeZone": "America/Lima",
  "reservationPolicy": "Las reservas están sujetas a disponibilidad.",
  "cancellationPolicy": "Las cancelaciones deben solicitarse con 2 horas de anticipación.",
  "responseTimeoutMinutes": "30",
  "languages": ["PT", "ES"],
  "schedules": [
    { "dayOfWeek": "SUNDAY", "isOpen": false },
    { "dayOfWeek": "MONDAY", "isOpen": false },
    { "dayOfWeek": "TUESDAY", "isOpen": false },
    { "dayOfWeek": "WEDNESDAY", "isOpen": false },
    { "dayOfWeek": "THURSDAY", "isOpen": false },
    { "dayOfWeek": "FRIDAY", "isOpen": false },
    { "dayOfWeek": "SATURDAY", "isOpen": false }
  ]
}
```

Con ese body se guarda `email: "reservas@example.com"`, `responseTimeoutMinutes: 30`, `languages: ["ES", "PT"]`, los días de lunes a domingo y `logoUrl`, `description`, `website`, las coordenadas y `approvalResponsibleId` en `null`.

**Respuesta**

La respuesta al ejemplo de la pestaña Políticas: lo guardado, con los textos recortados, el email en minúsculas y los idiomas y días ordenados.

```json
{
  "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e",
  "businessName": "Fogón Andino",
  "logoUrl": "https://cdn.example.com/fogon-andino/logo.png",
  "description": "Cocina peruana y parrillas al carbón.",
  "address": "Calle Las Begonias 120, San Isidro, Lima",
  "latitude": -12.0951234,
  "longitude": -77.0345678,
  "whatsappNumber": "+51987654321",
  "ownerWhatsappNumber": "+51912345678",
  "email": "reservas@example.com",
  "website": "https://www.example.com",
  "currency": "PEN",
  "timeZone": "America/Lima",
  "reservationPolicy": "Las reservas están sujetas a disponibilidad.",
  "cancellationPolicy": "Las cancelaciones deben solicitarse con 3 horas de anticipación.",
  "responseTimeoutMinutes": 15,
  "approvalResponsibleId": "8d2f4b6a-0c1e-4a3b-9d5f-7e9a1b3c5d7f",
  "approvalResponsible": {
    "id": "8d2f4b6a-0c1e-4a3b-9d5f-7e9a1b3c5d7f",
    "firstName": "Rosa",
    "lastName": "Huamán",
    "email": "rosa.huaman@example.com"
  },
  "languages": ["ES", "EN"],
  "schedules": [
    { "dayOfWeek": "MONDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "TUESDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "WEDNESDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "THURSDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:00" },
    { "dayOfWeek": "FRIDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:30" },
    { "dayOfWeek": "SATURDAY", "isOpen": true, "openTime": "11:00", "closeTime": "23:30" },
    { "dayOfWeek": "SUNDAY", "isOpen": false, "openTime": null, "closeTime": null }
  ],
  "createdAt": "2026-09-02T15:10:42.117Z",
  "updatedAt": "2026-11-03T16:42:08.215Z"
}
```

**Errores**

Los errores de validación llegan juntos en el array `message`; casi todos empiezan por el campo (`schedules.<i>.` en los horarios, donde `<i>` es la posición en el array). Las excepciones nombran el campo dentro del texto: `each value in languages …`, `All languages's elements must be unique` y `All schedules's elements must be unique`.

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` | Campo no declarado, p. ej. al reenviar el GET tal cual (`id`, `approvalResponsible`, `createdAt`, `updatedAt`). En un horario: `schedules.<i>.property <campo> should not exist`. |
| 400 | `businessName must be a string` · `businessName should not be empty` · `businessName must be shorter than or equal to 150 characters` | `businessName` falta, no es string, queda vacío al recortarlo o pasa de 150. |
| 400 | `logoUrl must be a URL address` · `logoUrl must be shorter than or equal to 2048 characters` | `logoUrl` es `""`, no usa `http(s)://`, no tiene dominio con extensión ni IP (p. ej. `localhost`) o pasa de 2048. |
| 400 | `website must be a URL address` · `website must be shorter than or equal to 2048 characters` | Lo mismo con `website`. |
| 400 | `description must be a string` · `description should not be empty` · `description must be shorter than or equal to 2000 characters` | `description` no es string, es `""` o solo espacios, o pasa de 2000. |
| 400 | `address must be a string` · `address should not be empty` · `address must be shorter than or equal to 300 characters` | `address` falta, no es string, queda vacío o pasa de 300. |
| 400 | `latitude must be a number conforming to the specified constraints` · `latitude must not be less than -90` · `latitude must not be greater than 90` | Se envió `longitude` sin `latitude` (salen los tres), o `latitude` es un string, tiene más de 7 decimales o está fuera de rango. |
| 400 | `longitude must be a number conforming to the specified constraints` · `longitude must not be less than -180` · `longitude must not be greater than 180` | Lo mismo con `longitude`. |
| 400 | `whatsappNumber must be a string` · `whatsappNumber debe usar formato internacional E.164` · `whatsappNumber must be shorter than or equal to 16 characters` | No es string o no cumple E.164 (espacios, guiones, sin `+`, longitud). |
| 400 | `ownerWhatsappNumber must be a string` · `ownerWhatsappNumber debe usar formato internacional E.164` · `ownerWhatsappNumber must be shorter than or equal to 16 characters` | Lo mismo con `ownerWhatsappNumber`. |
| 400 | `ownerWhatsappNumber debe ser distinto de whatsappNumber` | El número del propietario es el del negocio: el negocio no puede escribirse a sí mismo. |
| 400 | `email must be an email` · `email must be shorter than or equal to 320 characters` | Email inválido, también si pasa de 254 caracteres o de 64 antes de la `@`. |
| 400 | `currency must be one of the following values: PEN, USD` | Falta o tiene otro valor. |
| 400 | `timeZone must be a string` · `timeZone should not be empty` · `timeZone must be a valid IANA time-zone` · `timeZone must be shorter than or equal to 64 characters` | Falta, está vacía, `Intl` no la reconoce o pasa de 64. |
| 400 | `reservationPolicy must be a string` · `reservationPolicy should not be empty` · `reservationPolicy must be shorter than or equal to 5000 characters` | Falta, no es string, queda vacía o pasa de 5000. |
| 400 | `cancellationPolicy must be a string` · `cancellationPolicy should not be empty` · `cancellationPolicy must be shorter than or equal to 5000 characters` | Lo mismo con `cancellationPolicy`. |
| 400 | `responseTimeoutMinutes must be an integer number` · `responseTimeoutMinutes must not be less than 1` · `responseTimeoutMinutes must not be greater than 1440` | Falta, es `null` o `""`, no es entero o está fuera de 1 a 1440. |
| 400 | `approvalResponsibleId must be a UUID` | No es un UUID (también con `""`). |
| 400 | `languages must be an array` · `languages must contain at least 1 elements` · `languages must contain no more than 3 elements` · `All languages's elements must be unique` · `each value in languages must be one of the following values: ES, EN, PT` | Falta, no es un array, está vacío, tiene más de 3, repite un idioma o trae un valor distinto (también en minúsculas). |
| 400 | `schedules must be an array` · `schedules must contain at least 7 elements` · `schedules must contain no more than 7 elements` · `All schedules's elements must be unique` | Falta, no es un array, no tiene exactamente 7 elementos o repite un día. |
| 400 | `each value in nested property schedules must be either object or array` · `schedules.each value in nested property schedules must be either object or array` | `schedules` no es un array de objetos. El segundo mensaje sale cuando un elemento es `null` o un valor simple. |
| 400 | `schedules.<i>.dayOfWeek must be one of the following values: MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY` | Día inválido. |
| 400 | `schedules.<i>.isOpen must be a boolean value` | `isOpen` falta o no es un booleano JSON. |
| 400 | `schedules.<i>.Un día abierto requiere openTime y closeTime en formato HH:mm, con apertura anterior al cierre; un día cerrado no admite horas` | Día abierto sin horas, con horas iguales o con el cierre antes de la apertura (cruzar la medianoche), o día cerrado con horas. |
| 400 | `schedules.<i>.openTime must be a string` · `schedules.<i>.openTime debe tener el formato HH:mm` · `schedules.<i>.closeTime must be a string` · `schedules.<i>.closeTime debe tener el formato HH:mm` | Hora que no es string o no cumple `HH:mm` (p. ej. `9:00`, `24:00` o con espacios). Llega junto con el mensaje anterior. |
| 400 | `latitude y longitude deben proporcionarse juntas` · `schedules debe contener exactamente una entrada para cada día de la semana` · `Los horarios son incoherentes o cruzan la medianoche` | Comprobaciones de respaldo del servicio. Por HTTP no se ven: el DTO rechaza antes esos casos. |
| 400 | `El responsable de aprobación no existe` | `approvalResponsibleId` no corresponde a ningún usuario. |
| 400 | `El responsable de aprobación debe estar activo` | El usuario está desactivado. |
| 400 | `El responsable de aprobación debe tener el rol OWNER` | El usuario no tiene OWNER (tener solo ADMIN no basta). |
| 400 | `La configuración contiene referencias o valores inválidos` | Defensivo: solo con una clave foránea rota (Prisma P2003). El servicio comprueba antes el responsable en la misma transacción, y una restricción `CHECK` llega como 500, no aquí. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (OWNER, OPERATOR o SUPPORT). |
| 409 | `La configuración entró en conflicto con otro cambio; inténtalo nuevamente` | Otra escritura simultánea; el conflicto siguió tras 3 intentos. |
| 409 | `Ya existe una configuración global en conflicto` | Dos primeras creaciones simultáneas. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | Body de más de 100 kb. Una configuración válida ocupa mucho menos. |
| 500 | `Ocurrió un error interno` | `latitude` o `longitude` distinta de 0, con valor absoluto menor que 0,000001, que JavaScript escribe en notación exponencial sin punto decimal (`1e-7`, `-5e-8`): el validador de decimales falla. Con punto (`1.5e-7`) no falla: pasa la validación aunque tenga más de 7 decimales y se guarda en una columna `DECIMAL(10,7)`. |

**Efectos**
- La primera llamada crea la configuración. Las siguientes actualizan la misma fila: mismo `id` y mismo `createdAt`. `updatedAt` cambia en cada llamada, aunque el body sea idéntico.
- Borra y vuelve a crear los idiomas y los 7 horarios en la misma transacción serializable. Si algo falla, no se guarda nada.
- Desde la primera configuración se pueden crear solicitudes y reservas y usar Samanta; antes responden 409.
- `currency` es la moneda que el backend asigna cuando una solicitud recibe precio cotizado sin que se envíe `currency`: al crearla, o al editarla si aún no tenía moneda. `timeZone` fija el año de los códigos nuevos (`RES-2026-000042`, `R-2026-000007`). Los registros existentes no cambian.
- Samanta recibe `businessName`, `description`, `address`, `currency`, `timeZone`, las dos políticas, `languages` y `schedules`. Si cambias alguno de esos datos, los borradores pendientes quedan desactualizados: pasan a `STALE` al terminar de generarse, al editarlos o al aprobarlos (ver [Generar un borrador con Samanta](04-bandeja-samanta.md#generar-un-borrador-con-samanta)).

**Notas para el frontend**
- **Reemplazo total:** lo omitido o en `null` se guarda como `null`, y `languages` y `schedules` sustituyen a los anteriores. Para cambiar un dato, lee la configuración vigente, aplica el cambio y envía el objeto completo. `useConfigSave()` ya relee con `configApi.get()` justo antes del PUT para no pisar lo que otra pestaña guardó.
- No hay control de concurrencia (ni versión ni `If-Match`): si dos ADMIN guardan a la vez, gana el último.
- Nunca reenvíes el GET tal cual. `toPutRequest()` deja solo los 17 campos del body.
- Para borrar un opcional, envía `null` u omítelo. `""` da 400; el esquema zod de ft-crm ya convierte `""` en `null`.
- Un día abierto exige `openTime < closeTime` el mismo día: sin cruzar la medianoche, sin varias franjas y sin `24:00`. Para cerrar a medianoche usa `23:59`.
- Cada mensaje de validación nombra el campo, casi siempre al inicio (`each value in languages …`, `All languages's elements must be unique` y `All schedules's elements must be unique` lo nombran dentro). Como el PUT reenvía todo, el error puede venir de otra pestaña (p. ej. un responsable que dejó de ser OWNER). `backendMessageTabs()` (`config-schema.ts`) busca el nombre del campo en cualquier parte del mensaje y ya señala la pestaña.
- Selector de responsable: ofrece solo usuarios activos con OWNER, de `GET /users` (solo ADMIN; ver [Listar usuarios](01-auth-usuarios.md#listar-usuarios)). Si el responsable guardado deja de ser válido, cada PUT falla con 400 hasta que elijas otro o envíes `null`.
- `whatsappNumber`: quita espacios y guiones antes de enviar (`compactPhone()`).
- `timeZone`: envía el nombre canónico (`America/Lima`). El backend guarda lo que recibe y ft-crm compara con sus opciones exactas.
- Coordenadas: ft-crm no las edita. `toPutRequest()` las conserva y las redondea con `normalizeCoordinate()`, que también evita el 500 de los valores menores que 0,000001.
- La respuesta trae lo guardado. Úsala con `setQueryData` en lugar de otro GET.
- Mantén breves los textos que lee Samanta: si la información comercial (configuración y catálogo) supera 32 000 bytes, generar borradores responde 409 `Contexto comercial demasiado extenso; requiere revisión manual`.

## Crear categoría comercial
`POST /commercial-categories`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 201 · `CommercialCategory` |
| ft-crm | `catalogApi.createCategory(body: CreateCommercialCategoryRequest): Promise<CommercialCategory>` — nueva. Hoy no hay pantalla que cree categorías. |
| Caché | Invalida `qk.categories`. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `nameEs` | string \| null | `nameEs` o `nameEn` | Se recorta. De 1 a 150 caracteres (`""` o solo espacios → 400). Hay que enviar al menos uno de los dos nombres con texto. Único entre todas las categorías (ver Notas). |
| `nameEn` | string \| null | `nameEs` o `nameEn` | Mismas reglas que `nameEs`. |
| `descriptionEs` | string \| null | No | Se recorta. De 1 a 2000. Omitido o `null` → `null`. |
| `descriptionEn` | string \| null | No | Mismas reglas que `descriptionEs`. |
| `displayOrder` | integer | No | Entero de 0 a 1 000 000. Por defecto `0`. Se convierte con `Number()`: `"10"` → 10 y `""` → 0. No admite `null`. |
| Cualquier otro campo | — | Prohibido | 400 `property <campo> should not exist` (p. ej. `isActive` o `id`). |

**Ejemplo de petición**

```ts
const category = await catalogApi.createCategory({
  nameEs: "Parrillas",
  nameEn: "Grills",
  descriptionEs: "Cortes a la parrilla con guarniciones.",
  descriptionEn: "Grilled cuts with sides.",
  displayOrder: 10,
});
await queryClient.invalidateQueries({ queryKey: qk.categories });
```

`POST /api/backend/commercial-categories`:

```json
{
  "nameEs": "Parrillas",
  "nameEn": "Grills",
  "descriptionEs": "Cortes a la parrilla con guarniciones.",
  "descriptionEn": "Grilled cuts with sides.",
  "displayOrder": 10
}
```

**Respuesta**

```json
{
  "id": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
  "nameEs": "Parrillas",
  "nameEn": "Grills",
  "descriptionEs": "Cortes a la parrilla con guarniciones.",
  "descriptionEn": "Grilled cuts with sides.",
  "isActive": true,
  "displayOrder": 10,
  "createdAt": "2026-10-01T14:05:09.311Z",
  "updatedAt": "2026-10-01T14:05:09.311Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` | Campo no declarado (p. ej. `isActive`). |
| 400 | `nameEs must be a string` · `nameEs should not be empty` · `nameEs must be shorter than or equal to 150 characters` | `nameEs` no es string, es `""` o solo espacios, o pasa de 150. Igual con `nameEn`. |
| 400 | `descriptionEs must be a string` · `descriptionEs should not be empty` · `descriptionEs must be shorter than or equal to 2000 characters` | Lo mismo con `descriptionEs` (máx. 2000). Igual con `descriptionEn`. |
| 400 | `displayOrder must be an integer number` · `displayOrder must not be less than 0` · `displayOrder must not be greater than 1000000` | `displayOrder` es `null`, no es entero o está fuera de rango. Con `null` o un texto no numérico salen los tres. |
| 400 | `La categoría debe tener al menos un nombre en español o inglés` | No llegó ni `nameEs` ni `nameEn` con texto (p. ej. `{}` o los dos en `null`). |
| 400 | `Los datos de la categoría son inválidos` | No ocurre: el servicio lo reserva para Prisma P2004, que Prisma 7 ya no emite. Una restricción `CHECK` rechazada llega como 500 (ver abajo). |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (OWNER, OPERATOR o SUPPORT). |
| 409 | `Ya existe una categoría comercial con ese nombre` | Uno de los nombres, normalizado, ya existe como `nameEs` o `nameEn` de otra categoría, activa o no. También si dos altas iguales llegan a la vez. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | Body de más de 100 kb. |
| 500 | `Ocurrió un error interno` | `nameEs` o `nameEn` formado solo por signos diacríticos sueltos y espacios (p. ej. `^`, `` ` `` o `´`): su forma normalizada queda vacía y la base de datos la rechaza (restricción `CHECK`). |

**Efectos**

Crea la categoría activa (`isActive: true`). No toca elementos ni la información que recibe Samanta.

**Notas para el frontend**
- Unicidad: los nombres se comparan normalizados (sin tildes, diéresis ni otros signos diacríticos, también los sueltos como `^`, `` ` ``, `´` o `·`; con `ñ` → `n`, en minúsculas y con los espacios colapsados) y de forma cruzada entre idiomas. Si existe `Bebidas`, crear `Bébidas` o `nameEn: "bebidas"` da 409. Si existe `Piña colada`, también `Pina colada`; si existe `Pisco·Sour`, también `PiscoSour`.
- Los nombres de una misma categoría pueden coincidir entre sí (`nameEs` y `nameEn` iguales).
- Se crea activa. Para desactivarla usa `PATCH /commercial-categories/:id/status`. No existe borrado de categorías.
- Muestra el 409 junto al nombre: el usuario debe elegir otro.
- Después de crear, invalida `qk.categories`. La respuesta ya es la categoría completa.

## Listar categorías comerciales
`GET /commercial-categories`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `CommercialCategory[]` |
| ft-crm | `catalogApi.categories(): Promise<CommercialCategory[]>` — existe. La usa `NuevoServicioForm` (`src/features/ajustes/servicios/nuevo-servicio-form.tsx`) con `staleTime` de 60 s. |
| Caché | `qk.categories` (`["commercial-categories"]`). |

No tiene parámetros de ruta ni body. No admite query: no hay filtros ni paginación, y los parámetros que envíes se ignoran.

**Respuesta**

```json
[
  {
    "id": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
    "nameEs": "Parrillas",
    "nameEn": "Grills",
    "descriptionEs": "Cortes a la parrilla con guarniciones.",
    "descriptionEn": "Grilled cuts with sides.",
    "isActive": true,
    "displayOrder": 10,
    "createdAt": "2026-10-01T14:05:09.311Z",
    "updatedAt": "2026-10-01T14:05:09.311Z"
  },
  {
    "id": "5f7a9c1e-3a5c-4e7a-9c1e-3a5c7e9a1c3e",
    "nameEs": "Promociones",
    "nameEn": "Deals",
    "descriptionEs": null,
    "descriptionEn": null,
    "isActive": true,
    "displayOrder": 20,
    "createdAt": "2026-10-02T16:20:44.502Z",
    "updatedAt": "2026-10-02T16:20:44.502Z"
  },
  {
    "id": "7b9d1f3a-5c7e-4a9b-8d1f-3a5c7e9b1d3f",
    "nameEs": "Bebidas de temporada",
    "nameEn": null,
    "descriptionEs": "Refrescos disponibles solo en verano.",
    "descriptionEn": null,
    "isActive": false,
    "displayOrder": 50,
    "createdAt": "2026-09-20T13:01:18.640Z",
    "updatedAt": "2026-10-30T22:45:09.003Z"
  }
]
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OWNER ni OPERATOR (p. ej. solo SUPPORT). |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**
- Devuelve un array plano con todas las categorías, también las inactivas.
- Orden fijo: `displayOrder` ascendente, luego `nameEs` y después `nameEn` ascendentes, con los `null` al final. Como los nombres son únicos, el orden no cambia entre llamadas.
- En los selectores para crear o mover elementos ofrece solo las activas (`isActive: true`): con una inactiva, el backend responde 400 `La categoría comercial está inactiva`. `NuevoServicioForm` ya las filtra.
- Muestra `nameEs ?? nameEn`: una categoría puede tener solo uno de los dos nombres.
- Para ver los elementos de una categoría usa `GET /commercial-items?categoryId=<id>`.

## Ver detalle de una categoría comercial
`GET /commercial-categories/:id`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `CommercialCategory` |
| ft-crm | `catalogApi.category(id: string): Promise<CommercialCategory>` — nueva. |
| Caché | `qk.category(id)` (nueva: `["commercial-categories", "detail", id]`). |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | UUID de 8-4-4-4-12 caracteres hexadecimales, de cualquier versión. Si no lo es, 400 `Validation failed (uuid is expected)`. |

No admite query ni body.

**Respuesta**

```json
{
  "id": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
  "nameEs": "Parrillas",
  "nameEn": "Grills",
  "descriptionEs": "Cortes a la parrilla con guarniciones.",
  "descriptionEn": "Grilled cuts with sides.",
  "isActive": true,
  "displayOrder": 10,
  "createdAt": "2026-10-01T14:05:09.311Z",
  "updatedAt": "2026-10-01T14:05:09.311Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OWNER ni OPERATOR. |
| 404 | `Categoría comercial no encontrada` | No existe ninguna categoría con ese `id`. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**
- Devuelve lo mismo que cada elemento de `GET /commercial-categories`. Si ya tienes el listado en caché, puedes usarlo como `initialData` del detalle.
- No incluye los elementos de la categoría. Para listarlos usa `GET /commercial-items?categoryId=<id>`.
- Devuelve también las categorías inactivas.

## Editar categoría comercial
`PATCH /commercial-categories/:id`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `CommercialCategory` |
| ft-crm | `catalogApi.updateCategory(id: string, body: UpdateCommercialCategoryRequest): Promise<CommercialCategory>` — nueva. |
| Caché | `setQueryData(qk.category(id), respuesta)` e invalida `qk.categories` y `qk.itemsAll` (cada elemento trae un resumen de su categoría). |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | UUID de la categoría. Si no lo es, 400 `Validation failed (uuid is expected)`. |

**Body**

Actualización parcial: lo omitido se conserva y `null` borra el valor. Hay que enviar al menos un campo.

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `nameEs` | string \| null | No | Se recorta. De 1 a 150. `null` lo borra. Tras el cambio debe quedar al menos uno de los dos nombres, y los dos deben seguir siendo únicos. |
| `nameEn` | string \| null | No | Mismas reglas que `nameEs`. |
| `descriptionEs` | string \| null | No | Se recorta. De 1 a 2000. `null` la borra. |
| `descriptionEn` | string \| null | No | Mismas reglas que `descriptionEs`. |
| `displayOrder` | integer | No | Entero de 0 a 1 000 000. `"5"` → 5 y `""` → 0. No admite `null`. |
| Cualquier otro campo | — | Prohibido | 400 `property <campo> should not exist` (p. ej. `isActive`: para eso está `/status`). |

**Ejemplo de petición**

```ts
const category = await catalogApi.updateCategory("3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71", {
  descriptionEn: null,
  displayOrder: 5,
});
queryClient.setQueryData(qk.category(category.id), category);
await queryClient.invalidateQueries({ queryKey: qk.categories });
await queryClient.invalidateQueries({ queryKey: qk.itemsAll });
```

`PATCH /api/backend/commercial-categories/3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71`:

```json
{
  "descriptionEn": null,
  "displayOrder": 5
}
```

**Respuesta**

```json
{
  "id": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
  "nameEs": "Parrillas",
  "nameEn": "Grills",
  "descriptionEs": "Cortes a la parrilla con guarniciones.",
  "descriptionEn": null,
  "isActive": true,
  "displayOrder": 5,
  "createdAt": "2026-10-01T14:05:09.311Z",
  "updatedAt": "2026-11-03T16:05:48.329Z"
}
```

**Errores**

Orden de las comprobaciones: sesión y rol; UUID y DTO; después, en el servicio, body vacío, existencia, nombres y unicidad.

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Campo no declarado (p. ej. `isActive` o `id`). |
| 400 | `nameEs must be a string` · `nameEs should not be empty` · `nameEs must be shorter than or equal to 150 characters` | `nameEs` no es string, es `""` o solo espacios, o pasa de 150. Igual con `nameEn`. |
| 400 | `descriptionEs must be a string` · `descriptionEs should not be empty` · `descriptionEs must be shorter than or equal to 2000 characters` | Lo mismo con `descriptionEs` (máx. 2000). Igual con `descriptionEn`. |
| 400 | `displayOrder must be an integer number` · `displayOrder must not be less than 0` · `displayOrder must not be greater than 1000000` | `displayOrder` es `null`, no es entero o está fuera de rango. |
| 400 | `Debes proporcionar al menos un campo para actualizar` | El body es `{}`. Se comprueba antes de buscar la categoría: `{}` con un `id` inexistente da 400, no 404. |
| 400 | `La categoría debe tener al menos un nombre en español o inglés` | El cambio dejaría la categoría sin nombres (p. ej. `nameEs: null` cuando no tiene `nameEn`). |
| 400 | `Los datos de la categoría son inválidos` | No ocurre: el servicio lo reserva para Prisma P2004, que Prisma 7 ya no emite. Una restricción `CHECK` rechazada llega como 500 (ver abajo). |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (OWNER, OPERATOR o SUPPORT). |
| 404 | `Categoría comercial no encontrada` | No existe ninguna categoría con ese `id`. |
| 409 | `Ya existe una categoría comercial con ese nombre` | Uno de los nombres resultantes, normalizado, coincide con `nameEs` o `nameEn` de otra categoría. También si dos cambios iguales llegan a la vez. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | Body de más de 100 kb. |
| 500 | `Ocurrió un error interno` | El `nameEs` o `nameEn` enviado está formado solo por signos diacríticos sueltos y espacios (p. ej. `^`, `` ` `` o `´`): su forma normalizada queda vacía y la base de datos la rechaza (restricción `CHECK`). |

**Efectos**
- Actualiza solo los campos enviados y `updatedAt`. Si cambia un nombre, recalcula su forma normalizada.
- No cambia `isActive` ni el estado de aprobación de sus elementos.
- Los elementos de la categoría muestran el cambio en su resumen `category` (`nameEs`, `nameEn`, `displayOrder`). Con `sort=category`, `displayOrder` y los nombres cambian el orden de `GET /commercial-items`.
- Samanta recibe el nombre de la categoría de cada elemento que ve. Cambiar un nombre deja desactualizados los borradores pendientes que incluían elementos de esta categoría (pasan a `STALE`; ver [Generar un borrador con Samanta](04-bandeja-samanta.md#generar-un-borrador-con-samanta)). `displayOrder` no afecta a Samanta.

**Notas para el frontend**
- Envía solo lo que cambió. `""` da 400: para borrar una descripción o un nombre, envía `null`.
- La unicidad se comprueba siempre con los nombres resultantes, sin contar la propia categoría.
- Muestra el 409 junto al nombre editado.
- Después de guardar, refresca el listado de categorías y el de elementos.

## Activar o desactivar una categoría comercial
`PATCH /commercial-categories/:id/status`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `CommercialCategory` |
| ft-crm | `catalogApi.setCategoryActive(id: string, isActive: boolean): Promise<CommercialCategory>` — nueva. |
| Caché | `setQueryData(qk.category(id), respuesta)` e invalida `qk.categories` y `qk.itemsAll` (cambia `category.isActive` en cada elemento). |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | UUID de la categoría. Si no lo es, 400 `Validation failed (uuid is expected)`. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `isActive` | boolean | Sí | Booleano JSON (`"false"` → 400). |
| Cualquier otro campo | — | Prohibido | 400 `property <campo> should not exist`. |

**Ejemplo de petición**

```ts
const category = await catalogApi.setCategoryActive("3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71", false);
```

`PATCH /api/backend/commercial-categories/3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71/status`:

```json
{ "isActive": false }
```

**Respuesta**

```json
{
  "id": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
  "nameEs": "Parrillas",
  "nameEn": "Grills",
  "descriptionEs": "Cortes a la parrilla con guarniciones.",
  "descriptionEn": null,
  "isActive": false,
  "displayOrder": 5,
  "createdAt": "2026-10-01T14:05:09.311Z",
  "updatedAt": "2026-11-03T16:20:02.774Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `isActive must be a boolean value` | Falta `isActive` o no es un booleano JSON. |
| 400 | `property <campo> should not exist` | Se enviaron otros campos (p. ej. `nameEs`). |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (OWNER, OPERATOR o SUPPORT). |
| 404 | `Categoría comercial no encontrada` | No existe ninguna categoría con ese `id`. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | Body de más de 100 kb. |

**Efectos**

Cambia `isActive` y `updatedAt` de la categoría. Sus elementos conservan su `isActive` y su `approvalStatus`, pero con la categoría inactiva:
- No se pueden crear elementos en ella ni moverlos a ella: 400 `La categoría comercial está inactiva`.
- Editar uno de sus elementos reenviando su `categoryId` también da ese 400. Sin `categoryId`, la edición funciona.
- No se pueden aprobar sus elementos: 400 `No se puede aprobar un elemento de una categoría inactiva`.
- Samanta deja de ver sus elementos, y los borradores pendientes que los incluían quedan desactualizados.
- Las solicitudes y reservas no miran la categoría: siguen aceptando sus elementos si están activos y aprobados.

Reactivarla revierte todo lo anterior: los elementos aprobados y activos vuelven a ser visibles para Samanta, y si alguno entra entre los 30 que ve, los borradores pendientes quedan desactualizados.

**Notas para el frontend**
- Es idempotente: repetir el mismo valor no da error (aunque `updatedAt` cambia).
- Antes de desactivar, avisa de las consecuencias, sobre todo si la categoría tiene elementos aprobados.
- En los selectores de solicitudes y reservas decide si ocultas los elementos de categorías inactivas (`category.isActive`): el backend no lo hace (ver [Preguntas abiertas](#preguntas-abiertas)).
- Después del cambio, refresca el listado de categorías y el de elementos.

## Crear elemento comercial
`POST /commercial-items`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 201 · `CommercialItem` |
| ft-crm | `catalogApi.create(body: CreateCommercialItemRequest): Promise<CommercialItem>` — existe. Hoy la usa `NuevoServicioForm` con un alta mínima (`type`, `categoryId`, `nameEs`, `descriptionEs`, `basePrice`); su tipo `CreateCommercialItemRequest` debe ampliarse al de [Tipos TypeScript](#tipos-typescript) para enviar el resto. |
| Caché | Invalida `qk.itemsAll`. Opcional: `setQueryData(qk.item(respuesta.id), respuesta)`. |
| Límites | Body máx. 100 kb (413). Un elemento con muchas variantes, FAQs o textos largos puede superarlo aunque cada campo sea válido. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `type` | `CommercialItemType` | Sí | `DISH`, `BEVERAGE`, `SERVICE`, `PROMOTION` o `EVENT`. No se puede cambiar después. |
| `categoryId` | `Uuid` | Sí | UUID de una categoría que exista y esté activa. No admite `null`. |
| `nameEs` | string \| null | `nameEs` o `nameEn` | Se recorta. De 1 a 200. Hay que enviar al menos uno de los dos nombres con texto. Sin `nameEs` no se puede aprobar. Los nombres de elementos pueden repetirse. |
| `nameEn` | string \| null | `nameEs` o `nameEn` | Mismas reglas que `nameEs`. |
| `descriptionEs` | string \| null | No | Se recorta. De 1 a 5000. Omitido o `null` → `null`. |
| `descriptionEn` | string \| null | No | Mismas reglas que `descriptionEs`. |
| `basePrice` | `MoneyString` \| null | Según la regla de precio | String que cumpla `^(?:0\|[1-9]\d{0,7})(?:\.\d{1,2})?$`: de `"0"` a `"99999999.99"`, con punto decimal, hasta 2 decimales, sin signo, sin ceros a la izquierda (`"025"` → 400) ni separador de miles. Se recorta. Un número JSON o `""` dan 400. Omitido o `null` → sin precio base. Ver la regla de precio en Notas. |
| `displayOrder` | integer | No | Entero de 0 a 1 000 000. Por defecto `0`. `"3"` → 3 y `""` → 0. No admite `null`. |
| `conditions` | string \| null | No | Se recorta. De 1 a 5000. Condiciones comerciales visibles (Samanta las recibe). |
| `internalNotes` | string \| null | No | Se recorta. De 1 a 5000. Nota interna: la ven los roles del CRM, pero no Samanta. |
| `availabilityNote` | string \| null | No | Se recorta. De 1 a 2000. Nota de disponibilidad (Samanta la recibe). |
| `variants` | `CommercialItemVariantInput[]` | No | Array de hasta 50 objetos. No admite `null`. Ver `variants[]`. |
| `images` | `CommercialItemImageInput[]` | No | Array de hasta 20 objetos. No admite `null`. Ver `images[]`. |
| `faqs` | `CommercialItemFaqInput[]` | No | Array de hasta 50 objetos. No admite `null`. Ver `faqs[]`. |
| `schedules` | `CommercialItemScheduleInput[]` | No | Array de hasta 7 objetos, sin repetir `dayOfWeek`. No admite `null`. Ver `schedules[]`. |
| `promotionDetail` | `CommercialPromotionDetailInput` \| null | No | Objeto solo si `type` es `PROMOTION` (con otro tipo, 400). `null` u omitido → sin detalle, con cualquier tipo. Ver `promotionDetail`. |
| `eventDetail` | `CommercialEventDetailInput` \| null | No | Objeto solo si `type` es `EVENT`. `null` u omitido → sin detalle. Ver `eventDetail`. |
| `isActive`, `approvalStatus`, `id`, `createdAt`, otros | — | Prohibido | 400 `property <campo> should not exist`. El elemento nace activo y en `DRAFT`. |

**Body — `variants[]`** (tamaños o porciones con precio propio)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `nameEs` | string \| null | `nameEs` o `nameEn` | Se recorta. De 1 a 150. Cada variante necesita al menos un nombre con texto. |
| `nameEn` | string \| null | `nameEs` o `nameEn` | Mismas reglas que `nameEs`. |
| `descriptionEs` | string \| null | No | Se recorta. De 1 a 2000. |
| `descriptionEn` | string \| null | No | Mismas reglas que `descriptionEs`. |
| `price` | `MoneyString` | Sí | Mismo formato que `basePrice`. No admite `null`. |
| `isActive` | boolean | No | Booleano JSON (`"true"` → 400). Omitido o `null` → `true`. Solo las variantes activas cuentan para la regla de precio y para Samanta. |
| `displayOrder` | integer \| null | No | Entero de 0 a 1 000 000. Omitido o `null` → su posición en el array (0, 1, 2…). |
| Otro campo | — | Prohibido | `variants.<i>.property <campo> should not exist` (p. ej. `id`, `createdAt` o `updatedAt` copiados del GET). |

Dos variantes del mismo elemento no pueden tener el mismo nombre normalizado. Se compara `nameEs`, o `nameEn` si falta, sin tildes ni otros signos diacríticos (también los sueltos, como `^` o `´`), con `ñ` → `n`, en minúsculas y con los espacios colapsados. Cuentan también las inactivas.

**Body — `images[]`** (solo URLs: no hay subida de archivos)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `url` | string | Sí | Se recorta. URL con `http://` o `https://` obligatorio y un host con dominio de nivel superior o una IP (`localhost` no vale). Máx. 2048. No puede repetirse en el mismo elemento (comparación exacta, tras recortar). |
| `altTextEs` | string \| null | No | Se recorta. De 1 a 300. |
| `altTextEn` | string \| null | No | Mismas reglas que `altTextEs`. |
| `isPrimary` | boolean | No | Booleano JSON (`"true"` → 400). Omitido o `null` → `false`. Como máximo una imagen con `true`; puede no haber ninguna. |
| `displayOrder` | integer \| null | No | Entero de 0 a 1 000 000. Omitido o `null` → su posición en el array. |
| Otro campo | — | Prohibido | `images.<i>.property <campo> should not exist`. |

**Body — `faqs[]`**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `questionEs` | string | Sí | Se recorta. De 1 a 500. No admite `null`. |
| `questionEn` | string \| null | No | Se recorta. De 1 a 500. |
| `answerEs` | string | Sí | Se recorta. De 1 a 5000. No admite `null`. |
| `answerEn` | string \| null | No | Se recorta. De 1 a 5000. |
| `displayOrder` | integer \| null | No | Entero de 0 a 1 000 000. Omitido o `null` → su posición en el array. |
| Otro campo | — | Prohibido | `faqs.<i>.property <campo> should not exist`. |

**Body — `schedules[]`** (disponibilidad por día)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `dayOfWeek` | `DayOfWeek` | Sí | `MONDAY` … `SUNDAY`. No puede repetirse en el array. |
| `isAvailable` | boolean | Sí | Booleano JSON. |
| `startTime` | `HhMm` \| null | Si `isAvailable` es `true` | Se recorta. `HH:mm` de 24 h (`00:00` a `23:59`) y distinto de `endTime`. Puede ser mayor que `endTime`: el horario cruza la medianoche (p. ej. `18:00` a `02:00`). Con `isAvailable: false`, omítelo o envía `null`. |
| `endTime` | `HhMm` \| null | Si `isAvailable` es `true` | Mismas reglas que `startTime`. |
| Otro campo | — | Prohibido | `schedules.<i>.property <campo> should not exist`. |

Un día sin entrada no tiene registro: no hace falta enviar los 7 días.

**Body — `promotionDetail`** (solo `PROMOTION`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `validFrom` | `IsoDateTime` \| null | No | Se recorta. ISO 8601 con segundos y zona (`Z` o `±HH:mm`, con dos puntos), hasta 3 decimales, y una fecha que exista (p. ej. `2026-12-24T20:00:00-05:00`). No puede ser posterior a `validUntil`; igual sí. |
| `validUntil` | `IsoDateTime` \| null | No | Mismo formato que `validFrom`. |
| `promotionalPrice` | `MoneyString` \| null | No | Mismo formato que `basePrice`. No se compara con `basePrice`. |
| Otro campo | — | Prohibido | `promotionDetail.property <campo> should not exist`. |

**Body — `eventDetail`** (solo `EVENT`)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `startAt` | `IsoDateTime` \| null | No | Mismo formato que `validFrom`. No puede ser posterior a `endAt`; igual sí. |
| `endAt` | `IsoDateTime` \| null | No | Mismo formato que `validFrom`. |
| `capacity` | integer \| null | No | Entero de 1 a 1 000 000. `"60"` → 60. |
| Otro campo | — | Prohibido | `eventDetail.property <campo> should not exist`. |

**Ejemplo de petición**

```ts
const item = await catalogApi.create({
  type: "DISH",
  categoryId: "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
  nameEs: "Anticuchos de corazón",
  nameEn: "Beef heart skewers",
  descriptionEs: "Brochetas de corazón de res con papas doradas y choclo.",
  displayOrder: 1,
  conditions: "Sujeto a disponibilidad del día.",
  internalNotes: "Confirmar stock con cocina antes de ofrecer.",
  availabilityNote: "Solo turno noche.",
  variants: [
    { nameEs: "Porción personal", nameEn: "Single portion", price: "25" },
    { nameEs: "Porción para compartir", nameEn: "Sharing portion", price: "45.00" },
  ],
  images: [
    { url: "https://cdn.example.com/fogon-andino/anticuchos.jpg", altTextEs: "Anticuchos en plato de barro", isPrimary: true },
  ],
  faqs: [{ questionEs: "¿Es picante?", answerEs: "El ají se sirve aparte." }],
  schedules: [
    { dayOfWeek: "FRIDAY", isAvailable: true, startTime: "18:00", endTime: "23:30" },
    { dayOfWeek: "SUNDAY", isAvailable: false },
  ],
});
await queryClient.invalidateQueries({ queryKey: qk.itemsAll });
```

`POST /api/backend/commercial-items`:

```json
{
  "type": "DISH",
  "categoryId": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
  "nameEs": "Anticuchos de corazón",
  "nameEn": "Beef heart skewers",
  "descriptionEs": "Brochetas de corazón de res con papas doradas y choclo.",
  "displayOrder": 1,
  "conditions": "Sujeto a disponibilidad del día.",
  "internalNotes": "Confirmar stock con cocina antes de ofrecer.",
  "availabilityNote": "Solo turno noche.",
  "variants": [
    { "nameEs": "Porción personal", "nameEn": "Single portion", "price": "25" },
    { "nameEs": "Porción para compartir", "nameEn": "Sharing portion", "price": "45.00" }
  ],
  "images": [
    { "url": "https://cdn.example.com/fogon-andino/anticuchos.jpg", "altTextEs": "Anticuchos en plato de barro", "isPrimary": true }
  ],
  "faqs": [
    { "questionEs": "¿Es picante?", "answerEs": "El ají se sirve aparte." }
  ],
  "schedules": [
    { "dayOfWeek": "FRIDAY", "isAvailable": true, "startTime": "18:00", "endTime": "23:30" },
    { "dayOfWeek": "SUNDAY", "isAvailable": false }
  ]
}
```

Es un `DISH` sin `basePrice` y con dos variantes activas: cumple la regla de precio.

**Respuesta**

```json
{
  "id": "c2a4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f",
  "type": "DISH",
  "categoryId": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
  "nameEs": "Anticuchos de corazón",
  "nameEn": "Beef heart skewers",
  "descriptionEs": "Brochetas de corazón de res con papas doradas y choclo.",
  "descriptionEn": null,
  "basePrice": null,
  "displayOrder": 1,
  "isActive": true,
  "approvalStatus": "DRAFT",
  "conditions": "Sujeto a disponibilidad del día.",
  "internalNotes": "Confirmar stock con cocina antes de ofrecer.",
  "availabilityNote": "Solo turno noche.",
  "createdAt": "2026-11-03T02:32:11.984Z",
  "updatedAt": "2026-11-03T02:32:11.984Z",
  "category": {
    "id": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
    "nameEs": "Parrillas",
    "nameEn": "Grills",
    "isActive": true,
    "displayOrder": 10
  },
  "variants": [
    {
      "id": "7e9a1c3b-5d2f-4a6e-8b0c-1d3f5a7c9e2b",
      "nameEs": "Porción personal",
      "nameEn": "Single portion",
      "descriptionEs": null,
      "descriptionEn": null,
      "price": "25.00",
      "isActive": true,
      "displayOrder": 0,
      "createdAt": "2026-11-03T02:32:11.984Z",
      "updatedAt": "2026-11-03T02:32:11.984Z"
    },
    {
      "id": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "nameEs": "Porción para compartir",
      "nameEn": "Sharing portion",
      "descriptionEs": null,
      "descriptionEn": null,
      "price": "45.00",
      "isActive": true,
      "displayOrder": 1,
      "createdAt": "2026-11-03T02:32:11.984Z",
      "updatedAt": "2026-11-03T02:32:11.984Z"
    }
  ],
  "images": [
    {
      "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "url": "https://cdn.example.com/fogon-andino/anticuchos.jpg",
      "altTextEs": "Anticuchos en plato de barro",
      "altTextEn": null,
      "isPrimary": true,
      "displayOrder": 0,
      "createdAt": "2026-11-03T02:32:11.984Z"
    }
  ],
  "faqs": [
    {
      "id": "b5c6d7e8-f9a0-4b1c-9d2e-3f4a5b6c7d8e",
      "questionEs": "¿Es picante?",
      "questionEn": null,
      "answerEs": "El ají se sirve aparte.",
      "answerEn": null,
      "displayOrder": 0,
      "createdAt": "2026-11-03T02:32:11.984Z",
      "updatedAt": "2026-11-03T02:32:11.984Z"
    }
  ],
  "schedules": [
    {
      "id": "d9e8f7a6-b5c4-4d3e-8f2a-1b0c9d8e7f6a",
      "dayOfWeek": "FRIDAY",
      "isAvailable": true,
      "startTime": "18:00",
      "endTime": "23:30"
    },
    {
      "id": "c8d7e6f5-a4b3-4c2d-9e1f-0a9b8c7d6e5f",
      "dayOfWeek": "SUNDAY",
      "isAvailable": false,
      "startTime": null,
      "endTime": null
    }
  ],
  "promotionDetail": null,
  "eventDetail": null
}
```

**Errores**

Orden de las comprobaciones: sesión y rol; DTO; después, en el servicio, nombres, variantes, imágenes, horarios, fechas de los detalles, regla de precio, tipo de detalle y, por último, la categoría. Los mensajes de validación llegan juntos en el array `message`; los de los hijos llevan la ruta como prefijo (`variants.<i>.`, `promotionDetail.`…), donde `<i>` es la posición en el array.

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `property <campo> should not exist` | Campo no declarado, p. ej. `isActive`, `approvalStatus` o `id`. En los hijos: `variants.<i>.property id should not exist`, `promotionDetail.property id should not exist`, etc. |
| 400 | `type must be one of the following values: DISH, BEVERAGE, SERVICE, PROMOTION, EVENT` | `type` falta o no es uno de esos valores. |
| 400 | `categoryId must be a UUID` | `categoryId` falta, es `null` o no es un UUID. |
| 400 | `nameEs must be a string` · `nameEs should not be empty` · `nameEs must be shorter than or equal to 200 characters` | `nameEs` no es string, es `""` o solo espacios, o pasa de 200. Igual con `nameEn`. |
| 400 | `descriptionEs must be a string` · `descriptionEs should not be empty` · `descriptionEs must be shorter than or equal to 5000 characters` | Lo mismo con `descriptionEs` (máx. 5000). Igual con `descriptionEn`. |
| 400 | `basePrice must be a string` · `basePrice debe ser una cadena decimal no negativa con máximo dos decimales` | `basePrice` es un número JSON (salen los dos), es `""` o no cumple el formato (`"-1"`, `"1,5"`, `"025"`, `"1.234"`, `"100000000"`). |
| 400 | `displayOrder must be an integer number` · `displayOrder must not be less than 0` · `displayOrder must not be greater than 1000000` | `displayOrder` es `null`, no es entero o está fuera de rango. |
| 400 | `conditions must be a string` · `conditions should not be empty` · `conditions must be shorter than or equal to 5000 characters` | Lo mismo con `conditions`. Igual con `internalNotes` (máx. 5000) y `availabilityNote` (máx. 2000). |
| 400 | `variants must be an array` · `variants must contain no more than 50 elements` · `each value in nested property variants must be either object or array` | `variants` es `null` o un valor simple (salen los tres), o tiene más de 50 elementos. Igual con `images` (máx. 20), `faqs` (máx. 50) y `schedules` (máx. 7; con `null` también sale `All schedules's elements must be unique`). |
| 400 | `variants.each value in nested property variants must be either object or array` | Un elemento del array es `null` o un valor simple. Igual con `images`, `faqs` y `schedules`. |
| 400 | `variants.<i>.price must be a string` · `variants.<i>.price debe ser una cadena decimal no negativa con máximo dos decimales` | Falta `price`, es un número o no cumple el formato. |
| 400 | `variants.<i>.nameEs must be a string` · `variants.<i>.nameEs should not be empty` · `variants.<i>.nameEs must be shorter than or equal to 150 characters` | Igual con `nameEn` (máx. 150) y con `descriptionEs` y `descriptionEn` (máx. 2000). |
| 400 | `variants.<i>.isActive must be a boolean value` | `isActive` no es un booleano JSON. |
| 400 | `variants.<i>.displayOrder must be an integer number` · `variants.<i>.displayOrder must not be less than 0` · `variants.<i>.displayOrder must not be greater than 1000000` | Igual en `images`, `faqs` y sus `displayOrder`. |
| 400 | `images.<i>.url must be a URL address` · `images.<i>.url must be shorter than or equal to 2048 characters` | Falta `url` (salen los dos), no es `http(s)://`, no tiene dominio con extensión ni IP, o pasa de 2048. |
| 400 | `images.<i>.altTextEs must be a string` · `images.<i>.altTextEs should not be empty` · `images.<i>.altTextEs must be shorter than or equal to 300 characters` | Igual con `altTextEn`. |
| 400 | `images.<i>.isPrimary must be a boolean value` | `isPrimary` no es un booleano JSON (p. ej. `"true"`). |
| 400 | `faqs.<i>.questionEs must be a string` · `faqs.<i>.questionEs should not be empty` · `faqs.<i>.questionEs must be shorter than or equal to 500 characters` | Falta `questionEs` (salen los tres), está vacía o pasa de 500. Igual con `questionEn` (500) y con `answerEs` y `answerEn` (5000). |
| 400 | `All schedules's elements must be unique` | Dos horarios con el mismo `dayOfWeek`. |
| 400 | `schedules.<i>.dayOfWeek must be one of the following values: MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY` | Día inválido. |
| 400 | `schedules.<i>.isAvailable must be a boolean value` | `isAvailable` falta o no es un booleano JSON. |
| 400 | `schedules.<i>.Un horario disponible requiere startTime y endTime distintos en formato HH:mm; un horario no disponible no admite horas` | Disponible sin las dos horas, con horas iguales o mal formadas, o no disponible con horas. |
| 400 | `schedules.<i>.startTime must be a string` · `schedules.<i>.startTime debe tener el formato HH:mm` · `schedules.<i>.endTime must be a string` · `schedules.<i>.endTime debe tener el formato HH:mm` | Hora que no es string o no cumple `HH:mm` (p. ej. `9:00` o `24:00`). Llega junto con el mensaje anterior. |
| 400 | `nested property promotionDetail must be either object or array` · `nested property eventDetail must be either object or array` | El detalle es un string, un número o un booleano. |
| 400 | `promotionDetail.validFrom debe ser una fecha ISO 8601 válida` · `promotionDetail.validFrom debe incluir segundos y zona horaria (Z o ±HH:mm)` | La fecha no existe (`2026-02-30T10:00:00Z`) o no es texto ISO; o le faltan los segundos o la zona, trae más de 3 decimales o la zona va sin dos puntos (`-0500`). Igual con `validUntil` y con `eventDetail.startAt` y `eventDetail.endAt`. |
| 400 | `promotionDetail.promotionalPrice must be a string` · `promotionDetail.promotionalPrice debe ser una cadena decimal no negativa con máximo dos decimales` | Mismo caso que `basePrice`. |
| 400 | `eventDetail.capacity must be an integer number` · `eventDetail.capacity must not be less than 1` · `eventDetail.capacity must not be greater than 1000000` | `capacity` no es entero o está fuera de 1 a 1 000 000. |
| 400 | `El elemento comercial debe tener al menos un nombre en español o inglés` | No llegó ni `nameEs` ni `nameEn` con texto. |
| 400 | `Cada variante debe tener al menos un nombre en español o inglés` | Una variante no tiene ningún nombre. |
| 400 | `Las variantes no pueden duplicarse` | Dos variantes tienen el mismo nombre normalizado (`nameEs`, o `nameEn` si falta). |
| 400 | `Las imágenes no pueden duplicarse` | Hay una URL repetida (tras recortar). |
| 400 | `Un elemento comercial solo puede tener una imagen principal` | Más de una imagen con `isPrimary: true`. |
| 400 | `No puede repetirse un día en los horarios del elemento` · `Los horarios comerciales son incoherentes` | Respaldo del servicio. Por HTTP no se ven: el DTO rechaza antes esos casos. |
| 400 | `validFrom debe ser una fecha válida` · `validUntil debe ser una fecha válida` · `startAt debe ser una fecha válida` · `endAt debe ser una fecha válida` | Respaldo del servicio; el DTO rechaza antes las fechas inválidas. |
| 400 | `validFrom no puede ser posterior a validUntil` | Rango de la promoción invertido. |
| 400 | `startAt no puede ser posterior a endAt` | Rango del evento invertido. |
| 400 | `Un plato o bebida debe tener un precio base o variantes activas, pero no ambos` | Un `DISH` o `BEVERAGE` sin `basePrice` ni variantes activas, o con las dos cosas. |
| 400 | `promotionDetail solo corresponde a elementos PROMOTION` | Se envió `promotionDetail` como objeto con otro `type`. |
| 400 | `eventDetail solo corresponde a elementos EVENT` | Se envió `eventDetail` como objeto con otro `type`. |
| 400 | `La categoría comercial no existe` | `categoryId` no corresponde a ninguna categoría. |
| 400 | `La categoría comercial está inactiva` | La categoría está desactivada. |
| 400 | `La operación contiene referencias o valores comerciales inválidos` | Defensivo: solo con una clave foránea rota (Prisma P2003). El servicio comprueba antes la categoría en la misma transacción, y una restricción `CHECK` llega como 500, no aquí. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (OWNER, OPERATOR o SUPPORT). |
| 409 | `La operación contiene datos comerciales duplicados` | La base de datos rechaza un duplicado (Prisma P2002). Respaldo: el servicio detecta antes los duplicados. |
| 409 | `La operación comercial entró en conflicto; inténtalo nuevamente` | Conflicto con otra escritura simultánea que siguió tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | Body de más de 100 kb. |
| 500 | `Ocurrió un error interno` | El nombre enviado que se normaliza (`nameEs`, o `nameEn` si falta, del elemento o de una variante) está formado solo por signos diacríticos sueltos y espacios (p. ej. `^`, `` ` `` o `´`): su forma normalizada queda vacía y la base de datos la rechaza (restricción `CHECK`). |

**Efectos**
- Crea el elemento con `approvalStatus: "DRAFT"` e `isActive: true`, junto con sus variantes, imágenes, FAQs, horarios y detalle, en una sola transacción serializable. Si algo falla, no se guarda nada.
- Un elemento en `DRAFT` no llega a Samanta ni se puede elegir en solicitudes o reservas: hay que aprobarlo con `PATCH /commercial-items/:id/approval`.

**Notas para el frontend**
- **Regla de precio:** un `DISH` o `BEVERAGE` lleva exactamente un mecanismo de precio: `basePrice` **o** al menos una variante activa. Sin ninguno, o con los dos, da 400. `SERVICE`, `PROMOTION` y `EVENT` admiten `basePrice`, variantes, las dos cosas o ninguna. El alta mínima de ft-crm no maneja variantes, por eso exige `basePrice` en platos y bebidas (`priceRequired()`).
- Los importes viajan como string: no los conviertas a número. La respuesta trae siempre 2 decimales (`"25"` → `"25.00"`).
- Si un hijo no trae `displayOrder`, se usa su posición en el array. La respuesta ordena los hijos por `displayOrder` y después por `createdAt`, y los horarios de `MONDAY` a `SUNDAY`. No hay más desempate: si envías dos hijos con el mismo `displayOrder` en una misma petición, su orden relativo no está garantizado.
- `promotionDetail` y `eventDetail` son opcionales incluso en `PROMOTION` y `EVENT`; si se omiten, la respuesta trae `null`. Enviar `{}` crea el detalle con todos sus campos en `null`.
- Fechas de promoción o evento: envíalas con segundos y zona, igual que en reservas (`toISOString()` sirve). La respuesta viene en UTC: muéstralas en el `timeZone` del restaurante.
- Los nombres de los elementos pueden repetirse; solo las variantes deben ser únicas dentro de su elemento.
- No hay subida de archivos: `images[].url` debe apuntar a una imagen ya alojada.
- Samanta recibe, por elemento, nombres, tipo, descripciones, `basePrice`, `conditions`, `availabilityNote`, el nombre de la categoría, hasta 10 variantes activas, hasta 10 FAQs, los horarios, el detalle de promoción y las fechas del evento. No recibe imágenes, `internalNotes` ni `capacity`.
- Mantén breves los textos: si la información comercial que recibe Samanta supera 32 000 bytes, generar borradores responde 409 `Contexto comercial demasiado extenso; requiere revisión manual`.
- Después de crear, muestra que el elemento quedó en borrador y ofrece aprobarlo (ft-crm ya lo avisa en `ServiciosView`).

## Listar elementos comerciales
`GET /commercial-items`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `Paginated<CommercialItem>` |
| ft-crm | `catalogApi.items(query: CommercialItemListQuery): Promise<Paginated<CommercialItem>>` — existe. `ServiciosView` (`src/features/ajustes/servicios/servicios-view.tsx`) pide `{ sort: "category", order: "asc", page, limit: 50 }` con `keepPreviousData`. |
| Caché | `qk.items(query)` (`["commercial-items", query]`); `qk.itemsAll` invalida todas las páginas. |

**Query**

Todos los parámetros son opcionales y se combinan con AND. `toSearch()` de `apiFetch` ya omite los vacíos y envía los booleanos como `true`/`false`.

| Campo | Tipo | Obligatorio | Por defecto | Reglas |
|---|---|---|---|---|
| `page` | integer | No | `1` | Entero de 1 a 1 000 000. `page=` (vacío) da 400. |
| `limit` | integer | No | `20` | Entero de 1 a 100. |
| `type` | `CommercialItemType` | No | — | Filtro exacto. Un solo valor: repetir el parámetro da 400. |
| `approvalStatus` | `CommercialApprovalStatus` | No | — | Filtro exacto: `DRAFT`, `APPROVED` o `REJECTED`. Un solo valor. |
| `isActive` | boolean | No | — (todos) | Solo los textos `true` o `false`; `1`, `0` o `TRUE` dan 400. |
| `categoryId` | `Uuid` | No | — | Filtro exacto. No comprueba que la categoría exista: si no existe, la lista sale vacía. |
| `search` | string | No | — | Se recorta. De 1 a 200 caracteres. Busca el texto, sin distinguir mayúsculas pero sí tildes, en `nameEs`, `nameEn`, `descriptionEs` o `descriptionEn` (basta con uno). |
| `sort` | `category` \| `name` \| `createdAt` | No | `createdAt` | Criterio de orden (ver Notas). |
| `order` | `asc` \| `desc` | No | `desc` | Dirección del orden, en minúsculas. |
| Otro parámetro | — | Prohibido | — | 400 `property <param> should not exist`. |

**Ejemplo de petición**

Listado de Ajustes > Servicios:

```ts
const query: CommercialItemListQuery = { sort: "category", order: "asc", page: 1, limit: 50 };
const page = await catalogApi.items(query); // caché: qk.items(query)
```

`GET /api/backend/commercial-items?sort=category&order=asc&page=1&limit=50`

Selector de elementos para una solicitud o una reserva (solo activos y aprobados):

```ts
const options = await catalogApi.items({ isActive: true, approvalStatus: "APPROVED", search: "parrillada", sort: "name", order: "asc", limit: 20 });
```

`GET /api/backend/commercial-items?isActive=true&approvalStatus=APPROVED&search=parrillada&sort=name&order=asc&limit=20`

**Respuesta**

La respuesta al selector del ejemplo:

```json
{
  "data": [
    {
      "id": "4b6d8f0a-2c4e-4a6b-9c8d-0e2f4a6b8c0d",
      "type": "PROMOTION",
      "categoryId": "5f7a9c1e-3a5c-4e7a-9c1e-3a5c7e9a1c3e",
      "nameEs": "Parrillada para dos",
      "nameEn": "Grill for two",
      "descriptionEs": "Parrillada mixta para dos personas con dos bebidas.",
      "descriptionEn": "Mixed grill for two with two drinks.",
      "basePrice": "120.00",
      "displayOrder": 0,
      "isActive": true,
      "approvalStatus": "APPROVED",
      "conditions": "Válido de lunes a jueves. No acumulable con otras promociones.",
      "internalNotes": null,
      "availabilityNote": null,
      "createdAt": "2026-10-20T17:45:03.220Z",
      "updatedAt": "2026-10-21T09:12:55.871Z",
      "category": {
        "id": "5f7a9c1e-3a5c-4e7a-9c1e-3a5c7e9a1c3e",
        "nameEs": "Promociones",
        "nameEn": "Deals",
        "isActive": true,
        "displayOrder": 20
      },
      "variants": [
        {
          "id": "0b2d4f6a-8c0e-4b2d-9f6a-8c0e2b4d6f8a",
          "nameEs": "Con jarra de chicha",
          "nameEn": "With chicha pitcher",
          "descriptionEs": "Cambia las dos bebidas por una jarra de chicha morada.",
          "descriptionEn": null,
          "price": "129.90",
          "isActive": true,
          "displayOrder": 0,
          "createdAt": "2026-10-20T17:45:03.220Z",
          "updatedAt": "2026-10-20T17:45:03.220Z"
        }
      ],
      "images": [
        {
          "id": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
          "url": "https://cdn.example.com/fogon-andino/parrillada-dos.jpg",
          "altTextEs": "Parrillada mixta servida en tabla",
          "altTextEn": "Mixed grill served on a board",
          "isPrimary": true,
          "displayOrder": 0,
          "createdAt": "2026-10-20T17:45:03.220Z"
        }
      ],
      "faqs": [
        {
          "id": "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f",
          "questionEs": "¿Se puede pedir para llevar?",
          "questionEn": "Is it available for takeaway?",
          "answerEs": "Sí, con el mismo precio promocional.",
          "answerEn": "Yes, at the same promotional price.",
          "displayOrder": 0,
          "createdAt": "2026-10-20T17:45:03.220Z",
          "updatedAt": "2026-10-20T17:45:03.220Z"
        }
      ],
      "schedules": [
        {
          "id": "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
          "dayOfWeek": "MONDAY",
          "isAvailable": true,
          "startTime": "12:00",
          "endTime": "16:00"
        }
      ],
      "promotionDetail": {
        "id": "e4f5a6b7-c8d9-4e0f-a1b2-c3d4e5f6a7b8",
        "validFrom": "2026-11-01T05:00:00.000Z",
        "validUntil": "2026-12-01T04:59:59.000Z",
        "promotionalPrice": "99.90",
        "createdAt": "2026-10-20T17:45:03.220Z",
        "updatedAt": "2026-10-20T17:45:03.220Z"
      },
      "eventDetail": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

**Errores**

Un parámetro repetido (`type=DISH&type=EVENT`) llega como array y da el mismo 400 que un valor inválido. `toSearch()` nunca repite parámetros.

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `property <param> should not exist` | Parámetro no declarado (p. ej. `foo=1` o `status=ACTIVE`). |
| 400 | `page must be an integer number` · `page must not be less than 1` · `page must not be greater than 1000000` | `page` no es entero (`2.5`, `abc`), está vacío (`page=` equivale a 0) o fuera de 1 a 1 000 000 (`1e30`). |
| 400 | `limit must be an integer number` · `limit must not be less than 1` · `limit must not be greater than 100` | Lo mismo con `limit` (de 1 a 100). |
| 400 | `type must be one of the following values: DISH, BEVERAGE, SERVICE, PROMOTION, EVENT` | Valor desconocido, vacío o repetido (`type=DISH&type=EVENT`). |
| 400 | `approvalStatus must be one of the following values: DRAFT, APPROVED, REJECTED` | Valor desconocido, vacío o repetido. |
| 400 | `isActive must be a boolean value` | Distinto de `true` o `false` (p. ej. `1`, `TRUE` o vacío). |
| 400 | `categoryId must be a UUID` | No es un UUID. |
| 400 | `search should not be empty` · `search must be shorter than or equal to 200 characters` · `search must be a string` | `search` vacío o solo con espacios, o de más de 200 caracteres. El tercero solo sale si se repite el parámetro. |
| 400 | `sort must be one of the following values: category, name, createdAt` | Otro criterio (p. ej. `price`). |
| 400 | `order must be one of the following values: asc, desc` | Otro valor (también `ASC` en mayúsculas). |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OWNER ni OPERATOR (p. ej. solo SUPPORT). |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**
- Orden según `sort`, todo en la dirección de `order` salvo los desempates fijos:
  - `createdAt` (por defecto): por `createdAt`, con desempate por `id` ascendente.
  - `name`: por `nameEs` y luego `nameEn` (los `null` al final), con desempate por `createdAt` descendente y después por `id` ascendente.
  - `category`: agrupa por categoría (`category.displayOrder`, nombres de la categoría y su `id`) y, dentro de cada una, ordena por `displayOrder`, `nameEs` y `nameEn` del elemento, con desempate final por `id` ascendente.
  - En los tres casos el orden es total: las páginas no se solapan ni se saltan elementos.
- `search` busca con `contains` sin distinguir mayúsculas, en los cuatro textos a la vez (OR). No ignora tildes: `cafe` no encuentra `Café`. No busca en el nombre de la categoría, en las variantes ni en `conditions`.
- Sin filtros devuelve todo: elementos inactivos, en `DRAFT` o `REJECTED` y de categorías inactivas. Cada elemento trae `internalNotes` y todos sus hijos, también las variantes inactivas.
- Selectores:
  - Solicitudes y reservas: usa `isActive=true&approvalStatus=APPROVED`. Crearlas, o cambiar su elemento, con otro responde 400 `El elemento comercial debe estar activo y aprobado` (ver [Crear solicitud de reserva](03-clientes-reservas.md#crear-solicitud-de-reserva) y [Crear reserva manual](03-clientes-reservas.md#crear-reserva-manual)). No hay filtro por categoría activa: revisa `category.isActive` si quieres ocultar esos elementos.
  - Intereses de clientes (`POST /customers/:id/interests`): sirve cualquier elemento existente, aunque esté inactivo o en borrador (ver [Registrar interés del cliente](03-clientes-reservas.md#registrar-interés-del-cliente)).
  - Con más de 100 elementos, pagina o usa `search`: `limit` no pasa de 100.
- `totalPages` es `ceil(total / limit)` (0 si no hay resultados). Una página fuera de rango devuelve `data: []` con el `total` real; `ServiciosView` ya ofrece volver a la primera página.
- No envíes parámetros vacíos (`search=`, `type=`): dan 400. `toSearch()` ya los omite, también los que solo tienen espacios.
- El listado trae cada elemento completo, con todos sus hijos: no hace falta pedir el detalle de cada fila.

## Ver detalle de un elemento comercial
`GET /commercial-items/:id`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `CommercialItem` |
| ft-crm | `catalogApi.item(id: string): Promise<CommercialItem>` — nueva. |
| Caché | `qk.item(id)` (nueva: `["commercial-items", "detail", id]`). |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | UUID de 8-4-4-4-12 caracteres hexadecimales, de cualquier versión. Si no lo es, 400 `Validation failed (uuid is expected)`. |

No admite query ni body.

**Respuesta**

```json
{
  "id": "6c8e0a2b-4d6f-4b8a-a0c2-e4f6a8b0c2d4",
  "type": "EVENT",
  "categoryId": "2d4f6a8c-0e1a-4c3e-b5a7-9c1e3a5c7e9a",
  "nameEs": "Noche criolla con música en vivo",
  "nameEn": "Creole night with live music",
  "descriptionEs": "Show de música criolla con menú degustación de cuatro tiempos.",
  "descriptionEn": null,
  "basePrice": "80.00",
  "displayOrder": 0,
  "isActive": true,
  "approvalStatus": "DRAFT",
  "conditions": "Reserva previa obligatoria.",
  "internalNotes": "Confirmar con la banda el día anterior.",
  "availabilityNote": "Cupos limitados.",
  "createdAt": "2026-10-25T19:30:12.045Z",
  "updatedAt": "2026-10-25T19:30:12.045Z",
  "category": {
    "id": "2d4f6a8c-0e1a-4c3e-b5a7-9c1e3a5c7e9a",
    "nameEs": "Eventos",
    "nameEn": "Events",
    "isActive": true,
    "displayOrder": 30
  },
  "variants": [
    {
      "id": "6f7a8b9c-0d1e-4f2a-b3c4-d5e6f7a8b9c0",
      "nameEs": "Mesa preferencial",
      "nameEn": "Front-row table",
      "descriptionEs": "Mesa frente al escenario.",
      "descriptionEn": null,
      "price": "120.00",
      "isActive": true,
      "displayOrder": 0,
      "createdAt": "2026-10-25T19:30:12.045Z",
      "updatedAt": "2026-10-25T19:30:12.045Z"
    }
  ],
  "images": [
    {
      "id": "7a8b9c0d-1e2f-4a3b-8c4d-e5f6a7b8c9d0",
      "url": "https://cdn.example.com/fogon-andino/noche-criolla.jpg",
      "altTextEs": "Músicos criollos en el escenario",
      "altTextEn": null,
      "isPrimary": false,
      "displayOrder": 0,
      "createdAt": "2026-10-25T19:30:12.045Z"
    }
  ],
  "faqs": [
    {
      "id": "8b9c0d1e-2f3a-4b4c-9d5e-f6a7b8c9d0e1",
      "questionEs": "¿Incluye bebidas?",
      "questionEn": null,
      "answerEs": "Incluye una copa de bienvenida.",
      "answerEn": null,
      "displayOrder": 0,
      "createdAt": "2026-10-25T19:30:12.045Z",
      "updatedAt": "2026-10-25T19:30:12.045Z"
    }
  ],
  "schedules": [
    {
      "id": "9c0d1e2f-3a4b-4c5d-ae6f-a7b8c9d0e1f2",
      "dayOfWeek": "SATURDAY",
      "isAvailable": true,
      "startTime": "20:00",
      "endTime": "01:00"
    }
  ],
  "promotionDetail": null,
  "eventDetail": {
    "id": "f0e1d2c3-b4a5-4968-8776-655443322110",
    "startAt": "2026-11-29T01:00:00.000Z",
    "endAt": "2026-11-29T06:00:00.000Z",
    "capacity": 60,
    "createdAt": "2026-10-25T19:30:12.045Z",
    "updatedAt": "2026-10-25T19:30:12.045Z"
  }
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OWNER ni OPERATOR. |
| 404 | `Elemento comercial no encontrado` | No existe ningún elemento con ese `id`. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**
- Tiene la misma forma que cada elemento del listado, con `internalNotes` y las variantes inactivas incluidas. Puedes sembrar `qk.item(id)` con el elemento del listado (`initialData`).
- Úsalo para precargar el editor. Al guardar, envía solo los campos modificados y los arrays completos que quieras reemplazar, sin los campos de solo lectura de cada hijo (`id`, `createdAt`, `updatedAt`). Ver [Editar elemento comercial](#editar-elemento-comercial).
- Solo un elemento `PROMOTION` puede tener `promotionDetail`, y solo un `EVENT` puede tener `eventDetail`. En el resto los dos son `null`.
- Los `id` de variantes, imágenes, FAQs y horarios cambian cada vez que un PATCH reemplaza ese array: no los guardes entre ediciones.

## Editar elemento comercial
`PATCH /commercial-items/:id`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `CommercialItem` |
| ft-crm | `catalogApi.update(id: string, body: UpdateCommercialItemRequest): Promise<CommercialItem>` — nueva. Hoy no hay editor de elementos. |
| Caché | `setQueryData(qk.item(id), respuesta)` e invalida `qk.itemsAll`. Si alguna pantalla muestra el resumen `commercialItem`, invalida también `qk.customersAll`, `qk.requestsAll` y `qk.reservationsAll`. |
| Límites | Body máx. 100 kb (413). |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | UUID del elemento. Si no lo es, 400 `Validation failed (uuid is expected)`. |

**Body**

Hay que enviar al menos un campo. Cada campo y cada hijo de `variants[]`, `images[]`, `faqs[]`, `schedules[]`, `promotionDetail` y `eventDetail` siguen las reglas de [Crear elemento comercial](#crear-elemento-comercial).

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `categoryId` | `Uuid` | No | Mueve el elemento a otra categoría. No admite `null`. Si se envía, aunque sea la misma, la categoría debe existir y estar activa. |
| `nameEs`, `nameEn` | string \| null | No | Omitido → se conserva; `null` → se borra. Debe quedar al menos uno de los dos. Sin `nameEs`, el elemento ya no se puede aprobar. |
| `descriptionEs`, `descriptionEn`, `conditions`, `internalNotes`, `availabilityNote` | string \| null | No | Omitido → se conserva; `null` → se borra. `""` da 400. |
| `basePrice` | `MoneyString` \| null | No | Omitido → se conserva; `null` → se borra. La regla de precio se evalúa con el resultado final. |
| `displayOrder` | integer | No | Entero de 0 a 1 000 000. No admite `null`. |
| `variants` | `CommercialItemVariantInput[]` | No | Reemplaza la lista completa (máx. 50). `[]` elimina todas. No admite `null`. |
| `images` | `CommercialItemImageInput[]` | No | Reemplaza la lista completa (máx. 20). `[]` elimina todas. No admite `null`. |
| `faqs` | `CommercialItemFaqInput[]` | No | Reemplaza la lista completa (máx. 50). `[]` elimina todas. No admite `null`. |
| `schedules` | `CommercialItemScheduleInput[]` | No | Reemplaza la lista completa (máx. 7, sin repetir días). `[]` elimina todos. No admite `null`. |
| `promotionDetail` | `CommercialPromotionDetailInput` \| null | No | Omitido → se conserva. `null` → se elimina (con cualquier `type`, sin error). Un objeto sustituye sus 3 campos: los que no envíes quedan en `null`. Solo con `type` `PROMOTION`. |
| `eventDetail` | `CommercialEventDetailInput` \| null | No | Igual que `promotionDetail`, solo con `type` `EVENT`. |
| `type`, `isActive`, `approvalStatus`, `id`, `category`, otros | — | Prohibido | 400 `property <campo> should not exist`. `type` no se puede cambiar; para el estado usa `/status` y para la aprobación `/approval`. |

**Ejemplo de petición**

Cambiar los precios de las variantes y desactivar una, borrar la nota interna y añadir la descripción en inglés:

```ts
const updated = await catalogApi.update("c2a4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f", {
  descriptionEn: "Beef heart skewers with golden potatoes and corn.",
  internalNotes: null,
  variants: [
    { nameEs: "Porción personal", nameEn: "Single portion", price: "27.00" },
    { nameEs: "Porción para compartir", nameEn: "Sharing portion", price: "48.00", isActive: false },
  ],
});
queryClient.setQueryData(qk.item(updated.id), updated);
await queryClient.invalidateQueries({ queryKey: qk.itemsAll });
```

`PATCH /api/backend/commercial-items/c2a4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f`:

```json
{
  "descriptionEn": "Beef heart skewers with golden potatoes and corn.",
  "internalNotes": null,
  "variants": [
    { "nameEs": "Porción personal", "nameEn": "Single portion", "price": "27.00" },
    { "nameEs": "Porción para compartir", "nameEn": "Sharing portion", "price": "48.00", "isActive": false }
  ]
}
```

Si partes del detalle del GET, quita los campos de solo lectura de cada hijo antes de enviarlo:

```ts
const toVariantInput = ({ id, createdAt, updatedAt, ...input }: CommercialItemVariant): CommercialItemVariantInput => input;
const body: UpdateCommercialItemRequest = { variants: item.variants.map(toVariantInput) };
```

**Respuesta**

```json
{
  "id": "c2a4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f",
  "type": "DISH",
  "categoryId": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
  "nameEs": "Anticuchos de corazón",
  "nameEn": "Beef heart skewers",
  "descriptionEs": "Brochetas de corazón de res con papas doradas y choclo.",
  "descriptionEn": "Beef heart skewers with golden potatoes and corn.",
  "basePrice": null,
  "displayOrder": 1,
  "isActive": true,
  "approvalStatus": "DRAFT",
  "conditions": "Sujeto a disponibilidad del día.",
  "internalNotes": null,
  "availabilityNote": "Solo turno noche.",
  "createdAt": "2026-11-03T02:32:11.984Z",
  "updatedAt": "2026-11-03T15:47:20.416Z",
  "category": {
    "id": "3f6b1e2a-8c4d-4f7a-9b2e-5d1c0a9e8f71",
    "nameEs": "Parrillas",
    "nameEn": "Grills",
    "isActive": true,
    "displayOrder": 10
  },
  "variants": [
    {
      "id": "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b",
      "nameEs": "Porción personal",
      "nameEn": "Single portion",
      "descriptionEs": null,
      "descriptionEn": null,
      "price": "27.00",
      "isActive": true,
      "displayOrder": 0,
      "createdAt": "2026-11-03T15:47:20.416Z",
      "updatedAt": "2026-11-03T15:47:20.416Z"
    },
    {
      "id": "f2a3b4c5-d6e7-4f8a-9b0c-1d2e3f4a5b6c",
      "nameEs": "Porción para compartir",
      "nameEn": "Sharing portion",
      "descriptionEs": null,
      "descriptionEn": null,
      "price": "48.00",
      "isActive": false,
      "displayOrder": 1,
      "createdAt": "2026-11-03T15:47:20.416Z",
      "updatedAt": "2026-11-03T15:47:20.416Z"
    }
  ],
  "images": [
    {
      "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "url": "https://cdn.example.com/fogon-andino/anticuchos.jpg",
      "altTextEs": "Anticuchos en plato de barro",
      "altTextEn": null,
      "isPrimary": true,
      "displayOrder": 0,
      "createdAt": "2026-11-03T02:32:11.984Z"
    }
  ],
  "faqs": [
    {
      "id": "b5c6d7e8-f9a0-4b1c-9d2e-3f4a5b6c7d8e",
      "questionEs": "¿Es picante?",
      "questionEn": null,
      "answerEs": "El ají se sirve aparte.",
      "answerEn": null,
      "displayOrder": 0,
      "createdAt": "2026-11-03T02:32:11.984Z",
      "updatedAt": "2026-11-03T02:32:11.984Z"
    }
  ],
  "schedules": [
    {
      "id": "d9e8f7a6-b5c4-4d3e-8f2a-1b0c9d8e7f6a",
      "dayOfWeek": "FRIDAY",
      "isAvailable": true,
      "startTime": "18:00",
      "endTime": "23:30"
    },
    {
      "id": "c8d7e6f5-a4b3-4c2d-9e1f-0a9b8c7d6e5f",
      "dayOfWeek": "SUNDAY",
      "isAvailable": false,
      "startTime": null,
      "endTime": null
    }
  ],
  "promotionDetail": null,
  "eventDetail": null
}
```

**Errores**

Orden de las comprobaciones: sesión y rol; UUID y DTO; body vacío; después, en una transacción, existencia, categoría, nombres, variantes, regla de precio, tipo de detalle, imágenes, horarios y fechas de los detalles.

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | Mensajes de validación de [Crear elemento comercial](#crear-elemento-comercial) | Los mismos, salvo los de `type`, que aquí es un campo prohibido. Casos típicos: `categoryId: null` → `categoryId must be a UUID`; `displayOrder: null` → los tres de `displayOrder`; `variants: null` → `variants must be an array`…; `schedules: [null]` → `schedules.each value in nested property schedules must be either object or array`. |
| 400 | `property <campo> should not exist` | `type`, `isActive`, `approvalStatus`, `id` u otro campo no declarado; o hijos reenviados con `id`, `createdAt` o `updatedAt` (`variants.<i>.property id should not exist`, `promotionDetail.property id should not exist`…). |
| 400 | `Debes proporcionar al menos un campo para actualizar` | El body es `{}`. Se comprueba antes de buscar el elemento: con un `id` inexistente también da 400. |
| 400 | `La categoría comercial no existe` · `La categoría comercial está inactiva` | Se envió `categoryId` de una categoría inexistente o inactiva (también si es la actual). |
| 400 | `El elemento comercial debe tener al menos un nombre en español o inglés` | El cambio dejaría el elemento sin nombres. |
| 400 | `Cada variante debe tener al menos un nombre en español o inglés` · `Las variantes no pueden duplicarse` | El array `variants` enviado incumple sus reglas. |
| 400 | `Un plato o bebida debe tener un precio base o variantes activas, pero no ambos` | En un `DISH` o `BEVERAGE`, el resultado queda sin precio o con los dos mecanismos. Cuenta el `basePrice` final y las variantes activas finales (las enviadas o, si no envías `variants`, las actuales). |
| 400 | `promotionDetail solo corresponde a elementos PROMOTION` · `eventDetail solo corresponde a elementos EVENT` | Se envió un detalle como objeto que no corresponde al `type` del elemento. |
| 400 | `Las imágenes no pueden duplicarse` · `Un elemento comercial solo puede tener una imagen principal` | El array `images` enviado incumple sus reglas. |
| 400 | `No puede repetirse un día en los horarios del elemento` · `Los horarios comerciales son incoherentes` | Respaldo del servicio; el DTO rechaza antes esos casos. |
| 400 | `validFrom no puede ser posterior a validUntil` · `startAt no puede ser posterior a endAt` | El detalle enviado tiene el rango invertido. |
| 400 | `validFrom debe ser una fecha válida` · `validUntil debe ser una fecha válida` · `startAt debe ser una fecha válida` · `endAt debe ser una fecha válida` | Respaldo del servicio; el DTO rechaza antes las fechas inválidas. |
| 400 | `La operación contiene referencias o valores comerciales inválidos` | Defensivo: solo con una clave foránea rota (Prisma P2003). El servicio comprueba antes la categoría en la misma transacción, y una restricción `CHECK` llega como 500, no aquí. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (OWNER, OPERATOR o SUPPORT). |
| 404 | `Elemento comercial no encontrado` | No existe ningún elemento con ese `id`. |
| 409 | `La operación contiene datos comerciales duplicados` | La base de datos rechaza un duplicado (Prisma P2002). Respaldo: el servicio detecta antes los duplicados. |
| 409 | `La operación comercial entró en conflicto; inténtalo nuevamente` | Conflicto con otra escritura simultánea que siguió tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | Body de más de 100 kb. |
| 500 | `Ocurrió un error interno` | El nombre enviado que se normaliza (`nameEs`, o `nameEn` si falta, del elemento o de una variante) está formado solo por signos diacríticos sueltos y espacios (p. ej. `^`, `` ` `` o `´`): su forma normalizada queda vacía y la base de datos la rechaza (restricción `CHECK`). |

**Efectos**
- **Vuelta a borrador:** si el elemento estaba `APPROVED`, cualquier PATCH exitoso lo deja en `DRAFT`, aunque solo cambie `displayOrder`. Los que estaban en `DRAFT` o `REJECTED` conservan su estado. Hasta que se vuelva a aprobar, deja de llegar a Samanta y no se puede elegir en solicitudes o reservas nuevas. Las solicitudes y reservas que ya lo tienen lo conservan.
- **Campos simples:** se actualizan solo los enviados. `updatedAt` cambia siempre.
- **Arrays:** cada array enviado se reemplaza entero. Se borran todos los registros anteriores de ese tipo y se crean los enviados, con `id`, `createdAt` y `updatedAt` nuevos. Los arrays que no envías no cambian.
- **Detalles:** un objeto actualiza el registro existente (conserva su `id` y su `createdAt`) o lo crea si no existe. `null` lo elimina.
- Todo ocurre en una sola transacción serializable: si falla una parte, no se guarda nada.
- Si el elemento estaba entre los que ve Samanta, los borradores pendientes quedan desactualizados (pasan a `STALE`; ver [Generar un borrador con Samanta](04-bandeja-samanta.md#generar-un-borrador-con-samanta)).

**Notas para el frontend**
- Antes de guardar un elemento `APPROVED`, avisa de que volverá a `DRAFT` y ofrece aprobarlo de nuevo al terminar.
- Envía solo los campos modificados. `null` borra; `""` da 400. `categoryId` y `displayOrder` no admiten `null`.
- Para editar una sola variante, imagen, FAQ u horario, reenvía el array completo con el cambio: no hay endpoints para hijos sueltos.
- La regla de precio se evalúa con el estado final. Para pasar un `DISH` de precio base a variantes, envía en la misma petición `{ "basePrice": null, "variants": [...] }`.
- Envía `categoryId` solo si cambió. Si la categoría actual está inactiva y la reenvías, da 400. Sin `categoryId`, el elemento se puede editar aunque su categoría esté inactiva.
- `type` no se puede cambiar: para otro tipo, crea un elemento nuevo.
- Un body `{}` responde 400 y no toca el elemento ni su aprobación.
- No hay control de concurrencia: si dos ADMIN editan a la vez, gana el último en guardar.

## Activar o desactivar un elemento comercial
`PATCH /commercial-items/:id/status`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `CommercialItem` |
| ft-crm | `catalogApi.setActive(id: string, isActive: boolean): Promise<CommercialItem>` — existe. La usa el interruptor de `ServiciosView` con actualización optimista. |
| Caché | `setQueryData(qk.item(id), respuesta)` e invalida `qk.itemsAll`. `ServiciosView` parchea la página (`patchItemInPage`), la reemplaza con la respuesta y refresca `qk.itemsAll` cuando termina el último cambio pendiente. |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | UUID del elemento. Si no lo es, 400 `Validation failed (uuid is expected)`. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `isActive` | boolean | Sí | Booleano JSON (`"false"` → 400). |
| Cualquier otro campo | — | Prohibido | 400 `property <campo> should not exist`. |

**Ejemplo de petición**

```ts
const item = await catalogApi.setActive("1c3e5a7b-9d1f-4b3d-8f5a-7c9e1b3d5f7a", false);
```

`PATCH /api/backend/commercial-items/1c3e5a7b-9d1f-4b3d-8f5a-7c9e1b3d5f7a/status`:

```json
{ "isActive": false }
```

**Respuesta**

```json
{
  "id": "1c3e5a7b-9d1f-4b3d-8f5a-7c9e1b3d5f7a",
  "type": "SERVICE",
  "categoryId": "8e0a2c4d-6f8b-4d0e-a2c4-6e8a0c2e4a6c",
  "nameEs": "Decoración de cumpleaños",
  "nameEn": "Birthday decoration",
  "descriptionEs": "Globos, mantel temático y postre con vela para la mesa.",
  "descriptionEn": null,
  "basePrice": "60.00",
  "displayOrder": 0,
  "isActive": false,
  "approvalStatus": "APPROVED",
  "conditions": "Solicitar con 24 horas de anticipación.",
  "internalNotes": "Proveedor externo de globos; confirmar por WhatsApp.",
  "availabilityNote": null,
  "createdAt": "2026-10-10T14:22:31.778Z",
  "updatedAt": "2026-11-03T02:32:11.984Z",
  "category": {
    "id": "8e0a2c4d-6f8b-4d0e-a2c4-6e8a0c2e4a6c",
    "nameEs": "Servicios",
    "nameEn": "Services",
    "isActive": true,
    "displayOrder": 40
  },
  "variants": [
    {
      "id": "2e4a6c8e-0a2c-4e6a-8c0e-2a4c6e8a0c2e",
      "nameEs": "Paquete premium",
      "nameEn": "Premium package",
      "descriptionEs": "Incluye arreglo floral y torta pequeña.",
      "descriptionEn": null,
      "price": "95.00",
      "isActive": true,
      "displayOrder": 0,
      "createdAt": "2026-10-10T14:22:31.778Z",
      "updatedAt": "2026-10-10T14:22:31.778Z"
    }
  ],
  "images": [
    {
      "id": "3a5c7e9a-1c3e-4a7c-9e1a-3c5e7a9c1e3a",
      "url": "https://cdn.example.com/fogon-andino/decoracion-cumple.jpg",
      "altTextEs": "Mesa decorada con globos",
      "altTextEn": "Table decorated with balloons",
      "isPrimary": true,
      "displayOrder": 0,
      "createdAt": "2026-10-10T14:22:31.778Z"
    }
  ],
  "faqs": [
    {
      "id": "4c6e8a0c-2e4a-4c8e-a0c2-4e6a8c0e2a4c",
      "questionEs": "¿Puedo traer mi propia torta?",
      "questionEn": null,
      "answerEs": "Sí, sin costo adicional.",
      "answerEn": null,
      "displayOrder": 0,
      "createdAt": "2026-10-10T14:22:31.778Z",
      "updatedAt": "2026-10-10T14:22:31.778Z"
    }
  ],
  "schedules": [
    {
      "id": "5e7a9c1e-3a5c-4e9a-b1c3-5a7c9e1a3c5e",
      "dayOfWeek": "SATURDAY",
      "isAvailable": true,
      "startTime": "12:00",
      "endTime": "22:00"
    }
  ],
  "promotionDetail": null,
  "eventDetail": null
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `isActive must be a boolean value` | Falta `isActive` o no es un booleano JSON. |
| 400 | `property <campo> should not exist` | Se enviaron otros campos (p. ej. `approvalStatus`). |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (OWNER, OPERATOR o SUPPORT). |
| 404 | `Elemento comercial no encontrado` | No existe ningún elemento con ese `id`. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | Body de más de 100 kb. |

**Efectos**
- Cambia `isActive` y `updatedAt`. No cambia `approvalStatus`, el contenido ni los hijos.
- Inactivo, el elemento deja de llegar a Samanta (los borradores pendientes que lo incluían quedan desactualizados) y no se puede elegir en solicitudes o reservas nuevas: 400 `El elemento comercial debe estar activo y aprobado`. Las que ya lo tienen lo conservan.
- Activar un elemento `APPROVED` de una categoría activa lo vuelve a poner en la lista de Samanta: si entra entre los 30 que ve, también deja desactualizados los borradores pendientes.
- Se puede seguir registrando como interés de un cliente.

**Notas para el frontend**
- Es idempotente: repetir el mismo valor no da error (aunque `updatedAt` cambia).
- No existe borrado de elementos: desactivarlo es la forma de retirarlo.
- Se puede activar un elemento de una categoría inactiva, pero Samanta no lo verá hasta reactivar la categoría.
- Ignora los clics repetidos mientras hay un cambio en curso para el mismo elemento (`ServiciosView` ya lo hace) y revierte el cambio optimista si falla.

## Cambiar la aprobación de un elemento comercial
`PATCH /commercial-items/:id/approval`

| | |
|---|---|
| Roles | ADMIN |
| Respuesta | 200 · `CommercialItem` |
| ft-crm | `catalogApi.setApproval(id: string, approvalStatus: CommercialApprovalStatus): Promise<CommercialItem>` — existe. `ServiciosView` solo la usa para aprobar (botón «Aprobar» en elementos `DRAFT` o `REJECTED`). |
| Caché | `setQueryData(qk.item(id), respuesta)` e invalida `qk.itemsAll`. `ServiciosView` reemplaza el elemento en la página (`replaceItemInPage`) y refresca `qk.itemsAll`. |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | UUID del elemento. Si no lo es, 400 `Validation failed (uuid is expected)`. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `approvalStatus` | `CommercialApprovalStatus` | Sí | `DRAFT`, `APPROVED` o `REJECTED`, en mayúsculas. |
| Cualquier otro campo | — | Prohibido | 400 `property <campo> should not exist` (no hay campo de motivo). |

**Ejemplo de petición**

```ts
const item = await catalogApi.setApproval("1c3e5a7b-9d1f-4b3d-8f5a-7c9e1b3d5f7a", "APPROVED");
```

`PATCH /api/backend/commercial-items/1c3e5a7b-9d1f-4b3d-8f5a-7c9e1b3d5f7a/approval`:

```json
{ "approvalStatus": "APPROVED" }
```

**Respuesta**

```json
{
  "id": "1c3e5a7b-9d1f-4b3d-8f5a-7c9e1b3d5f7a",
  "type": "SERVICE",
  "categoryId": "8e0a2c4d-6f8b-4d0e-a2c4-6e8a0c2e4a6c",
  "nameEs": "Decoración de cumpleaños",
  "nameEn": "Birthday decoration",
  "descriptionEs": "Globos, mantel temático y postre con vela para la mesa.",
  "descriptionEn": null,
  "basePrice": "60.00",
  "displayOrder": 0,
  "isActive": true,
  "approvalStatus": "APPROVED",
  "conditions": "Solicitar con 24 horas de anticipación.",
  "internalNotes": "Proveedor externo de globos; confirmar por WhatsApp.",
  "availabilityNote": null,
  "createdAt": "2026-10-10T14:22:31.778Z",
  "updatedAt": "2026-10-12T10:03:47.150Z",
  "category": {
    "id": "8e0a2c4d-6f8b-4d0e-a2c4-6e8a0c2e4a6c",
    "nameEs": "Servicios",
    "nameEn": "Services",
    "isActive": true,
    "displayOrder": 40
  },
  "variants": [
    {
      "id": "2e4a6c8e-0a2c-4e6a-8c0e-2a4c6e8a0c2e",
      "nameEs": "Paquete premium",
      "nameEn": "Premium package",
      "descriptionEs": "Incluye arreglo floral y torta pequeña.",
      "descriptionEn": null,
      "price": "95.00",
      "isActive": true,
      "displayOrder": 0,
      "createdAt": "2026-10-10T14:22:31.778Z",
      "updatedAt": "2026-10-10T14:22:31.778Z"
    }
  ],
  "images": [
    {
      "id": "3a5c7e9a-1c3e-4a7c-9e1a-3c5e7a9c1e3a",
      "url": "https://cdn.example.com/fogon-andino/decoracion-cumple.jpg",
      "altTextEs": "Mesa decorada con globos",
      "altTextEn": "Table decorated with balloons",
      "isPrimary": true,
      "displayOrder": 0,
      "createdAt": "2026-10-10T14:22:31.778Z"
    }
  ],
  "faqs": [
    {
      "id": "4c6e8a0c-2e4a-4c8e-a0c2-4e6a8c0e2a4c",
      "questionEs": "¿Puedo traer mi propia torta?",
      "questionEn": null,
      "answerEs": "Sí, sin costo adicional.",
      "answerEn": null,
      "displayOrder": 0,
      "createdAt": "2026-10-10T14:22:31.778Z",
      "updatedAt": "2026-10-10T14:22:31.778Z"
    }
  ],
  "schedules": [
    {
      "id": "5e7a9c1e-3a5c-4e9a-b1c3-5a7c9e1a3c5e",
      "dayOfWeek": "SATURDAY",
      "isAvailable": true,
      "startTime": "12:00",
      "endTime": "22:00"
    }
  ],
  "promotionDetail": null,
  "eventDetail": null
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `approvalStatus must be one of the following values: DRAFT, APPROVED, REJECTED` | Falta, es otro valor o va en minúsculas. |
| 400 | `property <campo> should not exist` | Se enviaron otros campos (p. ej. `isActive` o un motivo). |
| 400 | `El elemento necesita un nombre en español antes de aprobarse` | Se pide `APPROVED` y el elemento no tiene `nameEs`. |
| 400 | `No se puede aprobar un elemento de una categoría inactiva` | Se pide `APPROVED` y la categoría está desactivada. |
| 400 | `Un plato o bebida debe tener un precio base o variantes activas, pero no ambos` | Se pide `APPROVED` para un `DISH` o `BEVERAGE` que incumple la regla de precio. Con datos guardados por la API no ocurre: crear y editar ya aplican la regla. |
| 400 | `La operación contiene referencias o valores comerciales inválidos` | No ocurre: el servicio lo reserva para Prisma P2003 o P2004, este cambio no toca claves foráneas y Prisma 7 ya no emite P2004. |
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN (OWNER, OPERATOR o SUPPORT). |
| 404 | `Elemento comercial no encontrado` | No existe ningún elemento con ese `id`. |
| 409 | `La operación contiene datos comerciales duplicados` | La base de datos rechaza un duplicado (Prisma P2002). No debería ocurrir: este cambio no crea registros. |
| 409 | `La operación comercial entró en conflicto; inténtalo nuevamente` | Conflicto con otra escritura simultánea que siguió tras 3 intentos. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | Body de más de 100 kb. |

**Efectos**
- Cambia `approvalStatus` y `updatedAt`. No cambia `isActive` ni el contenido.
- `APPROVED` + `isActive: true`: el elemento se puede elegir en solicitudes y reservas. Si además su categoría está activa, Samanta puede recibirlo (ver [Estados y transiciones](#estados-y-transiciones)).
- Pasar un elemento que Samanta veía a `DRAFT` o `REJECTED`, o aprobar uno nuevo que entra en su lista, deja desactualizados los borradores pendientes.
- No guarda quién aprobó o rechazó, ni cuándo, ni por qué.

**Notas para el frontend**
- Se permite cualquier transición entre `DRAFT`, `APPROVED` y `REJECTED`, en cualquier orden, sin flujo obligatorio. Repetir el mismo valor no da error.
- Solo `APPROVED` tiene requisitos (`nameEs`, categoría activa y, en `DISH` y `BEVERAGE`, la regla de precio), y se comprueban cada vez: reaprobar un elemento ya aprobado cuya categoría se desactivó da 400.
- No depende de `isActive`: se puede aprobar un elemento inactivo, pero no será usable hasta activarlo.
- El catálogo inicial del seed (86 elementos en `DRAFT`) tiene 9 elementos sin `nameEs`. Para aprobarlos, primero añade el nombre con `PATCH /commercial-items/:id`. Muestra el 400 junto a la acción «Aprobar» y ofrece editar el nombre.
- Samanta recibe como máximo 30 elementos activos y aprobados de categorías activas, ordenados por el `displayOrder` del elemento y después por `id`, sin importar la categoría. Usa `displayOrder` bajo para lo que deba ver primero.
- Para rechazar o devolver a borrador, añade acciones que llamen a `setApproval(id, "REJECTED")` o `setApproval(id, "DRAFT")`. Hoy `ServiciosView` solo aprueba.
- Cualquier edición posterior con `PATCH /commercial-items/:id` devuelve el elemento a `DRAFT`.

## Modelos

Todas las fechas son instantes ISO 8601 en UTC con milisegundos (`"2026-11-03T16:42:08.215Z"`). Todos los campos llegan siempre: los vacíos vienen en `null`, nunca omitidos.

### `RestaurantConfig`

Lo devuelven `GET` y `PUT /restaurant-config`.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Identificador de la configuración global. No cambia entre PUT. |
| `businessName` | string | No | Nombre comercial (hasta 150). |
| `logoUrl` | string | Sí | URL del logo (http/https). |
| `description` | string | Sí | Descripción del negocio (hasta 2000). Samanta la recibe. |
| `address` | string | No | Dirección (hasta 300). |
| `latitude` | number | Sí | Latitud con hasta 7 decimales. `null` junto con `longitude`. |
| `longitude` | number | Sí | Longitud con hasta 7 decimales. |
| `whatsappNumber` | string | No | Número del negocio en E.164 (`+51987654321`). Solo informativo. |
| `ownerWhatsappNumber` | string | Sí | Desde el 10/11: WhatsApp personal del propietario en E.164, al que se envían las solicitudes para aprobar ([03 › Envío al WhatsApp del propietario](03-clientes-reservas.md#envío-al-whatsapp-del-propietario)). `null` si no está configurado. |
| `email` | string | No | Correo de contacto, en minúsculas. |
| `website` | string | Sí | Sitio web (http/https). |
| `currency` | `CurrencyCode` | No | Moneda del restaurante. |
| `timeZone` | string | No | Zona IANA en la que se muestran las fechas. |
| `reservationPolicy` | string | No | Política de reservas (hasta 5000). |
| `cancellationPolicy` | string | No | Política de cancelación (hasta 5000). |
| `responseTimeoutMinutes` | number | No | Entero de 1 a 1440. Hoy solo se guarda. |
| `approvalResponsibleId` | `Uuid` | Sí | Usuario OWNER responsable de aprobaciones. Hoy solo se guarda. |
| `approvalResponsible` | `ApprovalResponsible` | Sí | Datos públicos de ese usuario; `null` si no hay responsable. |
| `languages` | `LanguageCode[]` | No | De 1 a 3 idiomas, en orden `ES`, `EN`, `PT`. |
| `schedules` | `RestaurantSchedule[]` | No | Horario semanal: 7 entradas, de `MONDAY` a `SUNDAY`. |
| `createdAt` | `IsoDateTime` | No | Primera vez que se guardó. |
| `updatedAt` | `IsoDateTime` | No | Último PUT. |

`ApprovalResponsible`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del usuario. |
| `firstName` | string | No | Nombre. |
| `lastName` | string | No | Apellido. |
| `email` | string | No | Correo de acceso del usuario. |

`RestaurantSchedule`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `dayOfWeek` | `DayOfWeek` | No | Día. |
| `isOpen` | boolean | No | Si el restaurante abre ese día. |
| `openTime` | `HhMm` | Sí | Apertura; `null` si el día está cerrado. |
| `closeTime` | `HhMm` | Sí | Cierre, posterior a `openTime` el mismo día; `null` si el día está cerrado. |

### `CommercialCategory`

La devuelven todas las rutas de `/commercial-categories`.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Identificador. |
| `nameEs` | string | Sí | Nombre en español. Al menos uno de los dos nombres tiene valor. |
| `nameEn` | string | Sí | Nombre en inglés. |
| `descriptionEs` | string | Sí | Descripción en español. |
| `descriptionEn` | string | Sí | Descripción en inglés. |
| `isActive` | boolean | No | Si admite elementos nuevos y aprobaciones y si Samanta ve sus elementos. |
| `displayOrder` | number | No | Orden de presentación (0 a 1 000 000; menor primero). |
| `createdAt` | `IsoDateTime` | No | Alta. |
| `updatedAt` | `IsoDateTime` | No | Último cambio. |

### `CommercialItem`

Lo devuelven `POST`, `GET`, `GET /:id` y los tres `PATCH` de `/commercial-items`, siempre con todos sus hijos.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Identificador. |
| `type` | `CommercialItemType` | No | Tipo. No cambia nunca. |
| `categoryId` | `Uuid` | No | Categoría a la que pertenece. |
| `nameEs` | string | Sí | Nombre en español. Obligatorio para aprobar. |
| `nameEn` | string | Sí | Nombre en inglés. Al menos uno de los dos tiene valor. |
| `descriptionEs` | string | Sí | Descripción en español. |
| `descriptionEn` | string | Sí | Descripción en inglés. |
| `basePrice` | `MoneyString` | Sí | Precio base con 2 decimales. |
| `displayOrder` | number | No | Orden dentro de la categoría y para Samanta (menor primero). |
| `isActive` | boolean | No | Si está a la venta. |
| `approvalStatus` | `CommercialApprovalStatus` | No | Estado de aprobación. |
| `conditions` | string | Sí | Condiciones comerciales. Samanta las recibe. |
| `internalNotes` | string | Sí | Nota interna del equipo. Samanta no la recibe. |
| `availabilityNote` | string | Sí | Nota de disponibilidad. Samanta la recibe. |
| `createdAt` | `IsoDateTime` | No | Alta. |
| `updatedAt` | `IsoDateTime` | No | Último cambio (también de estado o de aprobación). |
| `category` | `CommercialItemCategorySummary` | No | Resumen de la categoría. |
| `variants` | `CommercialItemVariant[]` | No | Todas las variantes, también las inactivas, por `displayOrder` y `createdAt`. `[]` si no hay. |
| `images` | `CommercialItemImage[]` | No | Imágenes por `displayOrder` y `createdAt`. |
| `faqs` | `CommercialItemFaq[]` | No | Preguntas frecuentes por `displayOrder` y `createdAt`. |
| `schedules` | `CommercialItemSchedule[]` | No | Solo los días configurados, de `MONDAY` a `SUNDAY`. |
| `promotionDetail` | `CommercialPromotionDetail` | Sí | Solo puede existir en `PROMOTION`. |
| `eventDetail` | `CommercialEventDetail` | Sí | Solo puede existir en `EVENT`. |

`CommercialItemCategorySummary`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id de la categoría. |
| `nameEs` | string | Sí | Nombre en español. |
| `nameEn` | string | Sí | Nombre en inglés. |
| `isActive` | boolean | No | Si la categoría está activa. |
| `displayOrder` | number | No | Orden de la categoría. |

`CommercialItemVariant`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Cambia cada vez que un PATCH reemplaza las variantes. |
| `nameEs` | string | Sí | Nombre en español. Al menos uno de los dos tiene valor. |
| `nameEn` | string | Sí | Nombre en inglés. |
| `descriptionEs` | string | Sí | Descripción en español. |
| `descriptionEn` | string | Sí | Descripción en inglés. |
| `price` | `MoneyString` | No | Precio con 2 decimales. |
| `isActive` | boolean | No | Solo las activas cuentan para la regla de precio y llegan a Samanta. |
| `displayOrder` | number | No | Orden. |
| `createdAt` | `IsoDateTime` | No | Alta (la del último reemplazo). |
| `updatedAt` | `IsoDateTime` | No | Último cambio. |

`CommercialItemImage`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Cambia con cada reemplazo de `images`. |
| `url` | string | No | URL de la imagen. |
| `altTextEs` | string | Sí | Texto alternativo en español. |
| `altTextEn` | string | Sí | Texto alternativo en inglés. |
| `isPrimary` | boolean | No | Imagen principal; como máximo una por elemento. |
| `displayOrder` | number | No | Orden. |
| `createdAt` | `IsoDateTime` | No | Alta. Las imágenes no tienen `updatedAt`. |

`CommercialItemFaq`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Cambia con cada reemplazo de `faqs`. |
| `questionEs` | string | No | Pregunta en español. |
| `questionEn` | string | Sí | Pregunta en inglés. |
| `answerEs` | string | No | Respuesta en español. |
| `answerEn` | string | Sí | Respuesta en inglés. |
| `displayOrder` | number | No | Orden. |
| `createdAt` | `IsoDateTime` | No | Alta. |
| `updatedAt` | `IsoDateTime` | No | Último cambio. |

`CommercialItemSchedule`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Cambia con cada reemplazo de `schedules`. |
| `dayOfWeek` | `DayOfWeek` | No | Día, único por elemento. |
| `isAvailable` | boolean | No | Si el elemento está disponible ese día. |
| `startTime` | `HhMm` | Sí | Inicio; `null` si no está disponible. |
| `endTime` | `HhMm` | Sí | Fin; puede ser anterior a `startTime` (cruza la medianoche). `null` si no está disponible. |

`CommercialPromotionDetail`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Se conserva al actualizar el detalle con un objeto. |
| `validFrom` | `IsoDateTime` | Sí | Inicio de la vigencia. |
| `validUntil` | `IsoDateTime` | Sí | Fin de la vigencia (igual o posterior a `validFrom`). |
| `promotionalPrice` | `MoneyString` | Sí | Precio promocional con 2 decimales. |
| `createdAt` | `IsoDateTime` | No | Alta del detalle. |
| `updatedAt` | `IsoDateTime` | No | Último cambio del detalle. |

`CommercialEventDetail`:

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Se conserva al actualizar el detalle con un objeto. |
| `startAt` | `IsoDateTime` | Sí | Inicio del evento. |
| `endAt` | `IsoDateTime` | Sí | Fin del evento (igual o posterior a `startAt`). |
| `capacity` | number | Sí | Aforo (1 a 1 000 000). Samanta no lo recibe. |
| `createdAt` | `IsoDateTime` | No | Alta del detalle. |
| `updatedAt` | `IsoDateTime` | No | Último cambio del detalle. |

El backend no expone `sourceKey` ni los nombres normalizados (`normalizedNameEs`, `normalizedNameEn`, `normalizedName`) que guarda en la base de datos.

## Estados y transiciones

### `CommercialApprovalStatus` (elemento comercial)

| Valor | Significado |
|---|---|
| `DRAFT` | Borrador. Estado inicial y estado al que vuelve un elemento aprobado cuando se edita. No llega a Samanta ni se puede elegir en solicitudes o reservas. |
| `APPROVED` | Aprobado. Con `isActive: true` se puede elegir en solicitudes y reservas; si además la categoría está activa, Samanta puede recibirlo. |
| `REJECTED` | Rechazado. Mismo efecto que `DRAFT`; solo informa de la decisión. |

Transiciones manuales, con `PATCH /commercial-items/:id/approval` (solo ADMIN):

| Desde | Hacia | Condiciones |
|---|---|---|
| Cualquiera | `APPROVED` | `nameEs` con texto, categoría activa y, en `DISH` o `BEVERAGE`, la regla de precio. Se comprueban también al reaprobar. |
| Cualquiera | `DRAFT` o `REJECTED` | Ninguna. |

Transiciones automáticas:

| Cuándo | Cambio |
|---|---|
| `POST /commercial-items` | Nace en `DRAFT`. |
| `PATCH /commercial-items/:id` con éxito | `APPROVED` → `DRAFT`. `DRAFT` y `REJECTED` no cambian. Un body `{}` (400) no cambia nada. |

Errores de una transición no permitida (400): `El elemento necesita un nombre en español antes de aprobarse`, `No se puede aprobar un elemento de una categoría inactiva` y `Un plato o bebida debe tener un precio base o variantes activas, pero no ambos`.

Ni `PATCH /commercial-items/:id/status` ni los cambios de la categoría alteran `approvalStatus`.

### `isActive` del elemento

| Valor | Significado |
|---|---|
| `true` | A la venta. Valor inicial al crearlo. |
| `false` | Retirado: no llega a Samanta ni se puede elegir en solicitudes o reservas nuevas. Es la forma de «borrar» (no hay `DELETE`). |

Se cambia solo con `PATCH /commercial-items/:id/status` (ADMIN), en cualquier sentido y sin condiciones. No hay cambios automáticos.

### `isActive` de la categoría

| Valor | Significado |
|---|---|
| `true` | Valor inicial. Admite elementos nuevos y aprobaciones. |
| `false` | No admite elementos nuevos ni que se muevan a ella (400 `La categoría comercial está inactiva`), no deja aprobar sus elementos (400 `No se puede aprobar un elemento de una categoría inactiva`) y Samanta deja de ver sus elementos. |

Se cambia solo con `PATCH /commercial-categories/:id/status` (ADMIN), sin condiciones. No modifica el `isActive` ni el `approvalStatus` de sus elementos.

### Quién puede usar cada elemento

| Elemento | Categoría | Samanta | Solicitudes y reservas (crear o cambiar el elemento) | Intereses de clientes |
|---|---|---|---|---|
| Activo y `APPROVED` | Activa | Sí, si entra entre los 30 primeros por `displayOrder` e `id` | Sí | Sí |
| Activo y `APPROVED` | Inactiva | No | Sí | Sí |
| Inactivo, `DRAFT` o `REJECTED` | Cualquiera | No | No: 400 `El elemento comercial debe estar activo y aprobado` | Sí |

Las solicitudes y reservas que ya tienen un elemento lo conservan aunque después se desactive o deje de estar aprobado.

### Configuración del restaurante

No tiene estados: existe (200) o no existe (404). El primer `PUT /restaurant-config` la crea y ya no se puede borrar. Mientras no existe, crear solicitudes o reservas y usar Samanta responden 409.

## Preguntas abiertas

1. **Imágenes y logo:** la API solo acepta URLs `http(s)` de imágenes ya alojadas y no hay endpoint de subida. ¿Dónde y cómo alojará el frontend esas imágenes?
2. **Auditoría de la aprobación:** no se guarda quién aprobó o rechazó un elemento, cuándo ni por qué (está como `TODO` en el servicio). ¿La pantalla de aprobación necesita esa información?
3. **Búsqueda sin tildes:** `GET /commercial-items?search=` usa `contains` sin distinguir mayúsculas (ILIKE), pero sí distingue tildes: `cafe` no encuentra `Café`. ¿Se necesita una búsqueda insensible a tildes?
4. **Categorías inactivas en solicitudes y reservas:** desactivar una categoría oculta sus elementos a Samanta e impide aprobarlos, pero las solicitudes y reservas siguen aceptando sus elementos activos y aprobados. ¿Es intencional, o el backend también debería rechazarlos?
5. **Qué elementos ve Samanta:** recibe como máximo 30 elementos (por `displayOrder` e `id`, sin agrupar por categoría), con hasta 10 variantes activas y 10 FAQs cada uno. Ninguna ruta indica cuáles entran. ¿Se expondrá esa lista o un aviso de que el catálogo supera el límite?
6. **Campos sin uso:** `responseTimeoutMinutes` se guarda, pero ningún proceso del backend lo usa; `approvalResponsibleId` lo usa desde el 10/11 el envío al propietario (M9.1) (tampoco `whatsappNumber`, `logoUrl`, `website`, `email` ni las coordenadas). ¿Qué flujo los usará (p. ej. la aprobación del dueño) y qué debe mostrar hoy la UI?
7. **Coordenadas muy pequeñas:** una `latitude` o `longitude` distinta de 0 con valor absoluto menor que 0,000001 que JavaScript escribe sin punto decimal (`1e-7`) provoca un 500 en la validación; con punto (`1.5e-7`) pasa aunque tenga más de 7 decimales. ¿Se corregirá en el backend? Mientras tanto, ft-crm las redondea (`normalizeCoordinate()`).
8. **Concurrencia:** `PUT /restaurant-config` y `PATCH /commercial-items/:id` no tienen control de versión: gana la última escritura. ¿Se añadirá una comprobación (p. ej. de `updatedAt`) para avisar de cambios simultáneos?
9. **Borrado:** no hay `DELETE` de categorías ni de elementos; solo se desactivan. ¿Es definitivo?
10. **Nombres que se normalizan vacíos:** un nombre de categoría, elemento o variante formado solo por signos diacríticos sueltos (`^`, `´`) pasa la validación y termina en 500 por una restricción `CHECK`. ¿Debería el backend rechazarlo con 400?

## Tipos TypeScript

Bloque autocontenido que compila con `tsc --strict`. Usa los nombres de `ft-crm/src/lib/api/types.ts`; los tipos compartidos (`Uuid`, `HhMm`, `Paginated`…) tienen la misma definición que allí, así que en el frontend decláralos una sola vez.

- Donde la forma de ft-crm no coincide con el backend (`CommercialItem`, `CreateCommercialItemRequest`, `ApiErrorBody`), este bloque trae la correcta.
- `PutRestaurantConfigRequest` y `RestaurantScheduleInput` admiten además omitir los opcionales, como el backend. La forma de ft-crm, con `null` explícito, sigue siendo válida.
- Los ejemplos JSON de este archivo cumplen estos tipos, salvo el body mínimo de `PUT /restaurant-config`, que muestra a propósito las conversiones del backend.

```ts
/* =====================================================================
 * bk-crm · Configuración del restaurante y catálogo comercial
 * Tipos para el frontend. Los nombres coinciden con ft-crm/src/lib/api/types.ts;
 * donde la forma de ft-crm no coincide con el backend, aquí está la correcta.
 * ===================================================================== */

// ---------- Compartidos (misma definición que ft-crm) ----------

/** Identificador UUID. */
export type Uuid = string;
/** Instante ISO 8601. Respuesta: UTC con milisegundos ("2026-11-03T16:42:08.215Z"). */
export type IsoDateTime = string;
/** "HH:mm" 00:00–23:59 */
export type HhMm = string;
/** Importe decimal como string. Entrada: MONEY_PATTERN ("39.9"). Respuesta: siempre 2 decimales ("39.90"). */
export type MoneyString = string;

/** Lectura: ADMIN, OWNER, OPERATOR. Escritura: solo ADMIN. SUPPORT no tiene acceso. */
export type RoleCode = "ADMIN" | "OWNER" | "OPERATOR" | "SUPPORT";

export type CurrencyCode = "PEN" | "USD";
export const LANGUAGE_CODES = ["ES", "EN", "PT"] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];
export const DAYS_OF_WEEK = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  /** Math.ceil(total / limit); 0 cuando total = 0 */
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

/** Cuerpo de error: `message` es string[] en la validación del DTO y string en el resto. */
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  /** Texto del código HTTP ("Bad Request"…). No llega en los errores del BFF (401, 503 y 504 con `code`) ni en el 500. */
  error?: string;
  /** Solo lo añade el BFF. */
  code?: BffErrorCode;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  path?: string;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  method?: string;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  timestamp?: IsoDateTime;
}

// ---------- Validación (mismas expresiones que el backend) ----------

/** Importe: de "0" a "99999999.99", punto decimal, hasta 2 decimales, sin signo ni ceros a la izquierda. */
export const MONEY_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;
/** Hora "HH:mm" de 24 h. */
export const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** WhatsApp del negocio en E.164. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
/** Fechas de promociones y eventos: segundos y zona obligatorios, hasta 3 decimales. */
export const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

// ---------- Configuración del restaurante ----------

/** Datos públicos del responsable de aprobación (usuario activo con rol OWNER). */
export interface ApprovalResponsible {
  id: Uuid;
  firstName: string;
  lastName: string;
  email: string;
}

/** Horario de un día en la respuesta. */
export interface RestaurantSchedule {
  dayOfWeek: DayOfWeek;
  isOpen: boolean;
  /** null si el día está cerrado. */
  openTime: HhMm | null;
  /** Posterior a openTime el mismo día; null si el día está cerrado. */
  closeTime: HhMm | null;
}

/** Respuesta de GET y PUT /restaurant-config. */
export interface RestaurantConfig {
  id: Uuid;
  businessName: string;
  logoUrl: string | null;
  description: string | null;
  address: string;
  /** Número (nunca string) o null. */
  latitude: number | null;
  longitude: number | null;
  /** E.164: "+51987654321" */
  whatsappNumber: string;
  /** WhatsApp personal del propietario para aprobar solicitudes (10/11), E.164; null si no está configurado. */
  ownerWhatsappNumber: string | null;
  /** En minúsculas. */
  email: string;
  website: string | null;
  currency: CurrencyCode;
  /** IANA, p. ej. "America/Lima". Zona en la que se muestran todas las fechas. */
  timeZone: string;
  reservationPolicy: string;
  cancellationPolicy: string;
  /** 1–1440 minutos. */
  responseTimeoutMinutes: number;
  approvalResponsibleId: Uuid | null;
  approvalResponsible: ApprovalResponsible | null;
  /** Ordenados ES, EN, PT. */
  languages: LanguageCode[];
  /** Siempre 7, de lunes a domingo. */
  schedules: RestaurantSchedule[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * Horario de un día en PUT /restaurant-config. Abierto: openTime < closeTime el mismo día.
 * Cerrado: sin horas (null u omitidas; ft-crm envía null).
 */
export type RestaurantScheduleInput =
  | { dayOfWeek: DayOfWeek; isOpen: true; openTime: HhMm; closeTime: HhMm }
  | { dayOfWeek: DayOfWeek; isOpen: false; openTime?: null; closeTime?: null };

/** Body de PUT /restaurant-config: reemplazo completo (los opcionales omitidos o null quedan en null). */
export interface PutRestaurantConfigRequest {
  /** 1–150 tras recortar. */
  businessName: string;
  /** URL http(s) con dominio o IP, máx. 2048. Para borrarla, null; nunca "". */
  logoUrl?: string | null;
  /** 1–2000. */
  description?: string | null;
  /** 1–300. */
  address: string;
  /** −90..90, hasta 7 decimales. Junto con longitude o ninguna. */
  latitude?: number | null;
  /** −180..180, hasta 7 decimales. */
  longitude?: number | null;
  /** E.164 sin espacios. */
  whatsappNumber: string;
  /** E.164, distinto de whatsappNumber. Omitir conserva el guardado; null lo borra (10/11). */
  ownerWhatsappNumber?: string | null;
  /** Se guarda recortado y en minúsculas. Máx. efectivo 254. */
  email: string;
  /** Mismas reglas que logoUrl. */
  website?: string | null;
  currency: CurrencyCode;
  /** Zona IANA aceptada por Intl; envía el nombre canónico. */
  timeZone: string;
  /** 1–5000. */
  reservationPolicy: string;
  /** 1–5000. */
  cancellationPolicy: string;
  /** Entero 1–1440. */
  responseTimeoutMinutes: number;
  /** Usuario existente, activo y con rol OWNER; null u omitido = sin responsable. */
  approvalResponsibleId?: Uuid | null;
  /** 1–3 idiomas distintos. */
  languages: LanguageCode[];
  /** Exactamente 7, uno por día. */
  schedules: RestaurantScheduleInput[];
}

// ---------- Catálogo: enums ----------

export const COMMERCIAL_ITEM_TYPES = ["DISH", "BEVERAGE", "SERVICE", "PROMOTION", "EVENT"] as const;
export type CommercialItemType = (typeof COMMERCIAL_ITEM_TYPES)[number];

/** Nace en DRAFT; editar un APPROVED lo devuelve a DRAFT. */
export type CommercialApprovalStatus = "DRAFT" | "APPROVED" | "REJECTED";

/** Criterio de orden de GET /commercial-items. */
export type CommercialItemSortField = "category" | "name" | "createdAt";

/** Dirección del orden. */
export type SortOrder = "asc" | "desc";

// ---------- Categorías comerciales ----------

/** Respuesta de las rutas de /commercial-categories. */
export interface CommercialCategory {
  id: Uuid;
  nameEs: string | null;
  nameEn: string | null;
  descriptionEs: string | null;
  descriptionEn: string | null;
  isActive: boolean;
  displayOrder: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Respuesta de GET /commercial-categories: array plano, sin paginación. */
export type CommercialCategoryListResponse = CommercialCategory[];

/** Body de POST /commercial-categories. Hay que enviar nameEs o nameEn con texto. */
export interface CreateCommercialCategoryRequest {
  /** 1–150. Único (normalizado y entre ambos idiomas). */
  nameEs?: string | null;
  /** 1–150. Único (normalizado y entre ambos idiomas). */
  nameEn?: string | null;
  /** 1–2000. */
  descriptionEs?: string | null;
  /** 1–2000. */
  descriptionEn?: string | null;
  /** Entero 0–1 000 000 (no admite null). Por defecto 0. */
  displayOrder?: number;
}

/**
 * Body de PATCH /commercial-categories/:id. Al menos un campo. Omitido = se conserva;
 * null = se borra (salvo displayOrder). Debe quedar al menos un nombre.
 */
export type UpdateCommercialCategoryRequest = Partial<CreateCommercialCategoryRequest>;

/** Body de PATCH /commercial-categories/:id/status. */
export interface UpdateCommercialCategoryStatusRequest {
  isActive: boolean;
}

// ---------- Elementos comerciales: respuestas ----------

/** Resumen de la categoría incluido en cada elemento. */
export interface CommercialItemCategorySummary {
  id: Uuid;
  nameEs: string | null;
  nameEn: string | null;
  isActive: boolean;
  displayOrder: number;
}

/** Variante. Su id cambia cada vez que un PATCH reemplaza las variantes. */
export interface CommercialItemVariant {
  id: Uuid;
  nameEs: string | null;
  nameEn: string | null;
  descriptionEs: string | null;
  descriptionEn: string | null;
  /** 2 decimales. */
  price: MoneyString;
  isActive: boolean;
  displayOrder: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Imagen (sin updatedAt). */
export interface CommercialItemImage {
  id: Uuid;
  url: string;
  altTextEs: string | null;
  altTextEn: string | null;
  isPrimary: boolean;
  displayOrder: number;
  createdAt: IsoDateTime;
}

/** Pregunta frecuente. */
export interface CommercialItemFaq {
  id: Uuid;
  questionEs: string;
  questionEn: string | null;
  answerEs: string;
  answerEn: string | null;
  displayOrder: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Disponibilidad de un día. endTime < startTime = cruza la medianoche. */
export interface CommercialItemSchedule {
  id: Uuid;
  dayOfWeek: DayOfWeek;
  isAvailable: boolean;
  startTime: HhMm | null;
  endTime: HhMm | null;
}

/** Detalle de promoción (solo en PROMOTION). */
export interface CommercialPromotionDetail {
  id: Uuid;
  validFrom: IsoDateTime | null;
  validUntil: IsoDateTime | null;
  promotionalPrice: MoneyString | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Detalle de evento (solo en EVENT). */
export interface CommercialEventDetail {
  id: Uuid;
  startAt: IsoDateTime | null;
  endAt: IsoDateTime | null;
  capacity: number | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Elemento comercial completo: lo devuelven POST, GET, GET /:id y los tres PATCH. */
export interface CommercialItem {
  id: Uuid;
  type: CommercialItemType;
  categoryId: Uuid;
  nameEs: string | null;
  nameEn: string | null;
  descriptionEs: string | null;
  descriptionEn: string | null;
  /** 2 decimales o null. */
  basePrice: MoneyString | null;
  displayOrder: number;
  isActive: boolean;
  approvalStatus: CommercialApprovalStatus;
  conditions: string | null;
  /** Nota interna: la ven los roles del CRM, pero no Samanta. */
  internalNotes: string | null;
  availabilityNote: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  category: CommercialItemCategorySummary;
  /** Todas, también las inactivas; por displayOrder y createdAt. */
  variants: CommercialItemVariant[];
  /** Por displayOrder y createdAt. */
  images: CommercialItemImage[];
  /** Por displayOrder y createdAt. */
  faqs: CommercialItemFaq[];
  /** Solo los días configurados, de MONDAY a SUNDAY. */
  schedules: CommercialItemSchedule[];
  promotionDetail: CommercialPromotionDetail | null;
  eventDetail: CommercialEventDetail | null;
}

/** Respuesta de GET /commercial-items. */
export type CommercialItemListResponse = Paginated<CommercialItem>;

// ---------- Elementos comerciales: entradas ----------
// Las entradas no aceptan id, createdAt ni updatedAt: quítalos de los hijos del GET
// (si no, 400 "variants.0.property id should not exist").

/** Variante. Hay que enviar nameEs o nameEn; el nombre normalizado no se repite en el elemento. */
export interface CommercialItemVariantInput {
  /** 1–150. */
  nameEs?: string | null;
  /** 1–150. */
  nameEn?: string | null;
  /** 1–2000. */
  descriptionEs?: string | null;
  /** 1–2000. */
  descriptionEn?: string | null;
  /** MONEY_PATTERN, p. ej. "25" o "25.00". */
  price: MoneyString;
  /** Por defecto true. Solo las activas cuentan para la regla de precio. */
  isActive?: boolean;
  /** Entero 0–1 000 000; omitido o null = posición en el array. */
  displayOrder?: number | null;
}

/** Imagen: solo URL (no hay subida de archivos). */
export interface CommercialItemImageInput {
  /** URL http(s) con dominio o IP, máx. 2048, sin repetir en el elemento. */
  url: string;
  /** 1–300. */
  altTextEs?: string | null;
  /** 1–300. */
  altTextEn?: string | null;
  /** Por defecto false. Como máximo una principal. */
  isPrimary?: boolean;
  /** Entero 0–1 000 000; omitido o null = posición en el array. */
  displayOrder?: number | null;
}

/** Pregunta frecuente. */
export interface CommercialItemFaqInput {
  /** 1–500. */
  questionEs: string;
  /** 1–500. */
  questionEn?: string | null;
  /** 1–5000. */
  answerEs: string;
  /** 1–5000. */
  answerEn?: string | null;
  /** Entero 0–1 000 000; omitido o null = posición en el array. */
  displayOrder?: number | null;
}

/** Disponibilidad de un día: horas distintas (pueden cruzar la medianoche) o no disponible sin horas. */
export type CommercialItemScheduleInput =
  | { dayOfWeek: DayOfWeek; isAvailable: true; startTime: HhMm; endTime: HhMm }
  | { dayOfWeek: DayOfWeek; isAvailable: false; startTime?: null; endTime?: null };

/** Detalle de promoción (solo type PROMOTION). Un objeto sustituye los 3 campos. */
export interface CommercialPromotionDetailInput {
  /** ISO_INSTANT_PATTERN y fecha existente. No posterior a validUntil. */
  validFrom?: IsoDateTime | null;
  validUntil?: IsoDateTime | null;
  promotionalPrice?: MoneyString | null;
}

/** Detalle de evento (solo type EVENT). Un objeto sustituye los 3 campos. */
export interface CommercialEventDetailInput {
  /** ISO_INSTANT_PATTERN y fecha existente. No posterior a endAt. */
  startAt?: IsoDateTime | null;
  endAt?: IsoDateTime | null;
  /** Entero 1–1 000 000. */
  capacity?: number | null;
}

/** Campos editables comunes a la creación y la edición de un elemento. */
export interface CommercialItemWritableFields {
  /** 1–200. Al crear, nameEs o nameEn; al editar debe quedar al menos uno. nameEs es obligatorio para aprobar. */
  nameEs?: string | null;
  /** 1–200. */
  nameEn?: string | null;
  /** 1–5000. */
  descriptionEs?: string | null;
  /** 1–5000. */
  descriptionEn?: string | null;
  /** DISH y BEVERAGE: basePrice o variantes activas, nunca los dos ni ninguno. */
  basePrice?: MoneyString | null;
  /** Entero 0–1 000 000 (no admite null). */
  displayOrder?: number;
  /** 1–5000. Samanta lo recibe. */
  conditions?: string | null;
  /** 1–5000. Samanta no lo recibe. */
  internalNotes?: string | null;
  /** 1–2000. Samanta lo recibe. */
  availabilityNote?: string | null;
  /** Máx. 50. En PATCH reemplaza la lista completa ([] = vaciar; no admite null). */
  variants?: CommercialItemVariantInput[];
  /** Máx. 20. En PATCH reemplaza la lista completa. */
  images?: CommercialItemImageInput[];
  /** Máx. 50. En PATCH reemplaza la lista completa. */
  faqs?: CommercialItemFaqInput[];
  /** Máx. 7, sin repetir días. En PATCH reemplaza la lista completa. */
  schedules?: CommercialItemScheduleInput[];
  /** Solo PROMOTION como objeto. null lo elimina (con cualquier type). */
  promotionDetail?: CommercialPromotionDetailInput | null;
  /** Solo EVENT como objeto. null lo elimina (con cualquier type). */
  eventDetail?: CommercialEventDetailInput | null;
}

/** Body de POST /commercial-items. Nace activo y en DRAFT. */
export interface CreateCommercialItemRequest extends CommercialItemWritableFields {
  type: CommercialItemType;
  /** Categoría existente y activa. */
  categoryId: Uuid;
}

/** Body de PATCH /commercial-items/:id. Al menos un campo; no admite type, isActive ni approvalStatus. */
export interface UpdateCommercialItemRequest extends CommercialItemWritableFields {
  /** No admite null. Si se envía, la categoría debe existir y estar activa. */
  categoryId?: Uuid;
}

/** Body de PATCH /commercial-items/:id/status. */
export interface UpdateCommercialItemStatusRequest {
  isActive: boolean;
}

/** Body de PATCH /commercial-items/:id/approval. */
export interface UpdateCommercialItemApprovalRequest {
  approvalStatus: CommercialApprovalStatus;
}

/** Query de GET /commercial-items. No envíes vacíos ni parámetros no declarados. */
export interface CommercialItemListQuery {
  /** 1–1 000 000. Por defecto 1. */
  page?: number;
  /** 1–100. Por defecto 20. */
  limit?: number;
  type?: CommercialItemType;
  approvalStatus?: CommercialApprovalStatus;
  /** Viaja como "true"/"false". */
  isActive?: boolean;
  categoryId?: Uuid;
  /** 1–200 tras recortar. Sin distinguir mayúsculas; sí distingue tildes. */
  search?: string;
  /** Por defecto "createdAt". */
  sort?: CommercialItemSortField;
  /** Por defecto "desc". */
  order?: SortOrder;
}

// ---------- Contrato por ruta ----------

/** Body o query y respuesta de cada ruta del módulo. */
export interface ConfigCatalogRoutes {
  "GET /restaurant-config": { response: RestaurantConfig };
  "PUT /restaurant-config": { body: PutRestaurantConfigRequest; response: RestaurantConfig };
  "POST /commercial-categories": { body: CreateCommercialCategoryRequest; response: CommercialCategory };
  "GET /commercial-categories": { response: CommercialCategoryListResponse };
  "GET /commercial-categories/:id": { response: CommercialCategory };
  "PATCH /commercial-categories/:id": { body: UpdateCommercialCategoryRequest; response: CommercialCategory };
  "PATCH /commercial-categories/:id/status": { body: UpdateCommercialCategoryStatusRequest; response: CommercialCategory };
  "POST /commercial-items": { body: CreateCommercialItemRequest; response: CommercialItem };
  "GET /commercial-items": { query: CommercialItemListQuery; response: CommercialItemListResponse };
  "GET /commercial-items/:id": { response: CommercialItem };
  "PATCH /commercial-items/:id": { body: UpdateCommercialItemRequest; response: CommercialItem };
  "PATCH /commercial-items/:id/status": { body: UpdateCommercialItemStatusRequest; response: CommercialItem };
  "PATCH /commercial-items/:id/approval": { body: UpdateCommercialItemApprovalRequest; response: CommercialItem };
}
```
