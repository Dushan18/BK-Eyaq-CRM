# Implementación en ft-crm: de mock a live

> Parte de la [referencia de la API de bk-crm para el frontend](README.md). Estado: 3 de noviembre de 2026.
>
> Código revisado: bk-crm en `main` (`9538556`) y ft-crm en `main` (`aaeb85e`), los dos con sus cambios sin commit del 3/11. Las rutas de archivo de ft-crm empiezan en `ft-crm/src`.
>
> Revisión del 8/11: el envío por Instagram y los cambios de bk-crm del 9/11 (plantillas, `templateName`, `externalReference`) se comprobaron contra bk-crm en la rama `whatsapp-identidad` (`7c5b1c7`) y contra ft-crm en `main` (`28ba0ed`, «Despliegue_v1»), que ya responde en Instagram.

Esta guía es el plan para conectar ft-crm con bk-crm en modo live (`CRM_BACKEND_MODE=live`). Reúne por pantalla lo que los módulos 01 a 04 explican por ruta, propone el código de `src/lib/api/` y lista lo que el mock hace distinto del backend real.

## Índice

1. [Cómo usar esta guía](#1-cómo-usar-esta-guía)
2. [Capa de API](#2-capa-de-api): [`endpoints.ts`](#21-endpointsts), [`types.ts`](#22-typests), [`query-keys.ts`](#23-query-keysts), [cómo se comprobó](#24-cómo-se-comprobó)
3. [Guía por pantalla](#3-guía-por-pantalla)
4. [Manejo de errores en la UI](#4-manejo-de-errores-en-la-ui)
5. [Reglas transversales](#5-reglas-transversales)
6. [De mock a live: lista de comprobación](#6-de-mock-a-live-lista-de-comprobación)
7. [Cómo probar contra el backend real](#7-cómo-probar-contra-el-backend-real)

## 1. Cómo usar esta guía

- **Detalle por ruta.** Body, query, respuesta, errores exactos y efectos están en los módulos: [01](01-auth-usuarios.md), [02](02-configuracion-catalogo.md), [03](03-clientes-reservas.md) y [04](04-bandeja-samanta.md). Aquí no se repiten: se enlazan.
- **Filas ft-crm y Caché.** Cada ruta de los módulos tiene una fila **ft-crm** (función y firma) y una fila **Caché** (clave y qué invalidar). Esta guía las reúne por pantalla y en el [mapa de invalidaciones](#mapa-de-invalidaciones).
- **Estados de una función:**
  - **existe**: ya está en `src/lib/api/endpoints.ts`;
  - **nueva**: hay que crearla;
  - **cambia**: existe, pero cambia su tipo;
  - **BFF**: la resuelve el servidor de Next.js;
  - **no aplica**: el navegador no la usa.
- **Código.** El de la [sección 2](#2-capa-de-api) y los ejemplos marcados con `// ejemplo:` compilan con `tsc --strict` junto con el `client.ts` actual de ft-crm ([cómo se comprobó](#24-cómo-se-comprobó)). Después de copiarlos, ejecuta `npm run typecheck` en ft-crm.
- **Ejemplos.** Usan datos ficticios.

### Orden de trabajo recomendado

| Paso | Qué hacer | Listo cuando | Dónde |
|---|---|---|---|
| 0 | Levanta bk-crm en local y ft-crm en modo live. | `/api/listo` responde 200 con `"backend": "disponible"` y entras con el ADMIN del seed. | [§7](#7-cómo-probar-contra-el-backend-real) |
| 1 | Aplica la capa de API: `types.ts`, `endpoints.ts`, `query-keys.ts` y el nuevo `errors.ts`. | `npm run typecheck` y `npm test` pasan, con el ajuste de `servicios-logic.test.ts`. | [§2](#2-capa-de-api) |
| 2 | Ajusta el manejo de errores: «sin conexión» frente a «función apagada», y errores de validación por campo. | Las acciones nuevas usan `isConnectionError` e `isDisabledInServer` (no `ApiError.isUnavailable`), y los formularios llevan los 400 de validación a su campo con `serverFormErrors`. | [§4](#4-manejo-de-errores-en-la-ui) |
| 3 | Prepara los datos del primer arranque: configuración del restaurante, catálogo aprobado y un usuario por rol. | Empresa guarda, Servicios aprueba y puedes entrar con ADMIN, OWNER y OPERATOR. | [Ajustes](#ajustes--empresa) |
| 4 | Habilita Messenger (canal `FACEBOOK`) e Instagram (canal `INSTAGRAM`) en la Bandeja. Ya aplicado en ft-crm: Messenger en `56519b5` e Instagram en `28ba0ed` (8/11). | Puedes responder en Messenger con tope de 2000 caracteres y en Instagram con tope de 1000 caracteres y 1000 bytes UTF-8, y los fallos `MESSENGER_*` e `INSTAGRAM_*` tienen texto. | [Bandeja](#bandeja) |
| 5 | Añade los borradores de Samanta al chat. | Puedes generar, esperar, editar, aprobar y rechazar un borrador. | [Bandeja](#bandeja) |
| 6 | Crea las altas y ediciones que faltan en clientes, solicitudes y reservas. | Las 11 funciones nuevas de [03](03-clientes-reservas.md#funciones-y-claves-de-caché-en-ft-crm) tienen pantalla o formulario. | [Clientes](#clientes), [Solicitudes](#solicitudes), [Calendario](#calendario) |
| 7 | Corrige los textos del flujo del dueño, que bk-crm aún no tiene. | Ninguna pantalla promete algo que el backend no hace. | [§3](#3-guía-por-pantalla) y [§6](#6-de-mock-a-live-lista-de-comprobación) |
| 8 | Pon al día el mock y las pruebas. | El mock responde como bk-crm en las rutas nuevas, y `npm test` y `npm run test:e2e` pasan. | [§6](#6-de-mock-a-live-lista-de-comprobación) |

Si hay que recortar, empieza por los pasos 0 a 4: con datos reales es lo que más se nota. La Bandeja ya responde en Messenger e Instagram (paso 4): falta probarla en live, en Instagram con una cuenta que tenga un rol en la app de Meta.

## 2. Capa de API

Son tres archivos de `src/lib/api/` y uno nuevo. `client.ts` no cambia: `apiFetch`, `toSearch`, `collectPages` y `newIdempotencyKey` ya hacen lo que pide bk-crm.

| Archivo | Qué cambia |
|---|---|
| `endpoints.ts` | Se añaden 25 funciones, 6 de ellas en el objeto nuevo `assistantDraftsApi`. Cambia el tipo del body de `catalogApi.create`. |
| `types.ts` | Se reemplazan 7 declaraciones y se añaden los tipos de las rutas nuevas. |
| `query-keys.ts` | Se añaden 7 claves. |
| `errors.ts` (nuevo) | Ayudas para clasificar errores y llevar los de validación a cada campo ([§4](#4-manejo-de-errores-en-la-ui)). |

### 2.1 `endpoints.ts`

Archivo completo. Cubre las 53 rutas que el navegador pide por `/api/backend`. Login, logout y recuperación de contraseña siguen en `sessionApi`, que no cambia y va por `/api/auth/*`. Quedan fuera:
- `GET /`;
- `GET /auth/test-admin` (el BFF la bloquea);
- `POST /auth/refresh` (la llama el BFF);
- `GET /health` (se consulta con `/api/listo`);
- los cuatro webhooks de Meta.

| Objeto | Existen | Nuevas | Cambian |
|---|---|---|---|
| `sessionApi` | 5 (4 por `/api/auth/*` y `me` por `/api/backend`) | 0 | 0 |
| `usersApi` | 4 | 2 | 0 |
| `configApi` | 2 | 0 | 0 |
| `catalogApi` | 5 | 6 | 1 (`create`: tipo del body) |
| `customersApi` | 3 | 4 | 0 |
| `requestsApi` | 3 | 2 | 0 |
| `reservationsApi` | 3 | 5 | 0 |
| `conversationsApi` | 7 | 0 | 0 |
| `assistantDraftsApi` | 0 | 6 | 0 |

Las funciones nuevas van al final de cada objeto, para que el diff con el archivo actual sea pequeño. Las firmas son las de la fila ft-crm de cada ruta.

```ts
// src/lib/api/endpoints.ts
/**
 * Funciones tipadas por endpoint de bk-crm (vía el proxy /api/backend).
 * Marcas: «NUEVA» no existe en el archivo anterior; «CAMBIA» existía, pero cambia su tipo.
 * Lo que no lleva marca queda igual.
 */
import { apiFetch, newIdempotencyKey } from "./client";
import type {
  AssignConversationRequest,
  AssignReservationBody,
  CommercialApprovalStatus,
  CommercialCategory,
  CommercialItem,
  CommercialItemListQuery,
  Conversation,
  CreateCommercialCategoryRequest,
  CreateCommercialItemRequest,
  CreateCustomerInterestRequest,
  CreateCustomerRequest,
  CreateReservationBody,
  CreateReservationNoteBody,
  CreateReservationRequestBody,
  CreateUserRequest,
  Customer,
  CustomerDetail,
  CustomerInterest,
  CustomerListQuery,
  CustomerStatus,
  EditSamantaDraftRequest,
  GenerateSamantaDraftRequest,
  ListConversationsQuery,
  ListMessagesQuery,
  LoginUser,
  MarkConversationReadResponse,
  MeResponse,
  Message,
  Paginated,
  PutRestaurantConfigRequest,
  RescheduleReservationBody,
  Reservation,
  ReservationDetail,
  ReservationListQuery,
  ReservationNote,
  ReservationRequest,
  ReservationRequestListQuery,
  ReservationStatusTarget,
  RestaurantConfig,
  ReviewSamantaDraftRequest,
  RoleCode,
  SamantaDraft,
  SamantaDraftListResponse,
  UpdateCommercialCategoryRequest,
  UpdateCommercialCategoryStatusRequest,
  UpdateCommercialItemRequest,
  UpdateCustomerRequest,
  UpdateReservationBody,
  UpdateReservationRequestBody,
  UpdateUserRequest,
  User,
  Uuid,
} from "./types";

// ---------------------------------------------------------------- sesión (manejadores propios del BFF)

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  }).catch(() => null);
  if (!res) throw new Error("No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new Error(typeof data?.message === "string" ? data.message : `Error ${res.status}`);
  return data as T;
}

/** login, logout, forgotPassword y resetPassword van por /api/auth/*; me, por /api/backend. */
export const sessionApi = {
  login: (email: string, password: string) => postJson<{ user: LoginUser }>("/api/auth/login", { email, password }),
  logout: () => postJson<{ ok: true }>("/api/auth/logout", {}),
  forgotPassword: (email: string) => postJson<{ message: string }>("/api/auth/forgot-password", { email }),
  resetPassword: (token: string, newPassword: string) =>
    postJson<{ message: string }>("/api/auth/reset-password", { token, newPassword }),
  me: (signal?: AbortSignal) => apiFetch<MeResponse>("/auth/me", { signal }),
};

// ---------------------------------------------------------------- usuarios (solo ADMIN)

export const usersApi = {
  list: () => apiFetch<User[]>("/users"),
  create: (body: CreateUserRequest) => apiFetch<User>("/users", { method: "POST", body }),
  setActive: (id: string, isActive: boolean) =>
    apiFetch<User>(`/users/${id}/status`, { method: "PATCH", body: { isActive } }),
  setRoles: (id: string, roles: RoleCode[]) => apiFetch<User>(`/users/${id}/roles`, { method: "PATCH", body: { roles } }),
  /** NUEVA · GET /users/:id */
  get: (id: Uuid, signal?: AbortSignal) => apiFetch<User>(`/users/${id}`, { signal }),
  /** NUEVA · PATCH /users/:id. Solo los campos que cambian (al menos uno); nunca null ni "". */
  update: (id: Uuid, body: UpdateUserRequest) => apiFetch<User>(`/users/${id}`, { method: "PATCH", body }),
};

// ---------------------------------------------------------------- configuración

export const configApi = {
  get: () => apiFetch<RestaurantConfig>("/restaurant-config"),
  put: (body: PutRestaurantConfigRequest) => apiFetch<RestaurantConfig>("/restaurant-config", { method: "PUT", body }),
};

// ---------------------------------------------------------------- catálogo

export const catalogApi = {
  categories: () => apiFetch<CommercialCategory[]>("/commercial-categories"),
  items: (query: CommercialItemListQuery) => apiFetch<Paginated<CommercialItem>>("/commercial-items", { query }),
  /** CAMBIA (solo el tipo): CreateCommercialItemRequest admite todos los campos del DTO del backend. */
  create: (body: CreateCommercialItemRequest) => apiFetch<CommercialItem>("/commercial-items", { method: "POST", body }),
  setActive: (id: string, isActive: boolean) =>
    apiFetch<CommercialItem>(`/commercial-items/${id}/status`, { method: "PATCH", body: { isActive } }),
  setApproval: (id: string, approvalStatus: CommercialApprovalStatus) =>
    apiFetch<CommercialItem>(`/commercial-items/${id}/approval`, { method: "PATCH", body: { approvalStatus } }),
  /** NUEVA · GET /commercial-categories/:id */
  category: (id: string) => apiFetch<CommercialCategory>(`/commercial-categories/${id}`),
  /** NUEVA · POST /commercial-categories */
  createCategory: (body: CreateCommercialCategoryRequest) =>
    apiFetch<CommercialCategory>("/commercial-categories", { method: "POST", body }),
  /** NUEVA · PATCH /commercial-categories/:id (al menos un campo). */
  updateCategory: (id: string, body: UpdateCommercialCategoryRequest) =>
    apiFetch<CommercialCategory>(`/commercial-categories/${id}`, { method: "PATCH", body }),
  /** NUEVA · PATCH /commercial-categories/:id/status */
  setCategoryActive: (id: string, isActive: boolean) =>
    apiFetch<CommercialCategory>(`/commercial-categories/${id}/status`, {
      method: "PATCH",
      body: { isActive } satisfies UpdateCommercialCategoryStatusRequest,
    }),
  /** NUEVA · GET /commercial-items/:id */
  item: (id: string) => apiFetch<CommercialItem>(`/commercial-items/${id}`),
  /** NUEVA · PATCH /commercial-items/:id. variants, images, faqs y schedules reemplazan la lista completa. */
  update: (id: string, body: UpdateCommercialItemRequest) =>
    apiFetch<CommercialItem>(`/commercial-items/${id}`, { method: "PATCH", body }),
};

// ---------------------------------------------------------------- clientes

export const customersApi = {
  list: (query: CustomerListQuery) => apiFetch<Paginated<Customer>>("/customers", { query }),
  get: (id: string) => apiFetch<CustomerDetail>(`/customers/${id}`),
  setStatus: (id: string, status: CustomerStatus) =>
    apiFetch<Customer>(`/customers/${id}/status`, { method: "PATCH", body: { status } }),
  /** NUEVA · POST /customers */
  create: (body: CreateCustomerRequest) => apiFetch<Customer>("/customers", { method: "POST", body }),
  /** NUEVA · PATCH /customers/:id. La respuesta no trae interests: mézclala con el detalle en caché. */
  update: (id: string, body: UpdateCustomerRequest) =>
    apiFetch<Customer>(`/customers/${id}`, { method: "PATCH", body }),
  /** NUEVA · POST /customers/:id/interests. Responde 200 también al repetir (actualiza el interés). */
  addInterest: (id: string, body: CreateCustomerInterestRequest) =>
    apiFetch<CustomerInterest>(`/customers/${id}/interests`, { method: "POST", body }),
  /** NUEVA · DELETE /customers/:id/interests/:commercialItemId. Responde 204: apiFetch devuelve undefined. */
  removeInterest: (id: string, commercialItemId: string) =>
    apiFetch<void>(`/customers/${id}/interests/${commercialItemId}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------- solicitudes

export const requestsApi = {
  list: (query: ReservationRequestListQuery) =>
    apiFetch<Paginated<ReservationRequest>>("/reservation-requests", { query }),
  get: (id: string) => apiFetch<ReservationRequest>(`/reservation-requests/${id}`),
  cancel: (id: string) =>
    apiFetch<ReservationRequest>(`/reservation-requests/${id}/status`, { method: "PATCH", body: { status: "CANCELLED" } }),
  /** NUEVA · POST /reservation-requests (no es idempotente: un reintento crea otra solicitud). */
  create: (body: CreateReservationRequestBody) =>
    apiFetch<ReservationRequest>("/reservation-requests", { method: "POST", body }),
  /** NUEVA · PATCH /reservation-requests/:id (solo en INCOMPLETE_DATA o READY_TO_SEND). */
  update: (id: string, body: UpdateReservationRequestBody) =>
    apiFetch<ReservationRequest>(`/reservation-requests/${id}`, { method: "PATCH", body }),
};

// ---------------------------------------------------------------- reservas

export const reservationsApi = {
  list: (query: ReservationListQuery) => apiFetch<Paginated<Reservation>>("/reservations", { query }),
  get: (id: string) => apiFetch<ReservationDetail>(`/reservations/${id}`),
  setStatus: (id: string, status: ReservationStatusTarget) =>
    apiFetch<Reservation>(`/reservations/${id}/status`, { method: "PATCH", body: { status } }),
  /** NUEVA · POST /reservations (solo ADMIN; no es idempotente). */
  create: (body: CreateReservationBody) => apiFetch<Reservation>("/reservations", { method: "POST", body }),
  /** NUEVA · PATCH /reservations/:id. La respuesta no trae historiales: mézclala con el detalle en caché. */
  update: (id: string, body: UpdateReservationBody) =>
    apiFetch<Reservation>(`/reservations/${id}`, { method: "PATCH", body }),
  /** NUEVA · PATCH /reservations/:id/assignee ({ assignedUserId: null } libera). */
  assign: (id: string, body: AssignReservationBody) =>
    apiFetch<Reservation>(`/reservations/${id}/assignee`, { method: "PATCH", body }),
  /** NUEVA · POST /reservations/:id/notes (no es idempotente). */
  addNote: (id: string, content: string) =>
    apiFetch<ReservationNote>(`/reservations/${id}/notes`, {
      method: "POST",
      body: { content } satisfies CreateReservationNoteBody,
    }),
  /** NUEVA · PATCH /reservations/:id/reschedule. Deja la reserva en RESCHEDULED (con el mismo instante, no cambia nada). */
  reschedule: (id: string, body: RescheduleReservationBody) =>
    apiFetch<Reservation>(`/reservations/${id}/reschedule`, { method: "PATCH", body }),
};

// ---------------------------------------------------------------- conversaciones

export const conversationsApi = {
  list: (query: ListConversationsQuery) => apiFetch<Paginated<Conversation>>("/conversations", { query }),
  get: (id: string) => apiFetch<Conversation>(`/conversations/${id}`),
  messages: (id: string, query: ListMessagesQuery = {}) =>
    apiFetch<Paginated<Message>>(`/conversations/${id}/messages`, { query }),
  markRead: (id: string, throughMessageId: string) =>
    apiFetch<MarkConversationReadResponse>(`/conversations/${id}/read`, { method: "PATCH", body: { throughMessageId } }),
  setAssistantPaused: (id: string, paused: boolean) =>
    apiFetch<Conversation>(`/conversations/${id}/assistant`, { method: "PATCH", body: { paused } }),
  assign: (id: string, body: AssignConversationRequest) =>
    apiFetch<Conversation>(`/conversations/${id}/assignee`, { method: "PATCH", body }),
  /**
   * La clave de idempotencia identifica un mismo mensaje en reintentos: genérala una vez por envío y pásala
   * siempre. El valor por defecto crea una clave nueva en cada llamada.
   */
  send: (id: string, content: string, idempotencyKey: string = newIdempotencyKey()) =>
    apiFetch<Message>(`/conversations/${id}/messages`, {
      method: "POST",
      body: { type: "TEXT", content },
      headers: { "idempotency-key": idempotencyKey },
    }),
};

// ---------------------------------------------------------------- borradores de Samanta (NUEVO objeto)

export const assistantDraftsApi = {
  /**
   * NUEVA · POST /conversations/:id/assistant-drafts. Espera a la IA (el BFF da 65 s a esta ruta).
   * Sin clave por defecto a propósito: reutiliza la misma solo para reintentar esta generación.
   */
  generate: (conversationId: string, sourceMessageId: string, idempotencyKey: string) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts`, {
      method: "POST",
      body: { sourceMessageId } satisfies GenerateSamantaDraftRequest,
      headers: { "idempotency-key": idempotencyKey },
    }),
  /** NUEVA · GET /conversations/:id/assistant-drafts (hasta 50, los más recientes primero, sin paginar). */
  list: (conversationId: string) =>
    apiFetch<SamantaDraftListResponse>(`/conversations/${conversationId}/assistant-drafts`),
  /** NUEVA · GET /conversations/:id/assistant-drafts/:draftId */
  get: (conversationId: string, draftId: string) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts/${draftId}`),
  /** NUEVA · PATCH /conversations/:id/assistant-drafts/:draftId (suma 1 a revision). */
  edit: (conversationId: string, draftId: string, body: EditSamantaDraftRequest) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts/${draftId}`, { method: "PATCH", body }),
  /** NUEVA · POST …/approve (202): encola un OUTBOUND cuyo autor es quien aprueba. */
  approve: (conversationId: string, draftId: string, revision: number) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts/${draftId}/approve`, {
      method: "POST",
      body: { revision } satisfies ReviewSamantaDraftRequest,
    }),
  /** NUEVA · POST …/reject (200). */
  reject: (conversationId: string, draftId: string, revision: number) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts/${draftId}/reject`, {
      method: "POST",
      body: { revision } satisfies ReviewSamantaDraftRequest,
    }),
};
```

Notas:
- **Fechas.** Las funciones reciben instantes ISO ya armados. Usa `toISOString()` o los helpers de `src/lib/format/dates.ts` ([§5](#fechas-y-zona-horaria)).
- **Bodies.** Envía solo campos declarados: bk-crm responde 400 a cualquier otro. En los PATCH, envía solo los que el usuario tocó, porque omitir un campo no es lo mismo que enviarlo como `null` ([§5](#bodies-y-null)).
- **Permisos.** Que exista la función no significa que todos los roles puedan usarla. La tabla de cada pantalla dice qué ocultar ([§3](#3-guía-por-pantalla)).

### 2.2 `types.ts`

Los tipos coinciden con los bloques **Tipos TypeScript** de cada módulo. Aquí están solo los cambios respecto del `types.ts` actual.

| Declaración | Cambio | Motivo | ¿Rompe algo en ft-crm? |
|---|---|---|---|
| `ApiErrorBody` | `code` pasa a `BffErrorCode` (nuevo). Se añaden `path`, `method` y `timestamp`, opcionales. | El BFF solo pone `NO_SESSION`, `SESSION_EXPIRED` o `BACKEND_UNAVAILABLE`. El 500 de bk-crm trae `path`, `method` y `timestamp`. | No. `ApiError.code` sigue siendo `string`. |
| `CommercialItem` | `category`, `images`, `faqs`, `schedules`, `promotionDetail` y `eventDetail` pasan a tener tipos completos. | ft-crm los declaraba como `unknown[]` o con campos de menos ([02 · Modelos](02-configuracion-catalogo.md#commercialitem)). | Sí: `src/features/ajustes/servicios/servicios-logic.test.ts` (líneas 116 y 137) arma `promotionDetail` sin `id`, `createdAt` ni `updatedAt`. Complétalos. |
| `CreateCommercialItemRequest` | Pasa a admitir todos los campos del DTO. `nameEs` deja de ser obligatorio: basta con `nameEs` o `nameEn`. | El alta mínima de Servicios sigue valiendo; un editor completo necesita el resto. | No. `buildCreateItemBody` sigue compilando. |
| `Message` | `errorCode` pasa a `MessageErrorCode \| null`. Se añade `templateName: string \| null` (9/11). Se corrige el comentario de `authorUserId`. | bk-crm solo produce esos códigos. Desde el 9/11 todo `Message` trae `templateName`: el nombre de la plantilla de WhatsApp con que salió, o `null`. Un `OUTBOUND` creado por la API siempre tiene autor: `null` no significa «Samanta». | Sí: los `Message` que arman el mock (`src/lib/mock/routes/inbox.ts`, `seed.ts` y `simulator.ts`) y las pruebas necesitan `templateName: null`. `inbox-utils.test.ts` usa `WHATSAPP_WINDOW_CLOSED`, que es válido. |
| `ReservationRequest` | Se añade `externalReference: string \| null` (9/11). | Código de origen de las solicitudes que el backend crea desde la web (`SM-…`); `null` en las creadas en el CRM. | Sí: los `ReservationRequest` que arman el mock (`src/lib/mock/routes/reservations.ts`, `seed.ts` y `simulator.ts`) y las pruebas necesitan `externalReference: null`. |
| `SendMessageRequest` | Solo el comentario. | El tope es por canal: 4096 en WhatsApp, 2000 en Messenger y 1000 en Instagram, medido con `content.length`. Instagram admite además como máximo 1000 bytes UTF-8. | No |
| `OUTBOUND_CONTENT_MAX_LENGTH` | Solo el comentario. | Es el tope del DTO, no el del canal. | No |

No cambian, porque coinciden con el backend:
- `Customer`, `CustomerDetail`, `CustomerSummary`, `Reservation`, `ReservationDetail` y los demás tipos de [03](03-clientes-reservas.md#tipos-typescript), salvo `ReservationRequest`;
- `Conversation`, `ConversationAssignedUser`, `MessageAttachment` y las query de [04](04-bandeja-samanta.md#tipos-typescript);
- `User`, `LoginUser`, `MeResponse`, `RestaurantConfig` y `CommercialCategory`;
- `CommercialItemListQuery`: sus uniones `sort` y `order` son las mismas que `CommercialItemSortField` y `SortOrder`.

Los bloques de tipos de los cuatro módulos declaran `ApiErrorBody` y `BffErrorCode` igual que este bloque.

`PutRestaurantConfigRequest` y `RestaurantScheduleInput` tampoco cambian. El backend además acepta omitir los opcionales ([02](02-configuracion-catalogo.md#tipos-typescript)), pero la forma de ft-crm, con `null` explícito, es válida y `toPutRequest` siempre la arma completa.

**Declaraciones que se reemplazan.** Cada bloque sustituye las declaraciones que nombra en su primera línea.

```ts
// src/lib/api/types.ts · reemplaza: ApiErrorBody
/** `code` que añade el BFF de este frontend; bk-crm nunca lo envía. */
export type BffErrorCode = "NO_SESSION" | "SESSION_EXPIRED" | "BACKEND_UNAVAILABLE";

/**
 * Cuerpo de error de bk-crm o de un handler del BFF.
 * `message` es string[] solo en el 400 de validación de DTO; en el resto, string.
 */
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  /** "Bad Request", "Forbidden"… No viene en el 401 genérico de bk-crm, en los 429, en el 500 ni en los errores del BFF. */
  error?: string;
  /** Solo lo añade el BFF. */
  code?: BffErrorCode;
  /** Solo en el 500 de bk-crm: ruta sin query string. */
  path?: string;
  /** Solo en el 500 de bk-crm. */
  method?: string;
  /** Solo en el 500 de bk-crm. */
  timestamp?: IsoDateTime;
}
```

```ts
// src/lib/api/types.ts · reemplaza: CommercialItem, CreateCommercialItemRequest
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

/** Body de POST /commercial-items. Nace activo y en DRAFT. Hay que enviar nameEs o nameEn con texto. */
export interface CreateCommercialItemRequest extends CommercialItemWritableFields {
  type: CommercialItemType;
  /** Categoría existente y activa. */
  categoryId: Uuid;
}
```

```ts
// src/lib/api/types.ts · reemplaza: Message, SendMessageRequest, OUTBOUND_CONTENT_MAX_LENGTH
/** Mensaje del historial; también la respuesta 202 de POST /conversations/:id/messages. */
export interface Message {
  id: Uuid;
  conversationId: Uuid;
  channel: ContactChannel;
  /** Orden total dentro de la conversación: ordenar siempre por sequence. */
  sequence: number;
  /** wamid (WhatsApp) o mid (Messenger e Instagram). En OUTBOUND es null hasta SENT. */
  externalMessageId: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  /** El toque de un botón de WhatsApp llega como TEXT, con el texto del botón. */
  type: MessageType;
  /** null en IMAGE o FILE sin pie de foto. En una plantilla, la versión del CRM del texto enviado. */
  content: string | null;
  /** Solo OUTBOUND de WhatsApp: plantilla aprobada en Meta con que se envió (p. ej. "solicitud_reserva_web"); null en los demás. */
  templateName: string | null;
  /**
   * INBOUND: null. OUTBOUND: usuario que lo envió o que aprobó el borrador de Samanta, o SAMANTA_USER_ID
   * si Samanta respondió sola o avisó de una reserva de la web. Un OUTBOUND nunca tiene autor null: null no significa «Samanta».
   */
  authorUserId: Uuid | null;
  /** INBOUND: hora del proveedor. OUTBOUND: null. */
  occurredAt: IsoDateTime | null;
  receivedAt: IsoDateTime | null;
  processedAt: IsoDateTime | null;
  sentAt: IsoDateTime | null;
  /** Instagram no informa entregas: siempre null. */
  deliveredAt: IsoDateTime | null;
  /** Solo WhatsApp: Messenger e Instagram no informan lecturas. */
  providerReadAt: IsoDateTime | null;
  failedAt: IsoDateTime | null;
  /** INBOUND: leído por el equipo en el CRM. OUTBOUND: siempre null. */
  readAt: IsoDateTime | null;
  errorCode: MessageErrorCode | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  attachments: MessageAttachment[];
}

export interface SendMessageRequest {
  type: "TEXT";
  /**
   * Al menos un carácter no blanco. content.length ≤ OUTBOUND_TEXT_MAX_LENGTH del canal (4096 WhatsApp, 2000 Messenger,
   * 1000 Instagram) y, en Instagram, ≤ 1000 bytes UTF-8 (OUTBOUND_TEXT_MAX_BYTES).
   */
  content: string;
}

/** Tope del DTO de envío (cuenta cada emoji como 1). Para el textarea y el contador usa OUTBOUND_TEXT_MAX_LENGTH. */
export const OUTBOUND_CONTENT_MAX_LENGTH = 4096;
```

```ts
// src/lib/api/types.ts · reemplaza: ReservationRequest
export interface ReservationRequest {
  id: Uuid;
  /** "RES-2026-000042" */
  code: string;
  /** Código de origen (9/11), p. ej. el de la web ("SM-20261029-B65A25"); null si se creó en el CRM. */
  externalReference: string | null;
  customerId: Uuid;
  commercialItemId: Uuid | null;
  sourceChannel: ContactChannel;
  /** null mientras faltan datos. */
  reservationAt: IsoDateTime | null;
  numberOfPeople: number | null;
  quotedPrice: MoneyString | null;
  currency: CurrencyCode | null;
  /** En las de la web: «Mensaje», "País: …", datos no entendidos y notas "CRM: ", una por línea. */
  comments: string | null;
  specialRequirements: string | null;
  status: ReservationRequestStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  customer: CustomerSummary;
  commercialItem: CommercialItemSummary | null;
}
```

**Declaraciones nuevas.** Añádelas en la sección correspondiente de `types.ts`; el orden no importa para el compilador.

```ts
// src/lib/api/types.ts · añade (autenticación, usuarios y salud)
/** Body de POST /auth/refresh. Solo lo envía el BFF (src/lib/server/session.ts). */
export interface RefreshRequest {
  /** Último refresh token emitido para la sesión. */
  refreshToken: string;
}

/** Body de PATCH /users/:id (200 · User). Envía al menos un campo; los que no cambian se omiten: nunca null ni "". */
export interface UpdateUserRequest {
  /** Máximo 100 caracteres, al menos uno no blanco; se guarda con trim. */
  firstName?: string;
  /** Máximo 100 caracteres, al menos uno no blanco; se guarda con trim. */
  lastName?: string;
  /** Email válido sin espacios alrededor; único; se guarda en minúsculas. */
  email?: string;
}

export type HealthStatus = "ok" | "error";
export type HealthServiceStatus = "up" | "down";

/** GET /health de bk-crm: 200 con status "ok" o 503 con status "error" (sin message). El navegador usa /api/listo. */
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

/** GET /api/listo (handler del BFF): 200 si bk-crm responde GET /health con 2xx (o en modo mock); 503 si no. */
export type ReadyResponse =
  | { estado: "ok"; backend: "disponible" | "simulado" }
  | { estado: "error"; backend: string; motivo?: "timeout" | "network" | "error" };

/** 200 de POST /api/auth/login (además fija las cookies httpOnly crm_at y crm_rt). */
export interface BffLoginResponse {
  user: LoginUser;
}

/** 200 de POST /api/auth/logout: siempre, aunque bk-crm no responda; borra las cookies. */
export interface BffLogoutResponse {
  ok: true;
}
```

```ts
// src/lib/api/types.ts · añade (configuración y catálogo)
/** Importe: de "0" a "99999999.99", punto decimal, hasta 2 decimales, sin signo ni ceros a la izquierda. */
export const MONEY_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;
/** Hora "HH:mm" de 24 h. */
export const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** WhatsApp del negocio en E.164. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
/** Instantes de entrada (body y query): segundos y zona obligatorios, hasta 3 decimales. */
export const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Criterio de orden de GET /commercial-items. */
export type CommercialItemSortField = "category" | "name" | "createdAt";
/** Dirección del orden. */
export type SortOrder = "asc" | "desc";

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

/** Resumen de la categoría incluido en cada elemento. */
export interface CommercialItemCategorySummary {
  id: Uuid;
  nameEs: string | null;
  nameEn: string | null;
  isActive: boolean;
  displayOrder: number;
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
```

```ts
// src/lib/api/types.ts · añade (clientes, solicitudes y reservas)
/** Body de POST /customers. Exige un email o un teléfono normalizable. */
export interface CreateCustomerRequest {
  sourceChannel: ContactChannel;
  /** 1–100 tras el trim. */
  firstName?: string | null;
  /** 1–100 tras el trim. */
  lastName?: string | null;
  /** Internacional con "+", o nacional junto con phoneCountry. 6–15 dígitos; máx. 80 caracteres. */
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
  /** No admite null. En una identidad del proveedor solo se acepta su canal: "FACEBOOK" (Messenger) o "INSTAGRAM". */
  sourceChannel?: ContactChannel;
  firstName?: string | null;
  lastName?: string | null;
  /** Con un número nacional, reenvía también phoneCountry (no se hereda). null borra también el país. */
  phone?: string | null;
  phoneCountry?: string | null;
  email?: string | null;
  notes?: string | null;
}

/** Body de POST /customers/:id/interests (crea o actualiza el interés). */
export interface CreateCustomerInterestRequest {
  /** Puede estar inactivo o sin aprobar. */
  commercialItemId: Uuid;
  /** 1–5000 tras el trim. Si el interés ya existe: omitir conserva la nota; null la borra. */
  notes?: string | null;
}

/** Estados en los que la solicitud admite edición y cancelación. */
export const RESERVATION_REQUEST_EDITABLE_STATUSES: readonly ReservationRequestStatus[] = [
  "INCOMPLETE_DATA",
  "READY_TO_SEND",
];

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
```

```ts
// src/lib/api/types.ts · añade (bandeja y Samanta)
/** Canales en los que bk-crm puede enviar (tienen transporte registrado). */
export type SendableChannel = Extract<ContactChannel, "WHATSAPP" | "FACEBOOK" | "INSTAGRAM">;
export const SENDABLE_CHANNELS: readonly SendableChannel[] = ["WHATSAPP", "FACEBOOK", "INSTAGRAM"];

/** Acota un ContactChannel a los canales con envío. */
export function isSendableChannel(channel: ContactChannel): channel is SendableChannel {
  return (SENDABLE_CHANNELS as readonly ContactChannel[]).includes(channel);
}

/** Máximo de content.length (unidades UTF-16, igual que String.length) por canal. */
export const OUTBOUND_TEXT_MAX_LENGTH: Readonly<Record<SendableChannel, number>> = {
  WHATSAPP: 4096,
  FACEBOOK: 2000,
  INSTAGRAM: 1000,
};

/** Instagram además limita los bytes UTF-8 (new TextEncoder().encode(texto).length): las tildes ocupan 2 y los emojis 4. */
export const OUTBOUND_TEXT_MAX_BYTES: Readonly<Partial<Record<SendableChannel, number>>> = {
  INSTAGRAM: 1000,
};

/** Prefijo reservado: el backend usa "samanta-<draftId>" al aprobar un borrador. */
export const RESERVED_IDEMPOTENCY_PREFIX = "samanta-";

/** Códigos de `Message.errorCode` en mensajes entrantes. */
export type InboundMessageErrorCode =
  /** RECEIVED: fallo temporal, el worker reintenta solo. */
  | "MESSAGE_PROCESSING_TEMPORARY"
  /** FAILED: el mensaje no pasó la validación interna. */
  | "MESSAGE_INVALID"
  /** FAILED: se agotaron los 5 intentos de procesamiento. */
  | "MESSAGE_ATTEMPTS_EXHAUSTED";

/**
 * Códigos de `Message.errorCode` en mensajes salientes (prefijo WHATSAPP_, MESSENGER_ o INSTAGRAM_).
 * Instagram no informa entregas: nunca llega a DELIVERED ni tiene DELIVERY_FAILED.
 */
export type OutboundMessageErrorCode =
  | "WHATSAPP_RATE_LIMITED"
  | "WHATSAPP_SEND_UNKNOWN"
  | "WHATSAPP_SEND_INVALID"
  | "WHATSAPP_WINDOW_CLOSED"
  | "WHATSAPP_SEND_REJECTED"
  | "WHATSAPP_DELIVERY_FAILED"
  /** FAILED: una plantilla pasó más de 6 h en cola sin poder enviarse (9/11). */
  | "WHATSAPP_TEMPLATE_EXPIRED"
  | "MESSENGER_RATE_LIMITED"
  | "MESSENGER_SEND_UNKNOWN"
  | "MESSENGER_SEND_INVALID"
  | "MESSENGER_WINDOW_CLOSED"
  | "MESSENGER_SEND_REJECTED"
  | "MESSENGER_DELIVERY_FAILED"
  | "INSTAGRAM_RATE_LIMITED"
  | "INSTAGRAM_SEND_UNKNOWN"
  | "INSTAGRAM_SEND_INVALID"
  | "INSTAGRAM_WINDOW_CLOSED"
  | "INSTAGRAM_SEND_REJECTED";

export type MessageErrorCode = InboundMessageErrorCode | OutboundMessageErrorCode;

/** APPROVED, REJECTED, STALE y FAILED son finales. */
export type SamantaDraftStatus = "GENERATING" | "READY" | "APPROVED" | "REJECTED" | "STALE" | "FAILED";

export const SAMANTA_DRAFT_FINAL_STATUSES: readonly SamantaDraftStatus[] = ["APPROVED", "REJECTED", "STALE", "FAILED"];

/** Acciones que admite cada estado (todas exigen la `revision` actual). */
export const SAMANTA_DRAFT_ACTIONS: Readonly<Record<SamantaDraftStatus, readonly ("edit" | "approve" | "reject")[]>> = {
  GENERATING: [],
  READY: ["edit", "approve", "reject"],
  APPROVED: [],
  REJECTED: [],
  STALE: [],
  FAILED: [],
};

/** Intención que detecta la IA. */
export type SamantaIntent = "GENERAL" | "RESERVATION" | "CANCELLATION" | "HUMAN" | "OTHER";

/** Códigos de error de un borrador FAILED. */
export type SamantaErrorCode =
  | "AI_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_REQUEST_REJECTED"
  | "AI_INVALID_RESPONSE"
  | "AI_INCOMPLETE_RESPONSE"
  | "AI_REFUSED_RESPONSE"
  | "AI_RESPONSE_TOO_LARGE"
  | "AI_UNAVAILABLE"
  | "AI_GENERATION_EXPIRED";

/** Máximo de content.length de un borrador (texto de la IA y texto editado). */
export const SAMANTA_DRAFT_MAX_LENGTH = 4096;

/** Body de POST /conversations/:id/assistant-drafts (+ cabecera Idempotency-Key). */
export interface GenerateSamantaDraftRequest {
  /** Id del último mensaje de la conversación: INBOUND, TEXT, no vacío, content.length ≤ 4096. */
  sourceMessageId: Uuid;
}

/** Body de POST …/approve y POST …/reject. */
export interface ReviewSamantaDraftRequest {
  /** Revisión actual del borrador (entero 1–2 147 483 646). */
  revision: number;
}

/** Body de PATCH /conversations/:id/assistant-drafts/:draftId. */
export interface EditSamantaDraftRequest extends ReviewSamantaDraftRequest {
  /** Al menos un carácter no blanco; content.length ≤ 4096. Se guarda sin recortar. */
  content: string;
}

/** Borrador de Samanta: fila completa que devuelven todas sus rutas. */
export interface SamantaDraft {
  id: Uuid;
  conversationId: Uuid;
  /** Mensaje INBOUND al que responde. */
  sourceMessageId: Uuid;
  /** `sequence` del último mensaje al generar. Si llega otro mensaje, el borrador queda STALE. */
  baselineSequence: number;
  /** Clave Idempotency-Key usada al generar. */
  idempotencyKey: string;
  createdById: Uuid;
  /** Quien aprobó o rechazó. */
  reviewedById: Uuid | null;
  /** Último usuario que editó el texto. */
  editedById: Uuid | null;
  status: SamantaDraftStatus;
  /** Empieza en 1 y suma 1 con cada edición. Se envía en editar, aprobar y rechazar. */
  revision: number;
  /** Modelo de IA (SAMANTA_MODEL). */
  model: string;
  /** Versión del prompt: "samanta-v3" desde el 9/11; antes, "samanta-v2" (8/11) o "samanta-drafts-v1". */
  promptVersion: string;
  /** SHA-256 (hex) de la información comercial usada. */
  knowledgeHash: string;
  /** Texto original de la IA. null si la IA no llegó a dar un texto utilizable. */
  originalContent: string | null;
  /** Texto actual (el editado, si se editó). null mientras no haya texto de la IA. */
  content: string | null;
  /** null hasta que la IA responde. */
  intent: SamantaIntent | null;
  /** true por defecto; luego lo decide la IA. No se recalcula al editar. */
  requiresHuman: boolean;
  /** Datos que faltan, en texto libre (máx. 8 de hasta 80 caracteres). */
  missingFields: string[];
  /** null hasta que la IA responde. Pueden venir en STALE o FAILED si la IA respondió tarde. */
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: SamantaErrorCode | null;
  /** Límite de la generación (inicio + SAMANTA_TIMEOUT_MS + 10 s). Después pasa a FAILED. */
  generationExpiresAt: IsoDateTime;
  /** Inicio + 15 min. Después pasa a STALE. */
  expiresAt: IsoDateTime;
  reviewedAt: IsoDateTime | null;
  /** Mensaje OUTBOUND creado al aprobar. */
  outboundMessageId: Uuid | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Respuesta de GET /conversations/:id/assistant-drafts: hasta 50, los más recientes primero. */
export interface SamantaDraftListResponse {
  data: SamantaDraft[];
}
```

Lo que no se añade a `types.ts`, aunque esté en los bloques de los módulos:
- los tipos de los webhooks de Meta (`WhatsAppWebhookPayload`, `MessengerWebhookPayload`, `MetaWebhookAck`, `MetaWebhookVerifyQuery`): el frontend no los usa;
- las uniones de mensajes literales de [01](01-auth-usuarios.md#tipos-typescript) (`LoginErrorMessage`, `UserConflictMessage`…): son documentación; compara con el texto solo cuando la UI necesite reaccionar a un caso concreto;
- lo que solo ve el BFF: `AccessTokenClaims`, `RefreshTokenClaims`, `LogoutResponse` y las respuestas literales de bk-crm a `forgot-password` y `reset-password` (el navegador recibe las del BFF, que `sessionApi` tipa como `{ message: string }`);
- `BffForgotPasswordResponse` y `BffResetPasswordResponse`: documentan el texto exacto que devuelve el BFF, pero `sessionApi` ya las tipa como `{ message: string }`;
- `AppRootResponse` y `TestAdminResponse`: son de `GET /` y `GET /auth/test-admin`, que el navegador no usa;
- los alias `UserListResponse`, `CommercialCategoryListResponse` y `CommercialItemListResponse`, que equivalen a `User[]`, `CommercialCategory[]` y `Paginated<CommercialItem>`;
- `InternalErrorResponse` (03 y 04): describe el 500, que aquí cubren los campos opcionales de `ApiErrorBody`;
- `IdempotencyHeaders`: la cabecera la pone `endpoints.ts`;
- los mapas de rutas `ConfigCatalogRoutes` y `ClientesReservasRoutes`.

Ajustes fuera de `src/lib/api/` que implica este cambio:
- `src/features/ajustes/servicios/servicios-logic.test.ts`: completa los dos `promotionDetail` del test con `id`, `createdAt` y `updatedAt`.
- `src/lib/domain/channels.ts`: ya no tiene `SENDABLE_CHANNELS` (ft-crm `56519b5`). `composerState` (`src/features/bandeja/inbox-utils.ts`) usa `isSendableChannel(conversation.channel)` y, desde el 8/11, ya no tiene el caso que bloqueaba `INSTAGRAM` («Instagram por ahora solo recibe mensajes…»).
- `src/features/ajustes/servicios/servicios-logic.ts`: su `MONEY_PATTERN` es la misma expresión que la de `types.ts`. Importa la de `types.ts` para no tener dos.
- `templateName` y `externalReference` (9/11): agrega `templateName: null` a los `Message` y `externalReference: null` a los `ReservationRequest` que arman el mock (`src/lib/mock/routes/*.ts`, `seed.ts` y `simulator.ts`) y las pruebas. Aparte de eso, el mock no necesita cambios para compilar: arma `images: []`, `promotionDetail: null` y `errorCode: null`.

### 2.3 `query-keys.ts`

Archivo completo. Las claves nuevas siguen la convención actual: el detalle usa el segmento `"detail"` y cuelga del prefijo del recurso, así que invalidar el prefijo también lo invalida.

```ts
// src/lib/api/query-keys.ts
/** Claves de TanStack Query. Agrupadas por recurso para invalidar en bloque tras una mutación. */
export const qk = {
  me: ["me"] as const,
  config: ["restaurant-config"] as const,
  users: ["users"] as const,
  /** NUEVA · GET /users/:id. Cuelga de qk.users. */
  user: (id: string) => ["users", "detail", id] as const,
  categories: ["commercial-categories"] as const,
  /** NUEVA · GET /commercial-categories/:id. Cuelga de qk.categories. */
  category: (id: string) => ["commercial-categories", "detail", id] as const,
  items: (query: object) => ["commercial-items", query] as const,
  /** NUEVA · GET /commercial-items/:id. Cuelga de qk.itemsAll. */
  item: (id: string) => ["commercial-items", "detail", id] as const,
  itemsAll: ["commercial-items"] as const,
  customers: (query: object) => ["customers", "list", query] as const,
  customer: (id: string) => ["customers", "detail", id] as const,
  customersAll: ["customers"] as const,
  requests: (query: object) => ["reservation-requests", "list", query] as const,
  /** NUEVA · GET /reservation-requests/:id. Cuelga de qk.requestsAll. */
  request: (id: string) => ["reservation-requests", "detail", id] as const,
  requestsAll: ["reservation-requests"] as const,
  reservations: (query: object) => ["reservations", "list", query] as const,
  reservation: (id: string) => ["reservations", "detail", id] as const,
  reservationsAll: ["reservations"] as const,
  conversations: (query: object) => ["conversations", "list", query] as const,
  conversation: (id: string) => ["conversations", "detail", id] as const,
  messages: (id: string) => ["conversations", "messages", id] as const,
  /** Vista previa del último mensaje: cambia solo cuando cambia lastMessageAt. */
  lastMessage: (id: string, lastMessageAt: string | null) => ["conversations", "last-message", id, lastMessageAt] as const,
  /** NUEVA · GET /conversations/:id/assistant-drafts. Cuelga de qk.conversationsAll. */
  assistantDrafts: (conversationId: string) => ["conversations", "assistant-drafts", conversationId] as const,
  /** NUEVA · GET /conversations/:id/assistant-drafts/:draftId. Cuelga de qk.assistantDrafts(conversationId). */
  assistantDraft: (conversationId: string, draftId: string) =>
    ["conversations", "assistant-drafts", conversationId, draftId] as const,
  conversationsAll: ["conversations"] as const,
  stats: (period: string, anchor: string) => ["stats", period, anchor] as const,
  /** NUEVA · prefijo de todas las consultas de Estadísticas (se calculan con reservas, solicitudes y conversaciones). */
  statsAll: ["stats"] as const,
};
```

Qué guarda cada clave hoy y quién la usa:

| Clave | Valor | Guarda | Quién la usa |
|---|---|---|---|
| `qk.me` | `["me"]` | `MeResponse` | `SessionProvider` |
| `qk.config` | `["restaurant-config"]` | `RestaurantConfig` | `useRestaurant()`, `useConfigSave()` |
| `qk.users` | `["users"]` | `User[]` | Ajustes › Usuarios y Ajustes › Samanta |
| `qk.user(id)` · nueva | `["users", "detail", id]` | `User` | Ficha o edición de usuario |
| `qk.categories` | `["commercial-categories"]` | `CommercialCategory[]` | `NuevoServicioForm` |
| `qk.category(id)` · nueva | `["commercial-categories", "detail", id]` | `CommercialCategory` | Edición de categoría |
| `qk.items(query)` | `["commercial-items", query]` | `Paginated<CommercialItem>` | `ServiciosView` |
| `qk.item(id)` · nueva | `["commercial-items", "detail", id]` | `CommercialItem` | Ficha o editor de elemento |
| `qk.customers(query)` | `["customers", "list", query]` | `Paginated<Customer>` | `ClientesView` |
| `qk.customer(id)` | `["customers", "detail", id]` | `CustomerDetail` | Clientes (columna CONSULTÓ), panel de la Bandeja, detalle de reserva |
| `qk.requests(query)` | `["reservation-requests", "list", query]` | Varía (ver abajo) | Solicitudes, Bandeja y su panel |
| `qk.request(id)` · nueva | `["reservation-requests", "detail", id]` | `ReservationRequest` | Detalle o edición de solicitud |
| `qk.reservations(query)` | `["reservations", "list", query]` | Varía (ver abajo) | Calendario, Clientes y panel de la Bandeja |
| `qk.reservation(id)` | `["reservations", "detail", id]` | `ReservationDetail` | Detalle del Calendario |
| `qk.conversations(query)` | `["conversations", "list", query]` | `Paginated<Conversation>`; el contador de no leídos guarda `{ messages, partial }` | Bandeja |
| `qk.conversation(id)` | `["conversations", "detail", id]` | `Conversation` | Bandeja |
| `qk.messages(id)` | `["conversations", "messages", id]` | `Paginated<Message>` (página 1) | Chat |
| `qk.lastMessage(id, lastMessageAt)` | `["conversations", "last-message", id, lastMessageAt]` | `Message \| null` | Vista previa de la lista |
| `qk.assistantDrafts(conversationId)` · nueva | `["conversations", "assistant-drafts", conversationId]` | `SamantaDraftListResponse` | Panel de Samanta |
| `qk.assistantDraft(conversationId, draftId)` · nueva | `["conversations", "assistant-drafts", conversationId, draftId]` | `SamantaDraft` | Borrador en `GENERATING` o abierto |
| `qk.stats(period, anchor)` | `["stats", period, anchor, …]` | Resultado de `collectPages` (reservas y solicitudes) o de `collectConversationsSince` (conversaciones) | Estadísticas (añade `toIso` y la fuente a la clave) |
| `qk.statsAll` · nueva | `["stats"]` | Prefijo | Invalidar Estadísticas |

Bajo un mismo prefijo conviven valores de forma distinta:
- `["reservation-requests", "list", …]`: `Paginated<ReservationRequest>`, un `number` (los KPI de Solicitudes, `{ count: status }`), un `ReservationRequest | null` (la etiqueta de cada fila de la Bandeja, `{ customerId, limit: 1 }`) y el objeto con `truncated` de la pestaña Esperando.
- `["reservations", "list", …]`: `Paginated<Reservation>`, el `CollectedPages<Reservation>` del calendario (`{ scope: "calendario", … }`) y el `Reservation[]` del historial del panel (`{ customerId, history: true }`).

Por eso, en esos prefijos **invalida; no uses `setQueriesData`**. En las conversaciones, `storeConversation` sí usa `setQueriesData`, pero comprueba `Array.isArray(page.data)` antes de tocar cada valor: copia esa guarda si escribes otro actualizador.

Opcional, no incluida: `["ready"]`, si alguna pantalla muestra un indicador de conexión con `fetch("/api/listo")` (`apiFetch` no sirve, porque antepone `/api/backend`).

#### Mapa de invalidaciones

Qué hacer en la caché tras cada mutación. «Mezcla» significa `setQueryData(clave, (old) => (old ? { ...old, ...respuesta } : old))`, para no perder los campos que la respuesta no trae.

| Mutación | Con la respuesta | Invalida |
|---|---|---|
| `usersApi.create` | — | `qk.users` |
| `usersApi.update` | `setQueryData(qk.user(id))` | `qk.users`; `qk.me` si es el propio usuario; `qk.conversationsAll` y `qk.reservationsAll` si cambió el nombre; `qk.config` si cambió el nombre o el email (por `approvalResponsible`) |
| `usersApi.setActive` | Fila de `qk.users` (optimista, ya en `UsuariosView`) y `qk.user(id)` | `qk.users`, `qk.conversationsAll`, `qk.reservationsAll` |
| `usersApi.setRoles` | Fila de `qk.users` y `qk.user(id)` | `qk.me` si es el propio usuario; `qk.conversationsAll` y `qk.reservationsAll` si cambió ADMIN u OPERATOR |
| `configApi.put` | `setQueryData(qk.config)` (ya en `useConfigSave`) | — |
| `catalogApi.createCategory` | — | `qk.categories` |
| `catalogApi.updateCategory`, `setCategoryActive` | `setQueryData(qk.category(id))` | `qk.categories`, `qk.itemsAll` |
| `catalogApi.create` | Opcional: `setQueryData(qk.item(id))` | `qk.itemsAll` |
| `catalogApi.update`, `setActive`, `setApproval` | `setQueryData(qk.item(id))` | `qk.itemsAll`; además `qk.customersAll`, `qk.requestsAll` y `qk.reservationsAll` si una pantalla muestra el resumen `commercialItem` |
| `customersApi.create` | — | `qk.customersAll` |
| `customersApi.update` | Mezcla en `qk.customer(id)` | `qk.customersAll`; si cambió nombre, teléfono o email, también `qk.conversationsAll`, `qk.requestsAll` y `qk.reservationsAll` |
| `customersApi.setStatus` | Mezcla en `qk.customer(id)` | `qk.customersAll` |
| `customersApi.addInterest`, `removeInterest` | — | `qk.customersAll` |
| `requestsApi.create` | — | `qk.requestsAll`, `qk.statsAll` |
| `requestsApi.update`, `cancel` | `setQueryData(qk.request(id))` | `qk.requestsAll`, `qk.statsAll` |
| `reservationsApi.create` | — | `qk.reservationsAll`, `qk.statsAll` |
| `reservationsApi.update`, `setStatus`, `reschedule` | Mezcla en `qk.reservation(id)` | `qk.reservationsAll`, `qk.statsAll` |
| `reservationsApi.assign` | Mezcla en `qk.reservation(id)` | `qk.reservationsAll` |
| `reservationsApi.addNote` | Añade la nota al final de `noteHistory` en `qk.reservation(id)`, o invalida esa clave | — |
| `conversationsApi.send` | `storeSentMessage` en `qk.messages(id)` | `["conversations", "list"]`, `qk.conversation(id)`, `qk.assistantDrafts(id)` |
| `conversationsApi.markRead` | `storeConversationRead` | `["conversations", "list"]`, `qk.conversation(id)` |
| `conversationsApi.setAssistantPaused` | `storeConversation` | `["conversations", "list"]`, `qk.assistantDrafts(id)` |
| `conversationsApi.assign` | `storeConversation` | `["conversations", "list"]` |
| `assistantDraftsApi.generate` | `setQueryData(qk.assistantDraft(id, draft.id))` | `qk.assistantDrafts(id)` |
| `assistantDraftsApi.edit`, `reject` | `setQueryData(qk.assistantDraft(id, draftId))` | `qk.assistantDrafts(id)` |
| `assistantDraftsApi.approve` | `setQueryData(qk.assistantDraft(id, draftId))` | `qk.assistantDrafts(id)`, `qk.messages(id)`, `qk.conversation(id)`, `["conversations", "list"]` |

Las solicitudes y las reservas incluyen el resumen del cliente y del elemento, y las conversaciones el del cliente. Por eso algunas mutaciones de clientes y catálogo invalidan también esas claves.

### 2.4 Cómo se comprobó

- Se copió `ft-crm/src/lib/api/client.ts` sin cambios. `types.ts` se armó aplicando al archivo actual los bloques «reemplaza» y «añade» de esta sección, tal como están escritos aquí. `endpoints.ts`, `query-keys.ts` y `errors.ts` ([§4](#42-errores-de-validación-por-campo)) se extrajeron de los bloques de esta guía.
- Los cinco archivos compilan juntos con `tsc --noEmit --strict --target es2022 --lib es2022,dom --module esnext --moduleResolution bundler --skipLibCheck`.
- Los ejemplos `// ejemplo:` de las secciones 3 y 4 compilan contra esos archivos y contra `@tanstack/react-query` de ft-crm.
- También se comprobó ft-crm completo, en memoria y sin escribir en el repo: su `tsconfig.json` y su TypeScript 5.9.3, con estos cuatro archivos en lugar de los actuales. Sin más cambios, solo fallan las líneas 116 y 137 de `servicios-logic.test.ts` (falta `id`, `createdAt` y `updatedAt` en `promotionDetail`). Con ellas completadas, compila sin errores, también tras quitar `SENDABLE_CHANNELS` de `channels.ts` y usar `isSendableChannel` en `composerState`, y con los cuatro ejemplos copiados en la ruta que indica su primera línea.
- No se ejecutaron `next typegen` ni las pruebas. Después de aplicar los cambios, ejecuta `npm run typecheck` y `npm test`.
- 8/11: se repitió la comprobación con los bloques actualizados (Instagram, `templateName`, `externalReference` y el bloque nuevo de `ReservationRequest`), sobre el `types.ts` de `aaeb85e`. Los cinco archivos y los cuatro ejemplos compilan con `tsc --strict`. Los ejemplos de petición de [03](03-clientes-reservas.md) y [04](04-bandeja-samanta.md) también compilan contra ellos, declarando solo las variables de contexto (`conversationId`, `draft` y `edited`). `SendableChannel`, `SENDABLE_CHANNELS`, `OUTBOUND_TEXT_MAX_LENGTH`, `OUTBOUND_TEXT_MAX_BYTES` y `OutboundMessageErrorCode` son iguales a los de ft-crm `28ba0ed`; su `Message` solo difiere en `templateName`, que aún no tiene.

## 3. Guía por pantalla

Cada ficha dice qué rutas usa la pantalla, con qué función y clave de caché, cada cuánto se actualiza, qué invalidar tras cada cambio, qué ve cada rol, cómo mostrar los estados vacíos y de error, y qué falta en el backend. Los intervalos de polling son los del código actual.

Índice de pantallas:
- [Marco del CRM](#marco-del-crm) (todas las pantallas con sesión)
- [Login](#login) · [Olvidé mi contraseña](#olvidé-mi-contraseña) · [Restablecer contraseña](#restablecer-contraseña)
- [Bandeja](#bandeja) · [Calendario](#calendario) · [Clientes](#clientes) · [Solicitudes](#solicitudes) · [Estadísticas](#estadísticas)
- [Ajustes](#ajustes): [Empresa](#ajustes--empresa) · [Horarios](#ajustes--horarios) · [Políticas](#ajustes--políticas) · [Samanta](#ajustes--samanta) · [Servicios](#ajustes--servicios) · [Usuarios](#ajustes--usuarios)

Acciones de `src/lib/auth/permissions.ts` que faltan para las funciones nuevas (propuesta; se usan en las fichas):

| Acción nueva | Roles | Para |
|---|---|---|
| `draft.review` | ADMIN, OPERATOR | Generar, editar, aprobar y rechazar borradores de Samanta |
| `customer.create` | ADMIN, OPERATOR | `customersApi.create`, `update`, `addInterest` y `removeInterest` (hoy `customer.edit` cubre los mismos roles; puedes reutilizarla) |
| `request.edit` | ADMIN, OPERATOR | `requestsApi.create` y `update` |
| `reservation.create` | ADMIN | `reservationsApi.create` |
| `reservation.edit` | ADMIN, OPERATOR | `reservationsApi.update`, `assign`, `addNote` y `reschedule` |

Las acciones de catálogo (`catalog.edit`) y de usuarios (`users.manage`) ya cubren las funciones nuevas de esos objetos: son solo para ADMIN.

### Marco del CRM

`src/app/(crm)/layout.tsx` → `CrmShell` (`src/components/shell/crm-shell.tsx`), con `SessionProvider` (`src/lib/auth/session.tsx`) y `Sidebar`. La configuración no la pide el marco: cada vista llama a `useRestaurant()` (`src/lib/restaurant.tsx`) para la zona horaria y la moneda, y todas comparten `qk.config`.

| Uso | Ruta | Función | Estado | Caché y polling |
|---|---|---|---|---|
| Usuario y roles | `GET /auth/me` | `sessionApi.me` | existe | `qk.me`: `staleTime` 60 s, `refetchInterval` 5 min |
| Zona horaria y moneda | `GET /restaurant-config` | `configApi.get` | existe | `qk.config`: `staleTime` 5 min, sin polling |
| Cerrar sesión | `POST /auth/logout`, vía `/api/auth/logout` | `sessionApi.logout` | existe | `queryClient.clear()` y `/login` |

- **Sesión.** Cualquier 401 de `apiFetch` emite `crm:session-expired`. `SessionProvider` limpia la caché y lleva a `/login?motivo=sesion&next=<ruta>`. Antes, `src/proxy.ts` ya manda a `/login` a quien no tiene cookies.
- **Roles.** Salen de `GET /auth/me`, que bk-crm relee de la base de datos en cada petición. Un cambio de roles se nota en el siguiente `me` (como mucho 5 min) o en el primer 403.
- **SUPPORT.** No tiene ninguna vista: `homePathFor` devuelve `null` y el marco muestra «Tu rol no tiene vistas habilitadas». Es coherente con bk-crm, que solo le deja usar `/auth/me` y el logout.
- **Configuración.** `useRestaurant()` solo consulta con la sesión lista y un rol que puede ver Ajustes (ADMIN, OWNER u OPERATOR). Un 404 significa que el restaurante no está configurado (`missing`), y no se reintenta. Mientras no hay configuración, las fechas se muestran en `America/Lima` y los importes en `PEN`.
- **Errores.** Si `GET /auth/me` falla por otra causa que no sea 401, el marco muestra `ErrorState` con «Reintentar». Con un 503 o 504 `BACKEND_UNAVAILABLE`, el título es «No se pudo cargar tu sesión.».
- **Falta en el backend.** No hay endpoint para saber qué está habilitado en el servidor (WhatsApp, Messenger, Instagram, Samanta), ni para listar roles ni para cambiar la contraseña con la sesión abierta.

### Login

`/login` · `src/app/(auth)/login/login-form.tsx`

| Uso | Ruta | Función | Estado | Caché |
|---|---|---|---|---|
| Iniciar sesión | `POST /auth/login`, vía `/api/auth/login` | `sessionApi.login(email, password)` | existe | Ninguna |

- **Validación en el cliente.** Hoy comprueba que haya correo y que la contraseña tenga al menos 8 caracteres. El BFF vuelve a validar con zod: correo con `trim`, en minúsculas y de hasta 320 caracteres; contraseña de 8 a 200.
- **Mensajes.** `sessionApi.login` lanza `Error` con el texto del BFF: muéstralo tal cual. La tabla completa está en [Iniciar sesión](01-auth-usuarios.md#iniciar-sesión):

  | Caso | `message` |
  |---|---|
  | Correo o contraseña con formato inválido (BFF) | `Ingresa un correo válido y una contraseña de al menos 8 caracteres.` |
  | Credenciales incorrectas o usuario inactivo | `Correo o contraseña incorrectos.` |
  | Sexto intento en 60 s con la misma IP y el mismo correo | `Hiciste demasiados intentos. Espera un minuto e inténtalo otra vez.` |
  | bk-crm no responde | Texto del BFF (`BACKEND_UNAVAILABLE`) |

- **Tras el éxito.** Llama a `queryClient.clear()` antes de `router.replace(destino)`; hoy no se hace. Si alguien entra con otra cuenta sin cerrar la anterior, `qk.me` podría mostrar al usuario anterior durante su `staleTime`. El destino es `safeNextPath(next) ?? homePathFor(user.roles) ?? "/bandeja"`.
- **Límite de intentos.** 5 cada 60 s por IP y correo, contando también los logins correctos. Detrás del BFF la IP es siempre la del servidor de Next.js, así que en la práctica el límite es por correo. El BFF no reenvía `Retry-After`: tras un 429, deshabilita el botón durante 60 s.
- **Avisos de la URL.** `?motivo=sesion` y `?motivo=restablecida` ya tienen su aviso.
- **Falta en el backend.** No hay registro público ni forma de saber que la cuenta está inactiva (el mensaje es el mismo que el de una contraseña errónea).

### Olvidé mi contraseña

`/olvide-contrasena` · `src/app/(auth)/olvide-contrasena/page.tsx`

| Uso | Ruta | Función | Estado | Caché |
|---|---|---|---|---|
| Pedir el enlace | `POST /auth/forgot-password`, vía `/api/auth/forgot-password` | `sessionApi.forgotPassword(email)` | existe | Ninguna |

- **Respuesta.** Siempre la misma, exista o no el correo: `Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.` Muéstrala sin decir si la cuenta existe.
- **Errores del BFF:**
  - 400 `Ingresa un correo válido.`;
  - 429 `Hiciste demasiados intentos. Espera un minuto e inténtalo otra vez.` (3 pedidos cada 60 s por IP y correo);
  - 502 `No se pudo enviar el enlace. Inténtalo de nuevo.`;
  - 503 o 504 con `BACKEND_UNAVAILABLE`.
- **Enlace.** Vence a los `PASSWORD_RESET_TOKEN_TTL_MINUTES` minutos (15 por defecto). Pedir otro invalida el anterior: sugiere usar el correo más reciente. Un usuario inactivo no recibe correo, pero la respuesta es la misma ([Solicitar recuperación de contraseña](01-auth-usuarios.md#solicitar-recuperación-de-contraseña)).

### Restablecer contraseña

`/reset-password?token=…` · `src/app/(auth)/reset-password/reset-form.tsx`

| Uso | Ruta | Función | Estado | Caché |
|---|---|---|---|---|
| Guardar la nueva contraseña | `POST /auth/reset-password`, vía `/api/auth/reset-password` | `sessionApi.resetPassword(token, newPassword)` | existe | Ninguna |

- **Enlace.** bk-crm lo arma con `FRONTEND_RESET_PASSWORD_URL`, que debe apuntar a `<origen de ft-crm>/reset-password`. El formulario solo aparece si `token` tiene 64 caracteres hexadecimales.
- **Reglas.** Contraseña de 8 a 72 caracteres, igual a la confirmación (esto último se comprueba solo en el cliente). bcrypt solo usa los primeros 72 bytes en UTF-8: con tildes, `ñ` o emojis, el final de una contraseña larga se ignora sin aviso. Si quieres evitarlo, limita en bytes (`new TextEncoder().encode(clave).length <= 72`); está pendiente de decisión ([01, Preguntas abiertas](01-auth-usuarios.md#preguntas-abiertas)).
- **Mensajes del BFF:**
  - éxito: `Contraseña restablecida correctamente.` y redirección a `/login?motivo=restablecida`;
  - 400 de formato: `El enlace no es válido o la contraseña no cumple el largo (8 a 72 caracteres).`;
  - enlace usado, vencido o de un usuario inactivo: `El enlace de recuperación es inválido o ha expirado. Solicita uno nuevo.`;
  - 429 (5 intentos cada 60 s por IP y enlace) y 502 `No se pudo cambiar la contraseña. Inténtalo de nuevo.`.
- **Efecto.** bk-crm revoca todas las sesiones del usuario. Si tenía el CRM abierto en otra pestaña, su siguiente llamada termina en `SESSION_EXPIRED`.

### Bandeja

`/bandeja` · `src/features/bandeja/`: `bandeja-view.tsx`, `conversation-list.tsx`, `chat-panel.tsx`, `customer-panel.tsx`, `use-inbox.ts`, `use-conversation-actions.ts` e `inbox-utils.ts`. Estado en la URL: `c` (conversación), `canal` y `q` (búsqueda).

| Uso | Ruta | Función | Estado | Caché y polling |
|---|---|---|---|---|
| Lista | `GET /conversations` | `conversationsApi.list` | existe | `qk.conversations({ channel, search, limit })`, cada 6 s (`INBOX_POLL_MS`) |
| Contador «N sin leer» | `GET /conversations?unreadOnly=true&limit=100` | `conversationsApi.list` | existe | `qk.conversations({ unreadOnly: true, limit: 100 })`, cada 6 s |
| Vista previa de cada fila | `GET /conversations/:id/messages?limit=1` | `conversationsApi.messages` | existe | `qk.lastMessage(id, lastMessageAt)`, `staleTime` infinito |
| Etiqueta de cada fila | `GET /reservation-requests?limit=100` y, si falta, `?customerId=…&limit=1` | `requestsApi.list` | existe | `qk.requests({ recent: 100 })`, cada 30 s |
| Conversación abierta | `GET /conversations/:id` | `conversationsApi.get` | existe | `qk.conversation(id)`, cada 6 s |
| Chat | `GET /conversations/:id/messages?page=1&limit=50` | `conversationsApi.messages` | existe | `qk.messages(id)`, cada 4 s (`CHAT_POLL_MS`) o cada 1,5 s con salientes en `QUEUED` o `SENDING` |
| Marcar como leído | `PATCH /conversations/:id/read` | `conversationsApi.markRead` | existe | `storeConversationRead` |
| Pausar o reanudar a Samanta | `PATCH /conversations/:id/assistant` | `conversationsApi.setAssistantPaused` | existe | `storeConversation` |
| Tomar, liberar o asignar | `PATCH /conversations/:id/assignee` | `conversationsApi.assign` | existe | `storeConversation` |
| Enviar | `POST /conversations/:id/messages` | `conversationsApi.send` | existe | `storeSentMessage` |
| Borradores de Samanta | `GET /conversations/:id/assistant-drafts` | `assistantDraftsApi.list` | nueva | `qk.assistantDrafts(id)` |
| Un borrador | `GET /conversations/:id/assistant-drafts/:draftId` | `assistantDraftsApi.get` | nueva | `qk.assistantDraft(id, draftId)`, cada 2–3 s mientras esté en `GENERATING` |
| Generar, editar, aprobar o rechazar | `POST`, `PATCH`, `POST …/approve`, `POST …/reject` | `assistantDraftsApi.generate`, `edit`, `approve`, `reject` | nueva | Ver el [mapa de invalidaciones](#mapa-de-invalidaciones) |
| Panel: solicitud vigente | `GET /reservation-requests?customerId=…&limit=20` | `requestsApi.list` | existe | `qk.requests({ customerId, limit: 20 })`, cada 30 s |
| Panel: cliente | `GET /customers/:id` | `customersApi.get` | existe | `qk.customer(customerId)`, `staleTime` 60 s |
| Panel: historial | `GET /reservations?customerId=…&limit=100` (y las dos últimas páginas) | `reservationsApi.list` | existe | `qk.reservations({ customerId, history: true })`, `staleTime` 60 s |

**Tras cada acción.** `useConversationActions` invalida `["conversations", "list"]` y `qk.conversation(id)` al terminar. Añade `qk.assistantDrafts(id)` tras enviar y tras pausar: los borradores pendientes pasan a `STALE`.

**Permisos.** El detalle de cada regla está en [04](04-bandeja-samanta.md#conversación-pausa-y-responsable).

| Acción | ADMIN | OPERATOR | OWNER | En ft-crm |
|---|---|---|---|---|
| Ver lista, chat, panel y borradores | Sí | Sí | Sí | `canView("bandeja")` |
| Marcar como leído | Sí | Sí | No (403) | `can("conversation.read")`: con OWNER no se llama |
| Enviar | Sí | Sí, aunque la atienda otra persona | No | `can("conversation.send")`. `composerState` bloquea al OPERATOR si la atiende otra persona: es una regla de la UI, no del backend. |
| Pausar o reanudar | Sí | Sí | No | `can("conversation.pause")` |
| Asignar a cualquier usuario elegible | Sí | No | No | Sin interfaz: `conversationControls` solo ofrece «Pasar a humano» (asignársela a uno mismo) y «Devolver a Samanta» (liberarla). Para elegir a otra persona, lista los candidatos con `usersApi.list()` (solo ADMIN) y filtra los activos con ADMIN u OPERATOR. |
| Tomar una libre o liberar la propia | Sí (también tomar o liberar la de otra persona) | Sí | No | `conversationControls` |
| Generar, editar, aprobar o rechazar borradores | Sí | Sí, salvo si la conversación está asignada a otra persona (403 `Conversación asignada a otro operador`) | No | `can("draft.review")` (nueva) |

**Messenger e Instagram (canales `FACEBOOK` e `INSTAGRAM`).** Ya aplicado en ft-crm: Messenger desde `56519b5` e Instagram desde `28ba0ed` (8/11). Lo que hace hoy, y lo que hay que conservar:
- **Canal.** `composerState` usa `isSendableChannel(conversation.channel)`, con `INSTAGRAM` en `SENDABLE_CHANNELS`, y exige `customer.phone` solo en `WHATSAPP`: en Messenger e Instagram no hay teléfono, y el backend resuelve el destinatario con el PSID o el IGSID, que no se exponen. En `WEBSITE`, `PHONE`, `EMAIL` y `OTHER` el editor sigue deshabilitado.
- **Tope.** El textarea y el contador usan `replyMaxLength` (`OUTBOUND_TEXT_MAX_LENGTH[channel]`: 4096, 2000 y 1000). En Instagram mandan los bytes: el contador muestra `bytes/1000 bytes` (`replyMaxBytes` y `utf8Length`) y, con más de 1000 bytes, avisa «Instagram admite hasta 1000 bytes por respuesta…» y no deja enviar. El editor del borrador de Samanta aplica los mismos topes y no deja aprobar un texto que no cabe.
- **Ventana de 24 h.** `chat-panel.tsx` aplica `estimateReplyWindow` en los canales de `SENDABLE_CHANNELS`. El texto de ventana cerrada es distinto por canal (`windowClosedText`): en Messenger e Instagram hay que esperar a que el cliente escriba.
- **Fallos.** `outboundErrorKind` quita el prefijo (`WHATSAPP_`, `MESSENGER_` o `INSTAGRAM_`) y `OUTBOUND_ERROR_TEXT` da el texto por sufijo, como en el ejemplo de abajo. Messenger nunca llega a `READ` (su último estado posible es `DELIVERED`), e Instagram nunca pasa de `SENT`: «✓ Enviado» es su estado final.
- **Errores al enviar.** `sendErrorText` elige el texto según `conversation.channel` (`sendChannelName` y `windowClosedText`) y solo trata como falta de conexión lo que `isConnectionError` reconoce: el status 0, el 502 y los `BACKEND_UNAVAILABLE` del BFF. En Instagram llegan:
  - 503 `Instagram no está habilitado` o `El envío por Instagram no está configurado` (sin `INSTAGRAM_ACCESS_TOKEN`: solo recibe), que se muestran como «El envío por Instagram no está habilitado en el servidor.»;
  - 400 `Instagram admite hasta 1000 caracteres por respuesta`;
  - 400 `Instagram admite hasta 1000 bytes por respuesta; las tildes y los emojis ocupan más de uno`;
  - 400 `Conversación sin destinatario habilitado`;
  - 409 `Ventana de Instagram cerrada; el cliente debe enviar un nuevo mensaje`.
- **Entrega.** Con acceso estándar a la API de Meta, Instagram solo entrega a cuentas que tienen un rol en la app. A otra cuenta, el envío responde 202 y el mensaje termina `FAILED` con `INSTAGRAM_SEND_REJECTED` («No se envió: el canal lo rechazó»).
- **Nombre.** `customerName` (`src/lib/domain/conversation.ts`) termina en «Cliente de Messenger» o «Cliente de Instagram» según el canal y, si no, en «Cliente sin nombre». Los clientes de Messenger e Instagram no tienen teléfono ni email; normalmente traen en `firstName` el nombre que da Meta (en Instagram, el nombre del perfil o `@usuario`), pero puede faltar.

```ts
// ejemplo: src/features/bandeja/channel-utils.ts — topes, textos de fallo y de ventana según el canal (así está en ft-crm desde el 8/11)
import {
  isSendableChannel,
  OUTBOUND_TEXT_MAX_BYTES,
  OUTBOUND_TEXT_MAX_LENGTH,
  type ContactChannel,
  type Message,
  type OutboundMessageErrorCode,
} from "@/lib/api/types";

/** Tope de content.length del cuadro de texto, o null si el canal no tiene envío. */
export function replyMaxLength(channel: ContactChannel): number | null {
  return isSendableChannel(channel) ? OUTBOUND_TEXT_MAX_LENGTH[channel] : null;
}

/** Tope de bytes UTF-8 del cuadro de texto (solo Instagram), o null si el canal no cuenta bytes. */
export function replyMaxBytes(channel: ContactChannel): number | null {
  return isSendableChannel(channel) ? (OUTBOUND_TEXT_MAX_BYTES[channel] ?? null) : null;
}

/** Bytes UTF-8 de un texto, como los cuenta Instagram: «á» ocupa 2 y un emoji 4. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Nombre del canal en los textos de envío. */
export function sendChannelName(channel: ContactChannel): string {
  return channel === "FACEBOOK" ? "Messenger" : channel === "INSTAGRAM" ? "Instagram" : "WhatsApp";
}

type Suffix<T> = T extends `${"WHATSAPP" | "MESSENGER" | "INSTAGRAM"}_${infer S}` ? S : never;
/** "RATE_LIMITED" | "SEND_UNKNOWN" | "SEND_INVALID" | "WINDOW_CLOSED" | "SEND_REJECTED" | "DELIVERY_FAILED" | "TEMPLATE_EXPIRED" */
export type OutboundErrorKind = Suffix<OutboundMessageErrorCode>;

/** Tipo de fallo de un saliente, sin el prefijo del canal; null si el código no es de envío. */
export function outboundErrorKind(code: Message["errorCode"]): OutboundErrorKind | null {
  const kind = code?.replace(/^(?:WHATSAPP|MESSENGER|INSTAGRAM)_/, "");
  return kind && kind in OUTBOUND_ERROR_TEXT ? (kind as OutboundErrorKind) : null;
}

/** Textos sugeridos en 04 (Estados y transiciones), válidos para los tres canales con envío. */
export const OUTBOUND_ERROR_TEXT: Record<OutboundErrorKind, string> = {
  RATE_LIMITED: "Reintentando…",
  SEND_UNKNOWN: "Estado incierto: verifica antes de reenviar",
  SEND_INVALID: "No se envió",
  WINDOW_CLOSED: "No se envió: pasaron más de 24 h desde el último mensaje del cliente",
  SEND_REJECTED: "No se envió: el canal lo rechazó",
  DELIVERY_FAILED: "No se pudo entregar",
  TEMPLATE_EXPIRED: "No se envió: la plantilla esperó demasiado en cola",
};

export function outboundErrorText(code: Message["errorCode"]): string | null {
  const kind = outboundErrorKind(code);
  return kind ? OUTBOUND_ERROR_TEXT[kind] : null;
}

/** Texto de la ventana de 24 h cerrada, según el canal. */
export function windowClosedText(channel: ContactChannel): string {
  if (channel === "FACEBOOK" || channel === "INSTAGRAM")
    return `Pasaron más de 24 h desde el último mensaje del cliente en ${sendChannelName(channel)}: podrás responder cuando vuelva a escribir.`;
  return "La ventana de 24 h de WhatsApp está cerrada: podrás responder cuando el cliente vuelva a escribir.";
}
```

**Samanta con borradores.** Una persona pide un borrador, lo revisa y lo aprueba ([Samanta](README.md#samanta-borradores-con-revisión-humana) y [04](04-bandeja-samanta.md#generar-un-borrador-con-samanta)). Si el servidor tiene el modo automático, Samanta además responde sola, y sus mensajes y borradores `AUTO` llegan por las mismas rutas ([04 › Samanta automática](04-bandeja-samanta.md#samanta-automática)). Flujo en el chat:
1. **Cuándo ofrecer «Generar».** Solo si la conversación es de `WHATSAPP`, `FACEBOOK` o `INSTAGRAM` (`isSendableChannel`), no está en pausa, el último mensaje cargado es un `INBOUND` de texto y el usuario tiene `draft.review`. Un OPERATOR, además, solo si la conversación está libre o es suya. ft-crm ya muestra el panel de Samanta en los tres canales (8/11).
2. **Generar.** `assistantDraftsApi.generate(id, ultimoMensaje.id, clave)`. Genera la clave al hacer clic y reutilízala solo para reintentar esa misma generación, por ejemplo tras un 504: el BFF corta a los 65 s y bk-crm devuelve el mismo borrador sin generar otro.
3. **Esperar.** Si el borrador llega en `GENERATING`, consulta su detalle cada 2–3 s hasta que cambie.
4. **Revisar.** En `READY`, muestra el texto editable, `intent`, el aviso de `requiresHuman`, `missingFields` y una cuenta atrás hasta `expiresAt` (15 min). Editar suma 1 a `revision`. Envía siempre la `revision` que tienes en pantalla al editar, aprobar o rechazar. El editor debe aplicar el tope del canal: en Instagram, 1000 caracteres y 1000 bytes UTF-8 (la IA recibe un tope de 800 caracteres, pero no lo garantiza). ft-crm ya lo hace (`maxLength` y `maxBytes` del editor).
5. **Aprobar o rechazar.** Al aprobar, bk-crm encola un `OUTBOUND` cuyo autor es quien aprueba y lo guarda en `outboundMessageId`. Invalida el chat para verlo. Aprobar hace las mismas comprobaciones que enviar, y en todos estos casos el borrador sigue en `READY` ([Aprobar un borrador](04-bandeja-samanta.md#aprobar-un-borrador-y-encolar-el-envío)):
   - 503 con el canal apagado: `WhatsApp no está habilitado`, `Messenger no está habilitado`, `Instagram no está habilitado` o `El envío por Instagram no está configurado`;
   - 400 si el texto no cabe en el canal (en Instagram, más de 1000 caracteres o de 1000 bytes UTF-8);
   - 400 `Conversación sin destinatario habilitado`;
   - 409 de ventana cerrada.
6. **Desactualizado.** Un borrador pasa a `STALE` si llega otro mensaje, si se pausa a Samanta, si vence o si cambia la información comercial. Ofrece generar otro con una clave nueva.

```ts
// ejemplo: src/features/bandeja/use-samanta.ts — borradores de Samanta con TanStack Query
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { newIdempotencyKey } from "@/lib/api/client";
import { assistantDraftsApi } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { Message, SamantaDraft } from "@/lib/api/types";

const DRAFT_POLL_MS = 2500;

export function useAssistantDrafts(conversationId: string) {
  return useQuery({
    queryKey: qk.assistantDrafts(conversationId),
    queryFn: () => assistantDraftsApi.list(conversationId),
  });
}

/** Un borrador: mientras está en GENERATING se consulta cada 2,5 s. */
export function useAssistantDraft(conversationId: string, draftId: string | null) {
  return useQuery({
    queryKey: qk.assistantDraft(conversationId, draftId ?? ""),
    queryFn: () => assistantDraftsApi.get(conversationId, draftId!),
    enabled: draftId !== null,
    refetchInterval: (query) => (query.state.data?.status === "GENERATING" ? DRAFT_POLL_MS : false),
  });
}

/** Mensaje al que puede responder Samanta: el último cargado, si es un INBOUND de texto con contenido. */
export function draftSource(messages: readonly Message[]): Message | null {
  const last = messages.at(-1);
  return last && last.direction === "INBOUND" && last.type === "TEXT" && last.content?.trim() ? last : null;
}

/** Generar: una clave por clic, reutilizada solo al reintentar la misma fuente tras un fallo. */
export function useGenerateDraft(conversationId: string) {
  const queryClient = useQueryClient();
  const pending = useRef<{ sourceMessageId: string; key: string } | null>(null);
  return useMutation({
    mutationFn: (sourceMessageId: string) => {
      if (pending.current?.sourceMessageId !== sourceMessageId) {
        pending.current = { sourceMessageId, key: newIdempotencyKey() };
      }
      return assistantDraftsApi.generate(conversationId, sourceMessageId, pending.current.key);
    },
    onSuccess: (draft: SamantaDraft) => {
      pending.current = null;
      queryClient.setQueryData(qk.assistantDraft(conversationId, draft.id), draft);
      void queryClient.invalidateQueries({ queryKey: qk.assistantDrafts(conversationId) });
    },
  });
}

/** Aprobar o rechazar con la revisión que se ve en pantalla. */
export function useReviewDraft(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draft, action }: { draft: SamantaDraft; action: "approve" | "reject" }) =>
      action === "approve"
        ? assistantDraftsApi.approve(conversationId, draft.id, draft.revision)
        : assistantDraftsApi.reject(conversationId, draft.id, draft.revision),
    onSuccess: (draft, { action }) => {
      queryClient.setQueryData(qk.assistantDraft(conversationId, draft.id), draft);
      void queryClient.invalidateQueries({ queryKey: qk.assistantDrafts(conversationId) });
      if (action === "approve") {
        void queryClient.invalidateQueries({ queryKey: qk.messages(conversationId) });
        void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
        void queryClient.invalidateQueries({ queryKey: ["conversations", "list"] });
      }
    },
    // Un 409 (revisión vieja, borrador desactualizado) se resuelve releyendo el borrador.
    onError: () => void queryClient.invalidateQueries({ queryKey: qk.assistantDrafts(conversationId) }),
  });
}

/** Ids de los mensajes que salieron de un borrador aprobado, para etiquetarlos como «Samanta». */
export function samantaMessageIds(drafts: readonly SamantaDraft[]): Set<string> {
  return new Set(drafts.flatMap((d) => (d.status === "APPROVED" && d.outboundMessageId ? [d.outboundMessageId] : [])));
}
```

Ajustes de la Bandeja que dependen de Samanta:
- **Autor de los mensajes.** `messageAuthor` (`src/lib/domain/conversation.ts`) trata como Samanta todo `OUTBOUND` sin autor, y con bk-crm eso no ocurre nunca. Etiqueta como «Samanta» solo los mensajes de `samantaMessageIds` (los 50 borradores más recientes). Para los demás, conserva lo que ya hace `outboundAuthorLabel`: «Tú» si coincide con `GET /auth/me`, el nombre del responsable si coincide con `assignedUser.id`, o un texto genérico (hoy «Operador»; [04](04-bandeja-samanta.md#ver-historial-de-mensajes) sugiere «Equipo»). No hay forma de traer otros nombres, porque `GET /users` es solo para ADMIN. Lo mismo vale para el prefijo de la vista previa (`previewPrefix`).
- **Modo de la conversación.** La píldora «Samanta» y el aviso «Samanta está respondiendo» dan a entender que Samanta contesta sola. En v1, `isAssistantPaused` solo impide generar y usar borradores. Ajusta los textos con producto.
- **«Quien escribe toma el control».** Al enviar, el Composer pausa a Samanta (`plan.pause`). Con la conversación en pausa, generar responde 409 `Samanta está pausada en esta conversación` y los borradores quedan `STALE`. Decide con producto si enviar debe seguir pausando, o muestra «Reanudar» junto a «Generar».
- **Samanta apagada.** Si `SAMANTA_ENABLED` no es `true`, generar, editar y aprobar responden 503 `Samanta está desactivada`. Como no hay endpoint de capacidades, tras el primer 503 muestra el aviso y deshabilita el botón hasta recargar.
- **Otros errores al generar:** los del envío cuando la ventana de 24 h está cerrada, el canal apagado o no hay destinatario (409, 503 o 400, sin llamar a la IA); 409 `Selecciona el último mensaje entrante de texto (máximo 4096 caracteres)`; 429 `Límite de generación de Samanta alcanzado` (100 al día en total y 2 a la vez, por defecto); 409 `Ya hay un borrador en generación`.

**Panel derecho.**
- El texto «Aún no hay solicitud. Samanta la crea cuando el cliente confirma fecha, hora y personas.» no se cumple: Samanta no crea solicitudes. Cámbialo y, para ADMIN y OPERATOR, ofrece «Nueva solicitud» con `requestsApi.create({ customerId, sourceChannel: conversation.channel, … })` ([Solicitudes](#solicitudes)).
- Los pasos «Enviada al dueño» y «Respuesta del dueño» de la línea de tiempo nunca se alcanzan. Además, con una solicitud `CANCELLED`, `requestTimeline` (`src/lib/domain/statuses.ts`) marca los tres pasos como completados, también «Enviada al dueño», aunque nunca se envió. Ajusta la línea de tiempo para ese estado.
- En los clientes de Messenger e Instagram, «Teléfono» y «Correo» quedan en «—».

**Estados vacíos y errores.** Ya están resueltos: carga, error sin datos, aviso «Sin conexión…» si falla un sondeo con datos, «Aún no hay conversaciones.» y «Sin conversaciones para este filtro.». Un `c` que no es UUID o que da 404 muestra «No se encontró la conversación». Al enviar:
- un 503 de canal apagado no es «sin conexión» ([§4](#44-qué-hacer-según-el-código));
- un 409 de ventana deshabilita el editor hasta que el cliente escriba;
- un `UNKNOWN` no se reenvía sin confirmar con el cliente.

**Falta en el backend:**
- la vista previa del último mensaje en la lista (hoy, una llamada por fila);
- un filtro «sin asignar»;
- el vencimiento de la ventana de 24 h;
- un endpoint de capacidades;
- las lecturas de Messenger y los recibos de Instagram (entrega y lectura); Samanta ya atiende en Messenger e Instagram;
- resolver o reintentar mensajes `UNKNOWN`;
- descargar adjuntos (solo hay metadata);
- los nombres de los autores para OWNER y OPERATOR;
- tiempo real (WebSockets o SSE).

### Calendario

`/calendario` · `src/features/calendario/`: `calendario-view.tsx`, `calendar-grids.tsx`, `calendar-utils.ts` y `reservation-detail.tsx`. Estado en la URL: `vista` (`dia`, `semana` o `mes`; por defecto `semana`), `fecha` (`YYYY-MM-DD` en la zona del restaurante; por defecto hoy) y `reserva`.

| Uso | Ruta | Función | Estado | Caché y polling |
|---|---|---|---|---|
| Reservas del periodo | `GET /reservations?dateFrom=…&dateTo=…&excludeCancelled=true&page=…&limit=100` | `reservationsApi.list` con `collectPages` (hasta 20 páginas) | existe | `qk.reservations({ scope: "calendario", dateFrom, dateTo })`, cada 60 s |
| Detalle | `GET /reservations/:id` | `reservationsApi.get` | existe | `qk.reservation(id)`, cada 60 s |
| Canal del cliente | `GET /customers/:id` | `customersApi.get` | existe | `qk.customer(customerId)`, `staleTime` 5 min |
| «Marcar como preparada» y demás estados | `PATCH /reservations/:id/status` | `reservationsApi.setStatus` | existe | Mezcla en `qk.reservation(id)`; invalida `qk.reservationsAll` y `qk.statsAll` |
| Nueva reserva | `POST /reservations` | `reservationsApi.create` | nueva | Invalida `qk.reservationsAll` y `qk.statsAll` |
| Editar | `PATCH /reservations/:id` | `reservationsApi.update` | nueva | Mezcla; invalida `qk.reservationsAll` y `qk.statsAll` |
| Responsable | `PATCH /reservations/:id/assignee` | `reservationsApi.assign` | nueva | Mezcla; invalida `qk.reservationsAll` |
| Observación | `POST /reservations/:id/notes` | `reservationsApi.addNote` | nueva | Añade la nota a `noteHistory` |
| Reprogramar | `PATCH /reservations/:id/reschedule` | `reservationsApi.reschedule` | nueva | Mezcla; invalida `qk.reservationsAll` y `qk.statsAll` |

Para los formularios:
- **Cliente:** `customersApi.list({ search, limit })`.
- **Elemento:** `catalogApi.items({ isActive: true, approvalStatus: "APPROVED" })`. bk-crm exige un elemento activo y aprobado.
- **Responsable** (solo ADMIN): `usersApi.list()`, filtrando los activos con ADMIN u OPERATOR.

**Permisos.**

| Acción | ADMIN | OPERATOR | OWNER | En ft-crm |
|---|---|---|---|---|
| Ver | Sí | Sí | Sí | `canView("calendario")` |
| Crear | Sí | No | No | `can("reservation.create")` (nueva) |
| Cambiar estado | Sí | Sí | No | `can("reservation.status")` |
| Editar, observaciones y reprogramar | Sí | Sí | No | `can("reservation.edit")` (nueva) |
| Responsable | Cualquier usuario elegible | Solo tomar una libre o liberar la propia | No | `can("reservation.edit")` y la regla de OPERATOR de [Asignar o liberar responsable](03-clientes-reservas.md#asignar-o-liberar-responsable) |

Las reglas de estado van en las declaraciones nuevas de `types.ts` ([§2.2](#22-typests)): `canSetReservationStatus`, `RESERVATION_EDITABLE_STATUSES`, `RESERVATION_ASSIGNABLE_STATUSES` y `RESERVATION_FINAL_STATUSES` (en un estado final se pueden agregar observaciones). Hoy `types.ts` solo tiene `RESERVATION_STATUS_TRANSITIONS`.

**Cambios para live:**
- **Calendario vacío.** Las reservas solo se crean con `POST /reservations`, que es solo para ADMIN y no tiene pantalla. Sin ella, el calendario estará vacío. Crear exige la configuración del restaurante (409 `Configura el restaurante antes de crear solicitudes o reservas`) y una fecha futura según el reloj del servidor (400 `La fecha de reserva debe ser válida y futura`).
- **Textos.** El subtítulo «Solo reservas aceptadas por el dueño.» y la píldora «Aceptada por el dueño» dependen de un flujo que no existe: `reservationRequestId` siempre es `null` y la píldora siempre dirá «Registrada en el CRM».
- **«No se puede deshacer».** La confirmación de «Marcar como preparada» y el comentario de `PREPARED_STATUS` (`src/lib/domain/statuses.ts`) dicen que `UPCOMING` es irreversible. No hay transición directa a `CONFIRMED`, pero al reprogramar la reserva pasa a `RESCHEDULED`, y desde ahí puede volver a `CONFIRMED`.
- **Caché.** Las respuestas de los PATCH no traen historiales: mézclalas con el detalle, como ya hace `PrepareControl`.

```ts
// ejemplo: src/features/calendario/reservation-cache.ts — guardar en caché las respuestas de reservas
import type { QueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/api/query-keys";
import type { Reservation, ReservationDetail, ReservationNote } from "@/lib/api/types";

/** Mezcla la respuesta de un PATCH (sin historiales) con el detalle e invalida lo que depende de la reserva. */
export function storeReservation(queryClient: QueryClient, updated: Reservation, options: { stats: boolean }) {
  queryClient.setQueryData<ReservationDetail>(qk.reservation(updated.id), (old) => (old ? { ...old, ...updated } : old));
  void queryClient.invalidateQueries({ queryKey: qk.reservationsAll });
  if (options.stats) void queryClient.invalidateQueries({ queryKey: qk.statsAll });
}

/** Agrega la observación nueva al final de noteHistory (ordenado por createdAt ascendente). */
export function storeReservationNote(queryClient: QueryClient, note: ReservationNote) {
  queryClient.setQueryData<ReservationDetail>(qk.reservation(note.reservationId), (old) =>
    old ? { ...old, noteHistory: [...old.noteHistory, note] } : old,
  );
}
```

**Estados vacíos y errores.** Ya existen la carga, el error sin datos, el aviso si falla una actualización y el aviso de lectura parcial (más de 2000 reservas en el periodo). Con datos reales, añade un estado vacío que explique cómo se crean las reservas (para ADMIN, con el botón «Nueva reserva»).

**Falta en el backend:**
- una consulta sin paginar para el calendario;
- un filtro de reservas sin responsable;
- el paso «solicitud aceptada → reserva».

### Clientes

`/clientes` · `src/features/clientes/`: `clientes-view.tsx`, `clientes-utils.ts` y `search-box.tsx`; `src/lib/hooks/use-open-chat.ts`. Estado en la URL: `q`, `estado` y `pagina`.

| Uso | Ruta | Función | Estado | Caché y polling |
|---|---|---|---|---|
| Lista | `GET /customers?page=…&limit=20&search=…&status=…` | `customersApi.list` | existe | `qk.customers(filtros de la URL)`, cada 60 s |
| Columna RESERVAS | `GET /reservations?customerId=…&excludeCancelled=true&limit=1` | `reservationsApi.list` | existe | `qk.reservations({ customerId, excludeCancelled: true, limit: 1 })`, `staleTime` 60 s |
| Columna CONSULTÓ | `GET /customers/:id` | `customersApi.get` | existe | `qk.customer(id)`, `staleTime` 5 min |
| Abrir el chat | `GET /conversations?customerId=…&channel=…&limit=1` y, si no hay, sin `channel` | `conversationsApi.list` (`useOpenChat`) | existe | Sin caché |
| Nuevo cliente | `POST /customers` | `customersApi.create` | nueva | Invalida `qk.customersAll` |
| Editar | `PATCH /customers/:id` | `customersApi.update` | nueva | Mezcla en `qk.customer(id)`; invalida `qk.customersAll` (y conversaciones, solicitudes y reservas si cambia el nombre o el contacto) |
| Estado comercial | `PATCH /customers/:id/status` | `customersApi.setStatus` | existe, sin pantalla | Mezcla en `qk.customer(id)`; invalida `qk.customersAll` |
| Intereses | `POST /customers/:id/interests`, `DELETE /customers/:id/interests/:commercialItemId` | `customersApi.addInterest`, `removeInterest` | nueva | Invalida `qk.customersAll` |

**Permisos.** Ven ADMIN, OWNER y OPERATOR. Escriben ADMIN y OPERATOR: `can("customer.edit")` ya cubre esos roles.

**Cambios para live:**
- **Nombre.** Los clientes de WhatsApp llegan sin nombre y con teléfono. Los de Messenger e Instagram, sin teléfono ni email, y con el nombre de Meta en `firstName` cuando Meta lo da (en Instagram, el nombre del perfil o `@usuario`). Los nuevos de la web, con el nombre del formulario. Sin nombre ni contacto, `customerIdentity` ya muestra «Cliente de Messenger» o «Cliente de Instagram» según `sourceChannel`.
- **Estado comercial.** El backend acepta cualquier transición y solo lo cambia por su cuenta con las reservas de la web (desde el 9/11): un cliente nuevo de la web nace en `REQUESTED_RESERVATION`, y uno existente en `NEW`, `INTERESTED` o `IN_CONVERSATION` pasa a ese estado. Los demás clientes nuevos quedan en `NEW`. Decide con producto qué estados ofrecer.
- **Canal de Messenger o Instagram.** No se puede cambiar el canal de un cliente creado por el webhook de Messenger o de Instagram: responde 400 `No se puede cambiar el canal de una identidad del proveedor`, y la respuesta no indica de antemano si el cliente es una de esas identidades. Para `sourceChannel: "FACEBOOK"` o `"INSTAGRAM"`, no ofrezcas cambiar el canal.
- **Teléfono.** Cambiar el teléfono de un cliente con conversación de WhatsApp cambia el destinatario de las respuestas ([Editar cliente](03-clientes-reservas.md#editar-cliente)). Avísalo en el formulario.
- **Duplicados.** Un teléfono o email que ya tiene otro cliente responde 409. Muéstralo en el campo.
- **Rendimiento.** Cada fila hace dos llamadas (RESERVAS y CONSULTÓ): hasta 40 por página de 20.

**Estados vacíos y errores.** Ya resueltos: «Sin clientes para este filtro.», «No hay clientes en esta página.» con enlace a la primera, el error sin datos y el aviso si falla una actualización.

**Falta en el backend:**
- el número de reservas y el último interés en el listado;
- buscar por nombre completo;
- la fusión de clientes;
- un indicador de identidad de Messenger o Instagram.

### Solicitudes

`/solicitudes` · `src/features/solicitudes/solicitudes-view.tsx`; textos y grupos en `src/lib/domain/statuses.ts`. Estado en la URL: `tab` (`todas`, `esperando`, `aceptadas` o `rechazadas`) y `pagina`.

| Uso | Ruta | Función | Estado | Caché y polling |
|---|---|---|---|---|
| KPI (4 estados) | `GET /reservation-requests?status=…&limit=1` | `requestsApi.list` | existe | `qk.requests({ count: status })`, `staleTime` 30 s |
| Lista | `GET /reservation-requests?page=…&limit=50[&status=…]` | `requestsApi.list` | existe | `qk.requests({ tab, page })`, cada 30 s |
| Pestaña Esperando | Dos estados, con `collectPages` (hasta 5 páginas cada uno) | `requestsApi.list` | existe | La misma clave |
| Abrir el chat | `GET /conversations?customerId=…&channel=…&limit=1` y, si no hay, sin `channel` | `conversationsApi.list` (`useOpenChat`) | existe | Sin caché |
| Detalle | `GET /reservation-requests/:id` | `requestsApi.get` | existe, sin pantalla | `qk.request(id)` (nueva) |
| Nueva solicitud | `POST /reservation-requests` | `requestsApi.create` | nueva | Invalida `qk.requestsAll` y `qk.statsAll` |
| Editar | `PATCH /reservation-requests/:id` | `requestsApi.update` | nueva | `setQueryData(qk.request(id))`; invalida `qk.requestsAll` y `qk.statsAll` |
| Cancelar | `PATCH /reservation-requests/:id/status` | `requestsApi.cancel` | existe, sin pantalla | Igual que editar |

**Permisos.** Ven ADMIN, OWNER y OPERATOR. Crean, editan y cancelan ADMIN y OPERATOR: `can("request.cancel")` ya existe; añade `request.edit`.

**Cambios para live:**
- **Flujo del dueño.** Con las rutas actuales solo se alcanzan `INCOMPLETE_DATA` y `READY_TO_SEND` (los calcula el backend según haya fecha y personas) y `CANCELLED`. Las pestañas Esperando, Aceptadas y Rechazadas, y sus tres KPI, siempre estarán en 0. Ocúltalos o márcalos como «Próximamente».
- **Subtítulo.** «Samanta envía cada solicitud al WhatsApp del dueño…» no se cumple: cámbialo.
- **Solicitudes de la web (9/11).** El backend crea solicitudes `WEBSITE` con las reservas que llegan por correo ([03 › Solicitudes que llegan de la web](03-clientes-reservas.md#solicitudes-que-llegan-de-la-web)):
  - Muestra `externalReference` como «Código web» y el canal `WEBSITE` como «Página web». El buscador no busca por `externalReference`.
  - `comments` trae una línea por dato: el «Mensaje», `País: …`, los datos que no se entendieron («Personas: 2-3») y las notas del sistema, que empiezan con `CRM: ` (WhatsApp sin validar, correo de otro cliente, fecha inválida o por qué no se le escribió al cliente). Muestra los saltos de línea y destaca esas notas.
  - Samanta ve `comments` y `specialRequirements` de las solicitudes web abiertas, salvo las líneas `CRM: `. Si el formulario de edición deja agregar notas internas, pide que empiecen con `CRM: `.
- **Formulario nuevo.**
  - Campos: cliente, canal, elemento (activo y aprobado), fecha futura, personas (entero ≥ 1), precio con moneda, comentarios y requisitos.
  - Si mandas precio sin moneda, el backend usa la del restaurante.
  - Exige la configuración del restaurante (409).
  - No es idempotente: tras un 504, refresca la lista antes de reintentar.
- **Editar y cancelar.** Solo se permiten en `INCOMPLETE_DATA` y `READY_TO_SEND` (`RESERVATION_REQUEST_EDITABLE_STATUSES`); en otro estado responden 409. Cancelar una solicitud ya cancelada responde 200 sin cambios.
- **`pagina`.** Hoy se lee con `Math.max(1, Number(…) || 1)`, que no pone tope ni exige un entero: una página mayor que 1 000 000 o con decimales (`?pagina=2.5`) da 400. Usa `parsePage` de `clientes-utils.ts`.

**Estados vacíos y errores.** Ya resueltos: «No hay solicitudes en esta pestaña.», el error con «Reintentar» y el aviso de lectura parcial de Esperando.

**Falta en el backend:** el flujo del dueño (enviar, aceptar, rechazar y convertir en reserva) y el registro de cuándo responde el dueño (KPI «Respuesta media»).

### Estadísticas

`/estadisticas` · `src/features/estadisticas/`: `estadisticas-view.tsx` y `stats-utils.ts`. Estado en la URL: `periodo` (`semana` o `mes`).

| Fuente | Ruta | Función | Estado | Caché |
|---|---|---|---|---|
| Reservas del periodo | `GET /reservations?dateFrom=…&dateTo=…&excludeCancelled=true` (hasta 20 páginas) | `reservationsApi.list` + `collectPages` | existe | `[...qk.stats(period, fromIso), toIso, "reservations"]`, `staleTime` 60 s |
| Solicitudes con fecha de reserva en el periodo | `GET /reservation-requests?dateFrom=…&dateTo=…` (hasta 20 páginas) | `requestsApi.list` + `collectPages` | existe | `…, "requests"` |
| Conversaciones activas en el periodo | `GET /conversations?page=…&limit=100`, hasta salir del periodo | `conversationsApi.list` + `collectConversationsSince` | existe | `…, "conversations"` |

- **Actualización.** Sin polling: `staleTime` de 60 s y recarga al volver a la pestaña. Tras crear o editar solicitudes o reservas, invalida `qk.statsAll` (nueva).
- **Espera a la zona horaria.** La vista ya espera a conocer la zona del restaurante antes de calcular el periodo.
- **Permisos.** ADMIN, OWNER y OPERATOR, solo lectura.
- **Con datos reales:**
  - «Rechazadas» y «Tasa de aceptación» quedan en 0 y «—» (no hay flujo del dueño);
  - «Resueltas por Samanta» no tiene dato;
  - las solicitudes se filtran por `reservationAt`, así que las que aún no tienen fecha no cuentan.
- **Falta en el backend:** endpoints de agregados (hoy se leen hasta 2000 registros por fuente) y un filtro de solicitudes por fecha de alta (`createdAt`).

### Ajustes

`/ajustes` redirige a `/ajustes/empresa`. Marco: `src/app/(crm)/ajustes/layout.tsx` → `AjustesShell` (`src/features/ajustes/shell/`).

- **Pestañas.** Todas para ADMIN, OWNER y OPERATOR, salvo Usuarios, que es solo para ADMIN. Una pestaña no permitida muestra `NoAccess`.
- **Configuración.** Empresa, Horarios, Políticas y Samanta comparten `qk.config` mediante `useRestaurant()` y `ConfigGate`, que distingue carga, 404 (sin configurar) y error.
- **Guardado.** `useConfigSave` relee la configuración (`configApi.get`), aplica los cambios de la pestaña sobre `toPutRequest(actual)` y guarda con `configApi.put`. Así reduce el riesgo de pisar cambios hechos en otra pestaña, porque el backend no tiene control de versión. La respuesta reemplaza `qk.config`.
- **Errores.** `SaveError` muestra los mensajes del backend y enlaza la pestaña donde está el problema (`backendMessageTabs`). Un 409 `La configuración entró en conflicto con otro cambio; inténtalo nuevamente` se resuelve repitiendo.
- **Permisos.** Solo ADMIN guarda (`can("config.edit")`). Los demás ven `ReadOnlyNotice`.

### Ajustes › Empresa

`/ajustes/empresa` · `src/features/ajustes/config/empresa-view.tsx`

| Uso | Ruta | Función | Estado | Caché |
|---|---|---|---|---|
| Leer | `GET /restaurant-config` | `configApi.get` | existe | `qk.config` |
| Guardar o crear la configuración | `PUT /restaurant-config` | `configApi.put` | existe | `setQueryData(qk.config)` |

- **Primer arranque.** bk-crm empieza sin configuración: `GET` responde 404. El ADMIN ve `SetupForm` y los demás roles, un aviso. Sin configuración no se pueden crear solicitudes ni reservas. Al guardar, los 7 días quedan cerrados.
- **Validaciones que conviene replicar con zod** ([Guardar la configuración](02-configuracion-catalogo.md#guardar-la-configuración-del-restaurante-crear-o-reemplazar)):
  - email de hasta 254 caracteres en la práctica;
  - `logoUrl` y `website` con `http(s)` y un dominio o una IP;
  - `whatsappNumber` en E.164 (`E164_PATTERN`);
  - `timeZone` IANA;
  - de 1 a 3 idiomas.
- **Coordenadas.** Una distinta de 0 con valor absoluto menor que 0,000001 que JavaScript escribe sin punto decimal (`1e-7`) provoca un 500; con punto (`1.5e-7`) pasa. `normalizeCoordinate` ya lo evita: redondea a 7 decimales y deja en 0 esos valores.
- **Falta en el backend:** subir el logo (solo acepta URLs ya alojadas) y auditar quién cambió qué.

### Ajustes › Horarios

`/ajustes/horarios` · `src/features/ajustes/config/horarios-view.tsx`. Mismas rutas y caché que Empresa.

- `replaceSchedules` envía la semana completa y cambia solo los días tocados.
- **Reglas.** Un día abierto necesita `openTime` antes que `closeTime` el mismo día: no se puede cruzar la medianoche (el cierre más tardío es 23:59). Un día cerrado no lleva horas.
- **Errores.** Los del backend llegan como `schedules.<i>.…`, donde `<i>` es el día en el orden de `DAYS_OF_WEEK`.

### Ajustes › Políticas

`/ajustes/politicas` · `src/features/ajustes/config/politicas-view.tsx`. Mismas rutas y caché que Empresa. `reservationPolicy` y `cancellationPolicy` son obligatorias, de 1 a 5000 caracteres.

### Ajustes › Samanta

`/ajustes/samanta` · `src/features/ajustes/config/samanta-view.tsx`

| Uso | Ruta | Función | Estado | Caché |
|---|---|---|---|---|
| Responsable y tiempo de respuesta | `GET` y `PUT /restaurant-config` | `configApi.get`, `configApi.put` | existe | `qk.config` |
| Candidatos a responsable | `GET /users` | `usersApi.list` | existe | `qk.users`, solo si puede editar (ADMIN) |

- **Responsable.** `approvalResponsibleId` debe ser un usuario activo con rol OWNER. Si se desactiva o pierde OWNER, cualquier guardado de Ajustes responde 400 hasta elegir otro. `OwnerValidationCard` ya lo avisa (`staleSelected`).
- **Datos sin uso.** `responseTimeoutMinutes` y `approvalResponsibleId` se guardan, pero ningún proceso del backend los usa todavía.
- **Tarjetas «Canales donde atiende» y «Reglas».** No hay rutas para editarlas: los canales del modo automático se configuran en el servidor (`SAMANTA_AUTO_CHANNELS`, por defecto WhatsApp, Messenger e Instagram) junto con `SAMANTA_ENABLED` y `SAMANTA_AUTO_ENABLED`, y el frontend no puede consultarlos. Muéstralas como informativas.
- **Falta en el backend:** el endpoint de capacidades, las reglas de Samanta y el WhatsApp personal del dueño.

### Ajustes › Servicios

`/ajustes/servicios` · `src/features/ajustes/servicios/`: `servicios-view.tsx`, `nuevo-servicio-form.tsx` y `servicios-logic.ts`. Estado en la URL: `pagina`.

| Uso | Ruta | Función | Estado | Caché |
|---|---|---|---|---|
| Lista | `GET /commercial-items?sort=category&order=asc&page=…&limit=50` | `catalogApi.items` | existe | `qk.items(query)` |
| Categorías del formulario | `GET /commercial-categories` | `catalogApi.categories` | existe | `qk.categories`, `staleTime` 60 s |
| Nuevo servicio | `POST /commercial-items` | `catalogApi.create` | cambia (tipo del body) | Invalida `qk.itemsAll` |
| Activar o desactivar | `PATCH /commercial-items/:id/status` | `catalogApi.setActive` | existe | Optimista en la página; invalida `qk.itemsAll` al terminar el último cambio |
| Aprobar | `PATCH /commercial-items/:id/approval` | `catalogApi.setApproval` | existe | Reemplaza el elemento en la página; invalida `qk.itemsAll` |
| Ficha y editor | `GET` y `PATCH /commercial-items/:id` | `catalogApi.item`, `catalogApi.update` | nueva | `qk.item(id)` |
| Categorías | `POST`, `GET /:id`, `PATCH /:id`, `PATCH /:id/status` en `/commercial-categories` | `catalogApi.createCategory`, `category`, `updateCategory`, `setCategoryActive` | nueva | `qk.categories`, `qk.category(id)` |

- **Catálogo inicial.** El seed carga 16 categorías y 86 elementos, todos en `DRAFT`. Samanta solo usa elementos activos, aprobados y de categorías activas (como máximo 30), así que hay que aprobarlos.
- **Elementos sin nombre en español.** 9 elementos no tienen `nameEs`: aprobarlos responde 400 `El elemento necesita un nombre en español antes de aprobarse` hasta que se editen con `catalogApi.update`. Cuatro categorías tampoco tienen `nameEs`; `categoryName` ya muestra `nameEn`.
- **Volver a borrador.** Editar un elemento `APPROVED` lo devuelve a `DRAFT`.
- **Búsqueda.** Si añades un buscador, ten en cuenta que no distingue mayúsculas pero sí tildes: `cafe` no encuentra «Café».
- **Permisos.** Solo ADMIN escribe (`can("catalog.edit")`); para los demás, el interruptor está deshabilitado.
- **Falta en el backend:** subir imágenes, borrar categorías o elementos (solo se desactivan) y auditar las aprobaciones.

### Ajustes › Usuarios

`/ajustes/usuarios` · `src/features/ajustes/usuarios/`: `usuarios-view.tsx`, `invitar-usuario-form.tsx` y `usuarios-logic.ts`.

| Uso | Ruta | Función | Estado | Caché |
|---|---|---|---|---|
| Lista | `GET /users` | `usersApi.list` | existe | `qk.users` |
| Invitar | `POST /users` | `usersApi.create` | existe | Invalida `qk.users` |
| Activar o desactivar | `PATCH /users/:id/status` | `usersApi.setActive` | existe | Optimista con reversión; invalida `qk.users` |
| Roles | `PATCH /users/:id/roles` | `usersApi.setRoles` | existe, sin pantalla | Fila de `qk.users` y `qk.user(id)` |
| Ficha y edición | `GET` y `PATCH /users/:id` | `usersApi.get`, `usersApi.update` | nueva | `qk.user(id)` |

- **Permisos.** Solo ADMIN: la vista muestra `NoAccess` a los demás roles.
- **Desactivar.**
  - Revoca todas las sesiones del usuario. Desactivarse a uno mismo cierra la sesión (ya se pide confirmación).
  - No libera sus conversaciones ni reservas: quedan con `isEligible: false`. Invalida `qk.conversationsAll` y `qk.reservationsAll`.
  - Si es el responsable de aprobación, después `PUT /restaurant-config` responde 400. Avísalo antes de desactivar.
- **Último ADMIN.** 409 `No se puede desactivar al último administrador activo` y 409 `No se puede retirar el rol al último administrador activo`. `UsuariosView` ya revierte el interruptor.
- **Roles.** El formulario de alta elige un solo rol, pero bk-crm admite varios por usuario.
- **Contraseña temporal.** Hasta 72 caracteres, pero bcrypt solo usa los primeros 72 bytes: la misma advertencia que en [Restablecer contraseña](#restablecer-contraseña).
- **Invitación.** No hay invitación por correo: el formulario ya lo explica.
- **Falta en el backend:** paginación y búsqueda de usuarios, un restablecimiento de contraseña hecho por un ADMIN e invitaciones por correo.

## 4. Manejo de errores en la UI

### 4.1 Cómo llega un error

- **Rutas de `/api/backend`.** `apiFetch` lanza `ApiError(status, messages, code, body)`:
  - `messages` siempre es un array: el `message` del body (string o array), sin el texto `Unauthorized`. Si queda vacío, usa el texto genérico del código (`GENERIC` en `client.ts`).
  - `code` solo existe si el error lo generó el BFF.
  - `body` es el JSON recibido. Sirve para saber si `message` era un array (validación) o un string (negocio).
  - `status` 0 significa que el navegador no llegó al BFF. Un `AbortError` (cancelación de TanStack Query) se relanza tal cual.
- **Handlers `/api/auth/*`.** `sessionApi` lanza un `Error` normal, sin código, con el texto ya preparado por el BFF: muéstralo tal cual.
- **Reintentos.** `src/components/providers.tsx` reintenta las consultas hasta 2 veces solo ante status 0 o 5xx, y nunca reintenta las mutaciones. Mantenlo así.

### 4.2 Errores de validación por campo

El 400 de validación trae `message` como array, con textos de class-validator en inglés (los validadores propios de bk-crm, en español). Casi todos empiezan por la ruta del campo; las excepciones son `each value in <campo> …`, `All <campo>'s elements must be unique` y `property <campo> should not exist`, que `splitValidationMessage` también reconoce:

| Mensaje | Campo | Texto propuesto |
|---|---|---|
| `email must be an email` | `email` | Escribe un correo válido. |
| `password must be longer than or equal to 8 characters` | `password` | Escribe al menos 8 caracteres. |
| `each value in roles must be one of the following values: ADMIN, OWNER, OPERATOR, SUPPORT` | `roles` | Elige una opción de la lista. |
| `All roles's elements must be unique` | `roles` | No repitas valores. |
| `schedules.2.openTime debe tener el formato HH:mm` | `schedules.2.openTime` | Debe tener el formato HH:mm. |
| `schedules.2.Un día abierto requiere openTime y closeTime…` | `schedules.2` | Un día abierto requiere openTime y closeTime… |
| `property confirmPassword should not exist` | — | Error del frontend: envió un campo que el DTO no declara |

Reglas:
- **Previene el 400.** Valida en el cliente con las mismas reglas: longitudes de cada módulo, `MONEY_PATTERN`, `TIME_PATTERN`, `E164_PATTERN` e `ISO_INSTANT_PATTERN`. El 400 del backend es la red de seguridad.
- **Varios mensajes del mismo campo.** Llegan cuando falta, es `null` o tiene otro tipo (p. ej. `email` ausente trae dos), y eso indica un body mal armado. Muestra el primero.
- **Mensajes en español.** Los que ya vienen en español (validadores propios de bk-crm) se muestran sin la ruta del campo.

```ts
// src/lib/api/errors.ts
/**
 * Clasificación de errores de bk-crm y del BFF para la UI (archivo nuevo).
 * Los mensajes de negocio llegan en español y se muestran tal cual. Los de validación
 * (class-validator) llegan en inglés: aquí se agrupan por campo y se traducen.
 */
import { ApiError } from "./client";
import type { ApiErrorBody } from "./types";

/** El navegador no llegó al BFF, o el BFF no llegó a bk-crm: es un problema de conexión, no de datos. */
export function isConnectionError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 502 || error.code === "BACKEND_UNAVAILABLE");
}

/** bk-crm respondió 503 sin `code`: algo está apagado en el servidor (WhatsApp, Messenger, Samanta…). */
export function isDisabledInServer(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503 && error.code === undefined;
}

/** 400 de validación de DTO: el body traía `message` como array. */
export function isValidationError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 400 && Array.isArray((error.body as ApiErrorBody | null)?.message);
}

export interface FieldErrors {
  /** Textos en español por ruta del campo: "email", "roles", "schedules.0", "schedules.0.openTime"… */
  fields: Record<string, string[]>;
  /** Mensajes sin campo. «property x should not exist» indica un body mal armado por el frontend. */
  other: string[];
}

const PATH_SEGMENT = /^(?:\d+|[a-z][A-Za-z0-9]*)$/;

/** Separa la ruta del campo del resto del mensaje; null si el mensaje no empieza por un campo. */
export function splitValidationMessage(message: string): { path: string; rest: string } | null {
  if (/(?:^|\.)property \S+ should not exist$/.test(message)) return null;
  const each = /^(?:(\S+)\.)?each value in (?:nested property )?(\w+) (.+)$/.exec(message);
  if (each) return { path: each[1] ?? each[2]!, rest: each[3]! };
  const unique = /^All (\w+)'s elements must be unique$/.exec(message);
  if (unique) return { path: unique[1]!, rest: "must be unique" };
  const path: string[] = [];
  for (const segment of message.split(" ", 1)[0]!.split(".")) {
    if (!PATH_SEGMENT.test(segment)) break;
    path.push(segment);
  }
  if (path.length === 0) return null;
  const joined = path.join(".");
  return { path: joined, rest: message.slice(joined.length).replace(/^[.\s]+/, "") };
}

const RULES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/^should not be (?:empty|null or undefined)$/, () => "Completa este campo."],
  [/^must match \/\\S\/ regular expression$/, () => "Completa este campo."],
  [/^must be an email$/, () => "Escribe un correo válido."],
  [/^must be longer than or equal to (\d+) characters$/, (m) => (m[1] === "1" ? "Completa este campo." : `Escribe al menos ${m[1]} caracteres.`)],
  [/^must be shorter than or equal to (\d+) characters$/, (m) => `Escribe como máximo ${m[1]} caracteres.`],
  [/^must not be less than (-?[\d.]+)$/, (m) => `El valor mínimo es ${m[1]}.`],
  [/^must not be greater than (-?[\d.]+)$/, (m) => `El valor máximo es ${m[1]}.`],
  [/^must contain at least (\d+) elements$/, (m) => (m[1] === "1" ? "Elige al menos una opción." : `Elige al menos ${m[1]}.`)],
  [/^must contain no more than (\d+) elements$/, (m) => `Elige como máximo ${m[1]}.`],
  [/^must be unique$/, () => "No repitas valores."],
  [/^must be one of the following values: /, () => "Elige una opción de la lista."],
  [/^must be a UUID$/, () => "Elige una opción de la lista."],
  [/^must be a valid ISO 8601 date string$/, () => "La fecha no es válida."],
  [/^must match .+ regular expression$/, () => "El formato no es válido."],
  [/^must be an integer number$/, () => "Escribe un número entero."],
  [/^must be a number conforming to the specified constraints$/, () => "Escribe un número válido."],
  [/^must be a URL address$/, () => "Escribe una dirección que empiece por http:// o https://."],
];

/** Texto en español para el resto de un mensaje de validación (sin la ruta del campo). */
export function validationText(rest: string): string {
  for (const [pattern, text] of RULES) {
    const match = pattern.exec(rest);
    if (match) return text(match);
  }
  // Una regla en inglés sin traducir, o un mensaje propio de bk-crm, que ya está en español.
  if (/^(?:must|should)\b/.test(rest)) return "Revisa este campo.";
  const sentence = rest.charAt(0).toLocaleUpperCase("es") + rest.slice(1);
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** Agrupa por campo los mensajes de un 400 de validación, ya en español. */
export function fieldErrors(messages: readonly string[]): FieldErrors {
  const fields: Record<string, string[]> = {};
  const other: string[] = [];
  for (const message of messages) {
    const parsed = splitValidationMessage(message);
    if (!parsed) {
      other.push(message);
      continue;
    }
    const text = validationText(parsed.rest);
    const list = (fields[parsed.path] ??= []);
    if (!list.includes(text)) list.push(text);
  }
  return { fields, other };
}
```

Uso en un formulario:

```ts
// ejemplo: src/lib/forms/server-errors.ts — llevar el error de un guardado a los campos del formulario
import { ApiError } from "@/lib/api/client";
import { fieldErrors, isConnectionError, isValidationError } from "@/lib/api/errors";

export interface ServerFormErrors<F extends string> {
  fields: Partial<Record<F, string>>;
  form: string | null;
}

/** `formFields` son los campos que el formulario muestra; las rutas anidadas ("schedules.2.openTime") van a su raíz. */
export function serverFormErrors<F extends string>(error: unknown, formFields: readonly F[]): ServerFormErrors<F> {
  if (isValidationError(error)) {
    const { fields, other } = fieldErrors(error.messages);
    const result: Partial<Record<F, string>> = {};
    let unmatched = other.length > 0;
    for (const [path, texts] of Object.entries(fields)) {
      const field = formFields.find((name) => path === name || path.startsWith(`${name}.`));
      if (!field) unmatched = true;
      else if (!result[field]) result[field] = texts[0];
    }
    return { fields: result, form: unmatched ? "No se pudo guardar. Revisa los datos e inténtalo de nuevo." : null };
  }
  if (isConnectionError(error)) return { fields: {}, form: "No se pudo conectar con el servidor. Inténtalo de nuevo." };
  if (error instanceof ApiError) return { fields: {}, form: error.messages.join(" ") };
  return { fields: {}, form: error instanceof Error ? error.message : "Ocurrió un error inesperado." };
}
```

### 4.3 Mensajes de negocio

Los 400, 403, 404 y 409 con `message` de tipo string vienen en español y ya están escritos para el usuario: muéstralos tal cual. Algunos piden, además, una reacción de la UI:

| Mensaje | Código | Reacción |
|---|---|---|
| `Configura el restaurante antes de crear solicitudes o reservas` | 409 | Enlaza a Ajustes › Empresa (solo ADMIN puede configurarlo). |
| `El responsable de aprobación debe estar activo` · `El responsable de aprobación debe tener el rol OWNER` | 400 | Lleva a Ajustes › Samanta para elegir otro responsable. |
| `Ventana de WhatsApp cerrada; se requiere una plantilla aprobada` · `Ventana de Messenger cerrada; el cliente debe enviar un nuevo mensaje` · `Ventana de Instagram cerrada; el cliente debe enviar un nuevo mensaje` | 409 | Deshabilita el editor hasta que llegue otro `INBOUND`. |
| `Idempotency-Key ya utilizada con otros datos` (enviar) · `Idempotency-Key utilizada con otros datos` (generar) | 409 | Genera una clave nueva: desde el primer intento cambió el texto, el mensaje fuente del borrador o el usuario. |
| `El borrador cambió; vuelve a revisarlo` | 409 | Relee el borrador y muestra el texto nuevo antes de aprobar. |
| `Borrador desactualizado o fallido; genera uno nuevo` | 409 | Ofrece «Generar otro». |
| `El borrador no está disponible para revisión` | 409 | Relee el borrador: sigue en `GENERATING` o ya está `APPROVED` o `REJECTED`. Repetir un aprobar o un rechazar con el mismo usuario y la misma `revision` no da este error: devuelve el borrador. |
| `Samanta está pausada en esta conversación` | 409 | Ofrece «Reanudar». |
| `No se puede desactivar al último administrador activo` · `No se puede retirar el rol al último administrador activo` | 409 | Revierte el cambio optimista. |
| `Ya existe un usuario registrado con este correo` · `Ya existe un cliente con ese teléfono o correo` · `Ya existe una categoría comercial con ese nombre` | 409 | Marca el campo. |
| `Validation failed (uuid is expected)` | 400 | Un id mal formado en la URL: trátalo como «No se encontró». |
| `Debes proporcionar al menos un campo para actualizar` · `Proporciona al menos un campo para actualizar` | 400 | Es un error de la UI: no envíes un PATCH sin cambios (deshabilita «Guardar», como hace `useDraft`). |

Conflictos de concurrencia: la operación chocó con otra. Refresca y deja que la persona repita la acción.

| Mensaje | Módulo |
|---|---|
| `La operación entró en conflicto con otro cambio; inténtalo nuevamente` | Usuarios |
| `La configuración entró en conflicto con otro cambio; inténtalo nuevamente` | Configuración |
| `La operación comercial entró en conflicto; inténtalo nuevamente` | Catálogo |
| `Conflicto concurrente; vuelve a intentarlo` | Clientes, solicitudes y reservas |
| `Conflicto de mensajería; vuelve a intentarlo` | Bandeja y Samanta (en los POST idempotentes, repite con la misma clave) |

### 4.4 Qué hacer según el código

| Código | Origen | Qué hacer en la UI |
|---|---|---|
| 0 | El navegador no llegó al BFF | «No se pudo conectar…». Conserva los datos que ya había. TanStack Query reintenta las consultas; en una mutación, ofrece «Reintentar» (con la misma clave si es idempotente). |
| 400 con `message` array | Validación del DTO | `fieldErrors` / `serverFormErrors` ([§4.2](#42-errores-de-validación-por-campo)). |
| 400 con `message` string | Regla de negocio o `:id` inválido | Muestra el texto ([§4.3](#43-mensajes-de-negocio)). |
| 401 | Siempre del BFF: `NO_SESSION` o `SESSION_EXPIRED` | Nada en la pantalla: `apiFetch` emite `crm:session-expired` y `SessionProvider` lleva a `/login?motivo=sesion`. No reintentes. |
| 403 | Falta de rol (`No tienes permisos para realizar esta acción`) o una regla de asignación (`Solo puedes tomar conversaciones libres o desasignarte de las propias`, `Conversación asignada a otro operador`, `Un operador solo puede tomar una reserva libre o gestionar su propia asignación`) | Muestra el texto y refresca el recurso: cambió la asignación. Si es de rol, invalida `qk.me`. Oculta de antemano lo que el rol no puede hacer. |
| 404 | El recurso no existe (`Cliente no encontrado`…) o la ruta no existe (`Cannot GET …`; `Ruta no disponible.` del BFF) | En un detalle, «No se encontró» con enlace a la lista. En modo mock, `Cannot <MÉTODO> <ruta>` significa que esa ruta no está en el mock. |
| 409 | Estado que no permite la acción, duplicado, idempotencia o concurrencia | Muestra el texto y refresca ([§4.3](#43-mensajes-de-negocio)). |
| 413 | Body de más de 100 kb (`El cuerpo de la petición supera el tamaño máximo permitido`) | «El contenido es demasiado largo». Pon `maxLength` en los textos largos. |
| 415 | `unsupported charset "<CHARSET>"`: el `Content-Type` trae un `charset` que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion) | No ocurre con `apiFetch`, que envía `application/json` sin charset. |
| 429 | Login y recuperación (texto del BFF); `Límite de generación de Samanta alcanzado` | Muestra el texto y deshabilita la acción un rato. En Samanta no se sabe si se agotó el límite diario o el de generaciones simultáneas. |
| 500 | `Ocurrió un error interno`, con `path`, `method` y `timestamp` | «El servidor tuvo un error interno» con «Reintentar». Guarda `timestamp` para soporte. |
| 502 | Solo en `/api/auth/*` (bk-crm respondió algo inesperado) o en un proxy delante de ft-crm | Igual que la falta de conexión. |
| 503 sin `code` | bk-crm: `WhatsApp no está habilitado`, `Messenger no está habilitado`, `Instagram no está habilitado`, `El envío por Instagram no está configurado`, `Samanta está desactivada`, `La zona horaria del restaurante no es válida` | Una función está apagada en el servidor (`isDisabledInServer`): muestra el texto y deshabilita la acción. No digas «sin conexión». |
| 503 o 504 con `BACKEND_UNAVAILABLE` | El BFF no llegó a bk-crm: red, servidor caído o más de 15 s (65 s al generar un borrador) | «No se pudo conectar» (`isConnectionError`). Antes de repetir un POST que no es idempotente, refresca: pudo completarse. |

`ApiError.isUnavailable` es `true` con 0, 502, 503 y 504, sin mirar `code`. Hoy no causa errores visibles: ninguna consulta (`GET`) responde 503 sin `code`, y al enviar, `sendErrorText` ya separa el 503 (solo trata como falta de conexión 0, 502 y 504). El riesgo está en el código nuevo. Las rutas que sí responden 503 sin `code` (generar, editar y aprobar borradores de Samanta; crear solicitudes y reservas con una zona horaria inválida) no deben pasar por `isUnavailable` ni por `actionErrorText` (`use-conversation-actions.ts`), que ante cualquier 503 responde «No se pudo conectar con el servidor.». Usa `isConnectionError` e `isDisabledInServer`.

Códigos que pone el BFF (`ApiErrorBody.code`):

| `code` | Estado | `message` | Cuándo |
|---|---|---|---|
| `NO_SESSION` | 401 | `Inicia sesión para continuar.` | No hay cookies de sesión |
| `SESSION_EXPIRED` | 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` | Hacía falta renovar y no había cookie `crm_rt`, el refresh respondió 400 o 401, o bk-crm siguió respondiendo 401 tras renovar: logout, usuario desactivado, contraseña restablecida o sesión de más de 7 días. Además, borra las cookies. |
| `BACKEND_UNAVAILABLE` | 503 | `No se pudo conectar con el servidor del CRM. Inténtalo de nuevo en unos segundos.` | Error de red hacia bk-crm, o el refresh falló por otro motivo (la sesión sigue abierta) |
| `BACKEND_UNAVAILABLE` | 504 | `El servidor del CRM tardó demasiado en responder. Inténtalo de nuevo.` | Se superó `CRM_BACKEND_TIMEOUT_MS` (65 s al generar un borrador) |

Si el BFF renovó la sesión y justo después la llamada a bk-crm da 503 o 504, la respuesta no lleva las cookies nuevas. El BFF recuerda esa renovación 60 s en memoria, así que un reintento dentro de ese plazo la recupera.

## 5. Reglas transversales

### Fechas y zona horaria

- **Lectura.** La API devuelve instantes ISO 8601 en UTC con milisegundos. Muéstralos siempre en `useRestaurant().timeZone` con los helpers de `src/lib/format/dates.ts`, nunca en la zona del navegador.
- **Zona por defecto.** Mientras no hay configuración, `DEFAULT_TIME_ZONE` es `America/Lima`. Estadísticas ya espera a conocer la zona antes de calcular el periodo; haz lo mismo en cualquier vista que calcule rangos.
- **Envío.** Usa instantes con segundos y zona (`ISO_INSTANT_PATTERN`). Sirven `toISOString()` y el `toISOString()` de un `TZDate`, que incluye el desplazamiento. Para un día y una hora elegidos en la UI, usa `zonedDateTime(día, hora, timeZone)`: crea el instante en la zona del restaurante.
- **Rangos.** `dateFrom` es inclusivo y `dateTo` exclusivo. Usa la medianoche de la zona del restaurante, como `zonedMidnightIso` (Calendario) y `periodRange` (Estadísticas).
- **Fechas futuras.** Crear solicitudes y reservas, editar su fecha y reprogramar exigen una fecha posterior a la hora del servidor. Valida con margen en el cliente; el 400 del backend es el que manda.
- **Hora de la reserva.** `IN_SERVICE` y `NO_SHOW` exigen que haya llegado la hora (`canSetReservationStatus` usa el reloj del dispositivo; el del servidor manda).
- **Almacenamiento.** Desde el 3/11/2026 bk-crm también guarda las fechas en UTC. Es un cambio interno: el formato de la API no cambia.

### Importes

- Son strings (`MoneyString`). Envíalos como texto que cumpla `MONEY_PATTERN`: de `"0"` a `"99999999.99"`, punto decimal, sin separador de miles y con hasta 2 decimales. No los conviertas a `number` para enviarlos.
- La API los devuelve siempre con 2 decimales (`"38.5"` → `"38.50"`).
- Muéstralos con `formatMoney(importe, currency)` y la moneda de `useRestaurant()` (`PEN` por defecto).
- En las solicitudes, `quotedPrice` y `currency` van juntos. Si mandas precio sin moneda, el backend usa la del restaurante.

### Bodies y `null`

- Envía solo los campos que declara el DTO: cualquier otro responde 400 `property <campo> should not exist`. Nunca reenvíes una respuesta del GET; arma el body campo a campo, como `toPutRequest`.
- En un POST, omite los opcionales vacíos.
- En un PATCH, omitir un campo lo conserva y `null` lo borra, si el campo lo admite (cada módulo dice cuáles no).
- Un texto vacío o con solo espacios responde 400: para borrar, envía `null`.
- Un PATCH sin campos responde 400. Deshabilita «Guardar» si no hay cambios.
- Booleanos y números van como tipos JSON en el body (`true`, `5`), no como texto. En la query, `toSearch` los convierte a texto y omite los vacíos.
- El body admite hasta 100 kb.

### Idempotencia y reintentos

| Operación | ¿Repetirla duplica? | Cómo reintentar |
|---|---|---|
| `POST /conversations/:id/messages` | No, con la misma `Idempotency-Key` | Misma clave y mismo texto (el Composer ya guarda la clave en `pendingKey`) |
| `POST /conversations/:id/assistant-drafts` | No, con la misma `Idempotency-Key` | Misma clave y misma fuente (ver `useGenerateDraft` en [Bandeja](#bandeja)) |
| Aprobar o rechazar un borrador | No: el mismo usuario con la misma `revision` recibe el mismo resultado | Repite tal cual |
| PATCH y PUT | No: dejan el mismo estado (puede cambiar `updatedAt`) | Repite tal cual |
| Editar un borrador (`PATCH …/assistant-drafts/:draftId`) | No duplica, pero cada edición suma 1 a `revision`: si la primera llegó, el reintento responde 409 `El borrador cambió; vuelve a revisarlo` | Pide el borrador y compara su `content` antes de repetir |
| `POST /customers/:id/interests` | No: actualiza el interés existente (200) | Repite tal cual |
| `DELETE /customers/:id/interests/:commercialItemId` | La segunda vez responde 404 `Interés no encontrado` | Trata ese 404 como hecho |
| `POST /users`, `POST /customers`, `POST /commercial-categories` | No crean duplicados: un correo, teléfono o nombre repetido responde 409 | Refresca y revisa |
| `POST /commercial-items`, `POST /reservation-requests`, `POST /reservations`, `POST /reservations/:id/notes` | Sí: cada intento crea un registro | Tras un 504 o un error de red, refresca la lista antes de reintentar |
| Login, `forgot-password` y `reset-password` | Cuentan para el límite de intentos | No reintentes automáticamente |

- Cada acción del usuario lleva una clave nueva (`newIdempotencyKey()`). Reutilízala solo para repetir esa misma acción. No uses el prefijo `samanta-`: bk-crm lo reserva para aprobar borradores.
- El BFF repite una vez la llamada tras un 401 de bk-crm, con las mismas cabeceras (también `Idempotency-Key`). Es seguro: bk-crm rechazó la primera antes de ejecutarla.
- Mantén `retry: false` en las mutaciones.

### Paginación con `collectPages`

- **Límites.** `limit` va de 1 a 100. Por defecto es 20, y 50 en conversaciones y mensajes. `page` va de 1 a 1 000 000: lee la de la URL con `parsePage`.
- **Sin resultados.** `totalPages` vale 0. Una página mayor que `totalPages` devuelve `data: []` con `total > 0`: ofrece volver a la primera, como Clientes.
- **Sin paginar.** `GET /users`, `GET /commercial-categories` y `GET /conversations/:id/assistant-drafts` (hasta 50) devuelven todo de una vez.
- **Mensajes.** La página 1 trae lo más reciente (`sequence` descendente). «Cargar anteriores» pide la página siguiente y deduplica por `id`, como `mergeMessages`.
- **`collectPages(fetchPage, maxPages = 20)`.** Lee la página 1 con `limit` 100 y después, en paralelo, hasta `maxPages`. Devuelve `{ rows, total, truncated }`:
  - úsalo solo donde hace falta el periodo completo: Calendario, Estadísticas y la pestaña Esperando;
  - muestra un aviso cuando `truncated` es `true`;
  - deduplica por `id`: si los datos cambian mientras se leen las páginas, la paginación por desplazamiento puede repetir o saltar filas (`groupByDay` ya deduplica).

### Polling

No hay WebSockets ni SSE. Intervalos actuales de ft-crm:

| Datos | Intervalo | Dónde |
|---|---|---|
| `qk.me` | 5 min (`staleTime` 60 s) | `src/lib/auth/session.tsx` |
| Lista de la Bandeja, contador y conversación abierta | 6 s (`NEXT_PUBLIC_INBOX_POLL_MS`, mínimo 2 s) | `use-inbox.ts` |
| Chat | 4 s (`NEXT_PUBLIC_CHAT_POLL_MS`, mínimo 1,5 s); 1,5 s con salientes en `QUEUED` o `SENDING` | `use-inbox.ts` |
| Solicitudes de la Bandeja y del panel | 30 s | `use-inbox.ts`, `customer-panel.tsx` |
| Borrador en `GENERATING` (propuesta) | 2–3 s | `useAssistantDraft` en [Bandeja](#bandeja) |
| Calendario y detalle de reserva | 60 s | `calendario-view.tsx`, `reservation-detail.tsx` |
| Clientes | 60 s | `clientes-view.tsx` |
| Solicitudes | 30 s | `solicitudes-view.tsx` |
| Estadísticas, Ajustes y Usuarios | Sin polling | — |

- TanStack Query pausa el `refetchInterval` cuando la pestaña no está visible y vuelve a consultar al recuperar el foco (`refetchOnWindowFocus: true` en `providers.tsx`).
- Estas rutas no tienen límite de peticiones en bk-crm. Si el backend pide bajar la frecuencia, cambia las variables `NEXT_PUBLIC_*`.
- Con `MESSAGING_ENABLED=true`, el worker de bk-crm procesa la cola cada 2 s. Con `false` no hay worker: los mensajes ya guardados se quedan en `RECEIVED` o `QUEUED`.

## 6. De mock a live: lista de comprobación

El mock (`src/lib/mock/server.ts`, `seed.ts` y `simulator.ts`) implementa 28 de las 53 rutas que el navegador pide por `/api/backend`. Esta lista se verificó contra el código actual de ft-crm.

### 6.1 Qué hace distinto el mock

| Área | Mock | bk-crm | Qué revisar en live |
|---|---|---|---|
| Rutas | Las 25 rutas nuevas de la [sección 2](#21-endpointsts) no existen: responde 404 `Cannot <MÉTODO> <ruta>`. | Existen todas. | Implementa en el mock las que uses, o prueba esas pantallas solo en live. |
| Sesión | Tokens sin firma (`alg: none`) y contraseña común `demo1234` (`CRM_MOCK_PASSWORD`). Sin límite de intentos. `forgot-password` no envía nada. `reset-password` acepta cualquier token de 64 hexadecimales y no cambia la contraseña ni cierra sesiones. | JWT firmados y contraseña de cada usuario. 429 al pasar el límite: 5 logins, 3 pedidos de recuperación o 5 restablecimientos cada 60 s. Correo real (Resend). El reset cierra todas las sesiones. | El 429 de login y el enlace real de recuperación. |
| Usuarios | `POST /users` con `roles: []` responde 400 con un string (`Debes asignar al menos un rol`). No valida el formato del email. `PATCH /users/:id/roles` cambia `updatedAt`. La regla del último ADMIN no mira si el usuario está activo. | Mensajes de class-validator en array (`roles must contain at least 1 elements`, `email must be an email`). Cambiar roles no toca `updatedAt`. La regla solo aplica a un ADMIN activo. | `createUserErrorTarget` y los errores por campo. |
| Configuración | Arranca configurado. El PUT valida poco: URL con una regex simple; no valida email, zona horaria ni decimales de las coordenadas. | 404 hasta el primer PUT y DTO completo. | `SetupForm` y los errores por campo de Empresa. |
| Catálogo | Elementos `APPROVED` por defecto. `POST /commercial-items` acepta solo 7 campos. Categorías ordenadas solo por `displayOrder`. | 86 elementos en `DRAFT` (9 sin `nameEs`), DTO completo y orden `displayOrder`, `nameEs`, `nameEn`. | Aprobar el catálogo y tener un editor. |
| Clientes | Casi todos con nombre y todos con teléfono, también los de `FACEBOOK`. `PATCH /customers/:id/status` no valida el enum. | WhatsApp: sin nombre. Messenger e Instagram: sin teléfono ni email. Enum validado. | Textos de respaldo del nombre. |
| Solicitudes | El simulador las lleva a `WAITING_RESPONSE`, `ACCEPTED` o `REJECTED`. | Solo `INCOMPLETE_DATA`, `READY_TO_SEND` y `CANCELLED`. | KPI y pestañas en 0. |
| Reservas | Hay reservas que nacen de solicitudes aceptadas (`reservationRequestId` con valor). | Solo `POST /reservations` (ADMIN); `reservationRequestId` siempre `null`. | Calendario vacío y la píldora «Registrada en el CRM». |
| Envío | `WHATSAPP`, `FACEBOOK` e `INSTAGRAM` (`isSendableChannel`, desde el 8/11); en otro canal, 400 `Conversación sin destinatario habilitado`. Topes de 4096, 2000 y 1000 caracteres y, en Instagram, 1000 bytes, con los textos de bk-crm. Nunca 503 ni 409 `Conflicto de mensajería`. | Lo mismo, más el 503 con el canal apagado (o con Instagram sin `INSTAGRAM_ACCESS_TOKEN`). Instagram solo entrega a cuentas con un rol en la app de Meta (acceso estándar). | Los 503 y la entrega real en Instagram. |
| Estados de envío | `QUEUED` → `SENT` (1,2 s) → `DELIVERED` (2,6 s); Instagram se queda en `SENT`. | Dependen de `MESSAGING_ENABLED`, Redis y Meta. `READ` solo en WhatsApp; Instagram termina en `SENT`; también `FAILED` y `UNKNOWN`. | Textos de `FAILED` y `UNKNOWN`. |
| Samanta | El simulador escribe `OUTBOUND` sin autor y ya `DELIVERED`. Regla de «más de 20 personas». | Borradores revisados por una persona; todo `OUTBOUND` tiene autor; no existe la regla de 20 personas. | `messageAuthor` y el panel de borradores. |
| Validación | Mensajes genéricos (p. ej. `page must not be less than 1` para cualquier página inválida). Nunca 413, 415 ni 429. | Mensajes exactos de class-validator. | `fieldErrors`. |
| Salud | `/api/listo` responde `{ "estado": "ok", "backend": "simulado" }` sin consultar nada. | `/api/listo` consulta `GET /health`. | Que `/api/listo` dé `"disponible"`. |
| Simulador | `/api/dev/simulador` hace de cliente, de Samanta y del dueño. | Responde 404 `El simulador solo está disponible en modo mock.` | Las pruebas e2e (`e2e/*.spec.ts`) dependen de él: son solo de modo mock. |

### 6.2 Lista de comprobación

Configuración y datos:
- [ ] `.env.local` con `CRM_BACKEND_MODE=live` y `CRM_BACKEND_URL` ([§7](#72-ft-crm-en-modo-live)).
- [ ] `/api/salud` responde `"modo": "live"` y `/api/listo`, 200 con `"backend": "disponible"`.
- [ ] Entras con el ADMIN del seed y creas un usuario OWNER y otro OPERATOR en Ajustes › Usuarios.
- [ ] Ajustes › Empresa crea la configuración (pantalla inicial con 404) y Horarios abre los días.
- [ ] Ajustes › Servicios aprueba los elementos que Samanta debe ofrecer. Los 9 sin `nameEs` necesitan el editor.

Capa de API y errores:
- [ ] La [sección 2](#2-capa-de-api) está aplicada; `npm run typecheck`, `npm test` y `npm run lint` pasan.
- [ ] `servicios-logic.test.ts` completa `promotionDetail`.
- [ ] Las acciones nuevas (Samanta y altas de solicitudes y reservas) distinguen una función apagada (503 sin `code`, `isDisabledInServer`) de la falta de conexión (`isConnectionError`), y `sendErrorText` elige los textos de ventana y destinatario según el canal.

Sesión:
- [ ] El login limpia la caché antes de navegar.
- [ ] El sexto intento de login en 60 s muestra el texto del 429.
- [ ] La recuperación llega por correo (con `RESEND_API_KEY`) y el enlace abre `/reset-password`.

Bandeja:
- [ ] Messenger: envío, tope de 2000, ventana de 24 h y textos `MESSENGER_*`.
- [ ] Instagram: envío sin teléfono, tope de 1000 caracteres y 1000 bytes UTF-8, ventana de 24 h, textos `INSTAGRAM_*`, los dos 503 de Instagram y último estado `SENT`. Pruébalo con una cuenta que tenga un rol en la app de Meta.
- [ ] Plantillas de WhatsApp (9/11): el aviso de una reserva de la web se ve como de Samanta y `WHATSAPP_TEMPLATE_EXPIRED` tiene texto.
- [ ] Respaldo «Cliente de Messenger» y «Cliente de Instagram» en la lista, el chat, Clientes, Solicitudes y Calendario.
- [ ] `messageAuthor` ya no supone que un `OUTBOUND` sin autor es de Samanta.
- [ ] Panel de borradores de Samanta, con el aviso de `Samanta está desactivada` cuando `SAMANTA_ENABLED=false`.
- [ ] Con `WHATSAPP_ENABLED=false`, enviar avisa que WhatsApp no está habilitado (hoy `sendErrorText` muestra «El envío por WhatsApp no está habilitado en el servidor.») y no «sin conexión».
- [ ] Panel derecho sin el texto «Samanta la crea…», con «Nueva solicitud».

Solicitudes, Calendario, Clientes y Estadísticas:
- [ ] Pestañas y KPI del flujo del dueño ocultos o marcados como «Próximamente».
- [ ] «Nueva solicitud», «Nueva reserva» (solo ADMIN) y las ediciones de [03](03-clientes-reservas.md#funciones-y-claves-de-caché-en-ft-crm).
- [ ] Textos «aceptadas por el dueño» y «No se puede deshacer» corregidos.
- [ ] `parsePage` en Solicitudes.
- [ ] Las escrituras de solicitudes y reservas invalidan `qk.statsAll`.

Mock y pruebas:
- [ ] El mock responde las rutas nuevas como bk-crm, o al menos las pantallas nuevas muestran bien su 404.
- [ ] El mock usa `Conversación sin destinatario habilitado`, acepta `FACEBOOK` con tope de 2000 e `INSTAGRAM` con tope de 1000 caracteres y 1000 bytes (400 con los textos de Instagram), no lleva a `DELIVERED` los salientes de Instagram, y su `POST /users` con `roles: []` responde como bk-crm.
- [ ] Los `Message` y los `ReservationRequest` del mock traen `templateName` y `externalReference` (9/11).
- [ ] Las pruebas e2e siguen en modo mock; el modo live se prueba a mano con la [sección 7](#7-cómo-probar-contra-el-backend-real).

## 7. Cómo probar contra el backend real

### 7.1 bk-crm en local

1. **Requisitos.** Node.js y PostgreSQL. Redis solo hace falta para encender WhatsApp, Messenger o Instagram, que exigen `MESSAGING_ENABLED=true` y `REDIS_URL` (`bk-crm/docs/redis-docker.md`). Samanta necesita el canal encendido incluso para generar, porque comprueba el envío antes de llamar a la IA, y aprobar envía por el canal de la conversación: para probarla también necesitas Redis.
2. **`.env`.** Cópialo de `.env.example` y ajusta:
   - `DATABASE_URL`: tu PostgreSQL local.
   - `JWT_SECRET` y `JWT_REFRESH_SECRET`: dos valores distintos.
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD`: serán tu usuario ADMIN.
   - `WHATSAPP_ENABLED=false`. `.env.example` trae `true` con las credenciales vacías, y así bk-crm no arranca (`WHATSAPP_ACCESS_TOKEN requerida`).
   - `MESSAGING_ENABLED=false` si no tienes Redis. Entonces WhatsApp, Messenger e Instagram tienen que estar apagados (si no, bk-crm no arranca: `WhatsApp requiere MESSAGING_ENABLED y REDIS_URL` o `Instagram requiere MESSAGING_ENABLED y REDIS_URL`), y enviar responde 503.
   - `MESSENGER_ENABLED=false`, `INSTAGRAM_ENABLED=false` y `SAMANTA_ENABLED=false`, como en `.env.example`. Para probar Instagram, configura `INSTAGRAM_ENABLED=true`, `INSTAGRAM_ACCOUNT_ID`, `INSTAGRAM_VERIFY_TOKEN` y `META_APP_SECRET`; para responder, además `INSTAGRAM_ACCESS_TOKEN` e `INSTAGRAM_API_VERSION` (p. ej. `v26.0`). Guía: `bk-crm/docs/instagram-webhook.md`.
   - `FRONTEND_RESET_PASSWORD_URL=http://localhost:5173/reset-password`, que ya es el valor del ejemplo.
   - `RESEND_API_KEY`: una clave real solo si quieres recibir el correo de recuperación (con el remitente de prueba `onboarding@resend.dev`, Resend solo entrega al dueño de la cuenta). No la dejes vacía: bk-crm no arranca (`RESEND_API_KEY no está configurada`). Con el valor del ejemplo arranca, pero el correo no sale y la respuesta de `forgot-password` es la misma.
3. **Base de datos y arranque.**

   ```bash
   npm install
   npx prisma generate
   npx prisma migrate dev
   npx prisma db seed
   npm run start:dev
   ```

   bk-crm queda en `http://localhost:3000`. El seed crea los roles, el ADMIN y el catálogo (16 categorías y 86 elementos en `DRAFT`). No crea la configuración del restaurante.
4. **Conversación de demostración** (opcional, solo con PostgreSQL local). En PowerShell:

   ```powershell
   $env:ALLOW_MESSAGING_DEMO = 'true'
   npx tsx scripts/seed-messaging-demo.ts
   Remove-Item Env:ALLOW_MESSAGING_DEMO
   ```

   Crea un cliente ficticio (`messaging.demo@example.com`) con una conversación de WhatsApp y dos mensajes entrantes. El script fuerza `MESSAGING_ENABLED=false`, así que solo funciona con `WHATSAPP_ENABLED=false`, `MESSENGER_ENABLED=false` e `INSTAGRAM_ENABLED=false`; si no, falla con `No se pudo preparar la demo`. Ese cliente no tiene teléfono: con WhatsApp habilitado, responderle daría 400 `Conversación sin destinatario habilitado`.

### 7.2 ft-crm en modo live

En `ft-crm/.env.local`:

```ini
CRM_BACKEND_MODE=live
CRM_BACKEND_URL=http://localhost:3000
```

Reinicia `npm run dev` (puerto 5173): el BFF lee las variables una sola vez. Comprueba:
- `http://localhost:5173/api/salud` → `{"estado":"ok","modo":"live"}`;
- `http://localhost:5173/api/listo` → 200 `{"estado":"ok","backend":"disponible"}`. Si responde 503, `backend` dice `no disponible` (bk-crm no contestó; `motivo` es `timeout`, `network` o `error`) o `respondió <código>` (bk-crm contestó con error, p. ej. 503 con la base de datos caída; sin `motivo`).

Variables del BFF (`src/lib/server/env.ts`; las `NEXT_PUBLIC_*` las lee `src/lib/config.ts` en el navegador):

| Variable | Por defecto | Uso |
|---|---|---|
| `CRM_BACKEND_MODE` | `live` si no está definida (`.env.example` trae `mock`) | `live` llama a bk-crm; `mock`, al backend simulado |
| `CRM_BACKEND_URL` | `http://localhost:3000` | URL de bk-crm, sin barra final. Solo la usa el servidor. |
| `CRM_BACKEND_TIMEOUT_MS` | `15000` (de 1000 a 120000) | Techo de cada llamada. Generar un borrador usa al menos 65 000. |
| `CRM_COOKIE_SECURE` | `true` en producción | Cookies `Secure`: en producción hace falta HTTPS. |
| `CRM_ALLOW_MOCK_IN_PRODUCTION` | `false` | El modo mock no arranca en producción salvo que esto sea `true`. |
| `NEXT_PUBLIC_INBOX_POLL_MS`, `NEXT_PUBLIC_CHAT_POLL_MS` | `6000`, `4000` | Polling de la Bandeja ([§5](#polling)). |

`CRM_MOCK_PASSWORD`, `CRM_ENABLE_SIMULATOR` y `CRM_MOCK_LATENCY_MS` no tienen efecto en modo live.

### 7.3 Escenarios que conviene probar

| Escenario | Cómo provocarlo | Qué debe pasar |
|---|---|---|
| Primer arranque | Base recién creada con el seed | Ajustes › Empresa muestra la configuración inicial al ADMIN; OWNER y OPERATOR ven un aviso. |
| Roles | Entra como OWNER, OPERATOR y SUPPORT | OWNER solo lee. OPERATOR opera, pero no configura, no gestiona usuarios ni crea reservas. SUPPORT no tiene vistas. |
| Sesión revocada | Con un ADMIN, desactiva a otro usuario con sesión abierta | En su siguiente llamada, ese usuario vuelve a `/login?motivo=sesion`. |
| Límite de login | Seis intentos con el mismo correo en 60 s | `Hiciste demasiados intentos…` |
| Canal apagado | `WHATSAPP_ENABLED=false` y responde en una conversación de WhatsApp | El aviso de que WhatsApp no está habilitado (bk-crm responde 503 `WhatsApp no está habilitado`), no «sin conexión». |
| Instagram sin token de envío | `INSTAGRAM_ENABLED=true` sin `INSTAGRAM_ACCESS_TOKEN` y responde en una conversación de Instagram | bk-crm responde 503 `El envío por Instagram no está configurado`: aviso de función apagada, no «sin conexión». |
| Bytes en Instagram | Escribe en una conversación de Instagram un texto de menos de 1000 caracteres con muchas tildes o emojis (p. ej. 600 «á») | El contador cuenta bytes y no deja enviar más de 1000. Si llegara al backend, respondería 400 `Instagram admite hasta 1000 bytes por respuesta; las tildes y los emojis ocupan más de uno`. |
| Samanta apagada | `SAMANTA_ENABLED=false` y pulsa «Generar» | Aviso de `Samanta está desactivada` y el botón deshabilitado. |
| Backend caído | Detén bk-crm | `/api/listo` da 503. Las vistas muestran «No se pudo cargar» o conservan sus datos con un aviso, sin mostrar listas vacías. |
| Restaurante sin configurar | Crea una solicitud antes de configurar | 409 `Configura el restaurante antes de crear solicitudes o reservas`, con enlace a Empresa. |

### 7.4 Guías Postman de bk-crm

Sirven para separar un fallo del frontend de uno del backend: si Postman da la misma respuesta, el problema está en bk-crm. Llaman a bk-crm directamente, con `Authorization: Bearer`. Por eso ves los 401 propios de bk-crm, que en el navegador siempre traduce el BFF.

| Guía (`bk-crm/docs/`) | Qué cubre |
|---|---|
| `customers-postman.md` | Clientes e intereses comerciales |
| `reservations-postman.md` | Solicitudes de reserva y reservas; recuerda que sin configuración del restaurante crearlas da 409 |
| `reservation-calendar-postman.md` | Responsable, observaciones y reprogramación de reservas |
| `messaging-postman.md` | Conversaciones, mensajes, lectura, pausa y asignación; script de demostración |
| `whatsapp-postman.md` | WhatsApp Cloud API: webhook, envío y estados |
| `messenger-postman.md` | Activación y prueba controlada de Messenger |
| `instagram-webhook.md` | Activación del webhook de Instagram y respuestas desde el CRM |
| `samanta-postman.md` | Borradores de Samanta |
| `redis-docker.md` | Redis local para los workers |

- Algunas guías son anteriores a los cambios del 3/11. Si contradicen esta carpeta, sigue esta carpeta y avisa al equipo de backend.
- Con credenciales reales de WhatsApp, Messenger o Instagram, enviar desde la Bandeja manda mensajes reales. Usa un número, una página o una cuenta de Instagram de prueba. Con acceso estándar, Meta solo entrega en Instagram a cuentas con un rol en la app.
