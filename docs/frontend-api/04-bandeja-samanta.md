# Bandeja: conversaciones, mensajes (WhatsApp, Messenger e Instagram) y borradores de Samanta

> Parte de la [referencia de la API de bk-crm para el frontend](README.md). Estado: 3 de noviembre de 2026, con el modo automático de Samanta del 8 de noviembre ([Samanta automática](#samanta-automática)), el envío por Instagram (bk-crm lo tiene desde el 4/11; esta página se corrigió el 8/11) y los cambios del 9/11: plantillas de WhatsApp, botones y solicitudes del cliente en el contexto de Samanta.
>
> Desde el navegador, cada ruta se pide como `/api/backend<ruta>` y el BFF añade el token. Las convenciones comunes (errores, sesión, roles, paginación, fechas e idempotencia) están en el [README](README.md#convenciones-generales); lo propio de este módulo, en [Convenciones de este módulo](#convenciones-de-este-módulo).

Bandeja omnicanal del CRM. Cubre las conversaciones de WhatsApp, Messenger (canal `FACEBOOK`) e Instagram (canal `INSTAGRAM`), el historial, las respuestas de texto en esos tres canales, la lectura compartida por el equipo, la asignación de responsable, la pausa del asistente y los borradores de Samanta (IA), que una persona revisa antes de enviar. La usan la Bandeja (lista, filtros y contador de no leídos), la vista de conversación y el panel de Samanta. No hay WebSockets ni SSE: todo se actualiza por polling. Todas las rutas exigen sesión, salvo los webhooks de Meta, que el frontend no usa.

## Índice

- [Convenciones de este módulo](#convenciones-de-este-módulo)
- [Listar conversaciones (bandeja)](#listar-conversaciones-bandeja) — `GET /conversations`
- [Ver detalle de una conversación](#ver-detalle-de-una-conversación) — `GET /conversations/:id`
- [Ver historial de mensajes](#ver-historial-de-mensajes) — `GET /conversations/:id/messages`
- [Enviar un mensaje de texto](#enviar-un-mensaje-de-texto) — `POST /conversations/:id/messages`
- [Marcar como leído hasta un mensaje](#marcar-como-leído-hasta-un-mensaje) — `PATCH /conversations/:id/read`
- [Pausar o reanudar a Samanta en la conversación](#pausar-o-reanudar-a-samanta-en-la-conversación) — `PATCH /conversations/:id/assistant`
- [Asignar, tomar o liberar una conversación](#asignar-tomar-o-liberar-una-conversación) — `PATCH /conversations/:id/assignee`
- [Generar un borrador con Samanta](#generar-un-borrador-con-samanta) — `POST /conversations/:id/assistant-drafts`
- [Listar borradores de Samanta](#listar-borradores-de-samanta) — `GET /conversations/:id/assistant-drafts`
- [Ver un borrador de Samanta](#ver-un-borrador-de-samanta) — `GET /conversations/:id/assistant-drafts/:draftId`
- [Editar un borrador](#editar-un-borrador) — `PATCH /conversations/:id/assistant-drafts/:draftId`
- [Aprobar un borrador y encolar el envío](#aprobar-un-borrador-y-encolar-el-envío) — `POST /conversations/:id/assistant-drafts/:draftId/approve`
- [Rechazar un borrador](#rechazar-un-borrador) — `POST /conversations/:id/assistant-drafts/:draftId/reject`
- [Samanta automática](#samanta-automática) — sin rutas nuevas: qué cambia en la Bandeja cuando Samanta responde sola
- [Webhooks de Meta (no usar desde el frontend)](#webhooks-de-meta-no-usar-desde-el-frontend) — `GET /webhooks/whatsapp` · `POST /webhooks/whatsapp` · `GET /webhooks/messenger` · `POST /webhooks/messenger` · `GET /webhooks/instagram` · `POST /webhooks/instagram`
- [Modelos](#modelos)
- [Estados y transiciones](#estados-y-transiciones)
- [Preguntas abiertas](#preguntas-abiertas)
- [Tipos TypeScript](#tipos-typescript)

## Convenciones de este módulo

### Errores comunes a todas las rutas

- **Orden.** Las tablas de errores siguen el orden en que se comprueba cada condición. Ante varios problemas, recibes el primero:
  1. las cookies de sesión, en el BFF (401 `NO_SESSION`);
  2. el parser de Express en bk-crm, en este orden: charset que no empieza por `utf-` (415), body de más de 100 kb (413) o JSON mal formado (400);
  3. el token (si bk-crm lo rechaza, el BFF renueva la sesión o responde 401 `SESSION_EXPIRED`);
  4. el rol (403);
  5. la validación del `:id`, de la query y del body (400); entre estas tres no hay un orden garantizado;
  6. las reglas del servicio, en el orden de cada tabla.

  Para no repetir, las tablas ponen el 401 primero y el 413 y el 415 al final.
- **401.** El navegador nunca recibe el 401 de bk-crm. El BFF renueva la sesión y repite la llamada una vez, también los POST (con la misma `Idempotency-Key`). Si no puede, responde 401 `Tu sesión terminó. Vuelve a iniciar sesión.` con `code: "SESSION_EXPIRED"`, o 401 `Inicia sesión para continuar.` con `code: "NO_SESSION"` si no hay cookies ([Sesión](README.md#sesión-srclibserversessionts)).
- **503 de bk-crm o del BFF.** bk-crm responde 503 sin `code` cuando un canal o Samanta están apagados en el servidor: `WhatsApp no está habilitado`, `Messenger no está habilitado`, `Instagram no está habilitado`, `El envío por Instagram no está configurado` (Instagram encendido sin `INSTAGRAM_ACCESS_TOKEN`: recibe, pero no responde) o `Samanta está desactivada`. El BFF responde 503 o 504 con `code: "BACKEND_UNAVAILABLE"` cuando no llega a bk-crm ([Errores que añade el BFF](README.md#errores-que-añade-el-bff)). `ApiError.isUnavailable` es `true` en los dos casos: distingue por `error.code` para no mostrar «sin conexión» ante un canal apagado.
- **409 `Conflicto de mensajería; vuelve a intentarlo`.** Lo pueden devolver todas las rutas que escriben o bloquean la conversación, es decir, todas salvo `GET /conversations`, `GET /conversations/:id`, `GET /conversations/:id/messages` y los `GET` de verificación de los webhooks. Ocurre cuando la transacción choca con otra en sus 5 intentos internos (el primero y 4 reintentos). Repite la misma llamada; en los POST idempotentes, con la misma clave.
- **UUID.** El `:id` y el `:draftId` aceptan cualquier UUID con formato 8-4-4-4-12 (`ParseUUIDPipe`). Los UUID del body y de la query (`customerId`, `assignedUserId`, `throughMessageId`, `sourceMessageId`) usan `@IsUUID()`, que exige además versión 1 a 8 y variante RFC (o el UUID nulo o máximo). Los ids que genera bk-crm son v4 y cumplen siempre; un id inventado a mano como `6f1c2a4e-8b7d-0c1e-0a3f-2d5e7b9c0a14` responde 400 `<campo> must be a UUID`.
- **Otros.** `Recurso de mensajería no encontrado` (404) y `Datos de mensajería inválidos` (400) son traducciones genéricas de errores de la base de datos que en uso normal no aparecen. Un error no controlado responde 500 `Ocurrió un error interno` ([Formato de errores](README.md#formato-de-errores)).

### Actualización por polling

- Con `MESSAGING_ENABLED=true`, bk-crm entrega la cola de mensajes a sus workers y aplica los recibos de Meta cada 2 s. Con `MESSAGING_ENABLED=false` (habitual en desarrollo) no hay workers: los mensajes que ya existen, como los del script de demostración, se quedan en `RECEIVED` o `QUEUED`. Además, habilitar WhatsApp, Messenger o Instagram exige `MESSAGING_ENABLED=true` (si no, bk-crm no arranca; en Instagram: `Instagram requiere MESSAGING_ENABLED y REDIS_URL`), así que en ese modo los canales están apagados y enviar responde 503.
- Intervalos actuales de ft-crm: lista y detalle cada 6 s (`INBOX_POLL_MS`), chat cada 4 s (`CHAT_POLL_MS`) y cada 1,5 s mientras haya salientes en `QUEUED` o `SENDING`.
- Las fechas son ISO 8601 en UTC. Desde el 3/11/2026 bk-crm también las guarda en UTC (`src/database/pg-adapter.ts`); el formato de la API no cambia.

### Funciones y claves de caché nuevas en ft-crm

Las rutas de conversaciones ya tienen su función en `conversationsApi`. Para los borradores de Samanta, agrega a `src/lib/api/endpoints.ts` (tipos en [Tipos TypeScript](#tipos-typescript)):

```ts
export const assistantDraftsApi = {
  /** Espera a la IA (hasta 60 s). Reutiliza la misma clave solo para reintentar esta generación. */
  generate: (conversationId: string, sourceMessageId: string, idempotencyKey: string) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts`, {
      method: "POST",
      body: { sourceMessageId } satisfies GenerateSamantaDraftRequest,
      headers: { "idempotency-key": idempotencyKey },
    }),
  list: (conversationId: string) =>
    apiFetch<SamantaDraftListResponse>(`/conversations/${conversationId}/assistant-drafts`),
  get: (conversationId: string, draftId: string) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts/${draftId}`),
  edit: (conversationId: string, draftId: string, body: EditSamantaDraftRequest) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts/${draftId}`, { method: "PATCH", body }),
  approve: (conversationId: string, draftId: string, revision: number) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts/${draftId}/approve`, {
      method: "POST",
      body: { revision } satisfies ReviewSamantaDraftRequest,
    }),
  reject: (conversationId: string, draftId: string, revision: number) =>
    apiFetch<SamantaDraft>(`/conversations/${conversationId}/assistant-drafts/${draftId}/reject`, {
      method: "POST",
      body: { revision } satisfies ReviewSamantaDraftRequest,
    }),
};
```

Y a `qk` en `src/lib/api/query-keys.ts`:

```ts
  assistantDrafts: (conversationId: string) => ["conversations", "assistant-drafts", conversationId] as const,
  assistantDraft: (conversationId: string, draftId: string) =>
    ["conversations", "assistant-drafts", conversationId, draftId] as const,
```

- Las dos claves cuelgan de `["conversations"]`, así que `qk.conversationsAll` también las invalida.
- `qk.assistantDrafts(id)` es prefijo de `qk.assistantDraft(id, draftId)`: invalidar la lista invalida también cada borrador.
- A diferencia de `send`, `generate` no tiene clave por defecto: así nadie genera una clave nueva sin querer al reintentar.

## Listar conversaciones (bandeja)
`GET /conversations`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `Paginated<Conversation>` |
| ft-crm | `conversationsApi.list(query: ListConversationsQuery): Promise<Paginated<Conversation>>` (existe) |
| Caché | `qk.conversations(query)`. El contador de la Bandeja usa `qk.conversations({ unreadOnly: true, limit: 100 })`. |

**Query**

| Campo | Tipo | Obligatorio | Por defecto | Reglas |
|---|---|---|---|---|
| `page` | number | No | `1` | Entero de 1 a 1 000 000. |
| `limit` | number | No | `50` | Entero de 1 a 100. |
| `channel` | `ContactChannel` | No | — | Un solo valor, en mayúsculas: `WHATSAPP`, `FACEBOOK` (Messenger), `INSTAGRAM`, `WEBSITE`, `PHONE`, `EMAIL` u `OTHER`. |
| `customerId` | `Uuid` | No | — | UUID del cliente. Si no existe, la lista sale vacía (no hay 404). |
| `assignedUserId` | `Uuid` | No | — | UUID del responsable. No hay forma de pedir las conversaciones sin asignar. |
| `unreadOnly` | boolean | No | — | Solo los textos `true` o `false`. `true`: conversaciones con al menos un `INBOUND` sin `readAt`. `false` no filtra: no significa «solo leídas». |
| `isAssistantPaused` | boolean | No | — | Solo los textos `true` o `false`. Filtra por ese valor. |
| `search` | string | No | — | Se le aplica `trim`; después no puede quedar vacío y admite hasta 200 caracteres. Ver la nota sobre la búsqueda. |

Ningún parámetro admite el valor vacío (`channel=`) ni repetirse (`channel=WHATSAPP&channel=FACEBOOK`): los dos casos responden 400. Cualquier otro parámetro (p. ej. `_t`, `status` o `sort`) responde 400 `property <campo> should not exist`.

**Ejemplo de petición**

```ts
// Bandeja completa, 20 por página
const page = await conversationsApi.list({ limit: 20 });
// GET /api/backend/conversations?limit=20

// Messenger con mensajes sin leer, buscando por nombre
await conversationsApi.list({ channel: "FACEBOOK", unreadOnly: true, search: "Mamani", limit: 20 });
// GET /api/backend/conversations?channel=FACEBOOK&unreadOnly=true&search=Mamani&limit=20

// Cuántas conversaciones tienen algo sin leer
const { pagination } = await conversationsApi.list({ unreadOnly: true, limit: 1 });
// GET /api/backend/conversations?unreadOnly=true&limit=1 → pagination.total
```

**Respuesta** (ejemplo con `?limit=20`)

```json
{
  "data": [
    {
      "id": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
      "customerId": "c3e8a9b2-5d4f-4a6e-8c1b-7f2d9e0a3b56",
      "channel": "WHATSAPP",
      "isAssistantPaused": false,
      "assignedUserId": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
      "lastMessageAt": "2026-11-03T02:32:11.984Z",
      "createdAt": "2026-10-28T19:14:05.320Z",
      "updatedAt": "2026-11-03T02:32:11.986Z",
      "customer": {
        "id": "c3e8a9b2-5d4f-4a6e-8c1b-7f2d9e0a3b56",
        "firstName": "Lucía",
        "lastName": "Quispe",
        "phone": "+51987654321",
        "email": null
      },
      "assignedUser": {
        "id": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
        "firstName": "Carlos",
        "lastName": "Huamán",
        "isActive": true,
        "isEligible": true
      },
      "unreadCount": 1
    },
    {
      "id": "8b0d2f4a-6c8e-4a1b-9d3f-5a7c9e1b3d5f",
      "customerId": "3a5c7e9b-1d3f-4b6a-8c0e-2d4f6a8c0e2b",
      "channel": "FACEBOOK",
      "isAssistantPaused": false,
      "assignedUserId": null,
      "lastMessageAt": "2026-11-03T01:58:44.207Z",
      "createdAt": "2026-11-03T01:57:02.118Z",
      "updatedAt": "2026-11-03T01:58:44.209Z",
      "customer": {
        "id": "3a5c7e9b-1d3f-4b6a-8c0e-2d4f6a8c0e2b",
        "firstName": "Rosa Mamani",
        "lastName": null,
        "phone": null,
        "email": null
      },
      "assignedUser": null,
      "unreadCount": 3
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OWNER ni OPERATOR (p. ej. solo SUPPORT). |
| 400 | `property <campo> should not exist` | Parámetro no declarado. Va primero en el array. |
| 400 | `page must not be greater than 1000000` · `page must not be less than 1` · `page must be an integer number` | `page` fuera de rango, decimal o no numérico. `page=abc` devuelve los tres; `page=` (vacío), solo el segundo. |
| 400 | `limit must not be greater than 100` · `limit must not be less than 1` · `limit must be an integer number` | Lo mismo con `limit`. |
| 400 | `channel must be one of the following values: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER` | Vacío, en minúsculas, desconocido o repetido. |
| 400 | `customerId must be a UUID` | Vacío o no es un UUID. |
| 400 | `assignedUserId must be a UUID` | Vacío o no es un UUID. |
| 400 | `unreadOnly must be a boolean value` | Distinto de `true` y `false` (`1`, `yes`, `TRUE` o vacío). |
| 400 | `isAssistantPaused must be a boolean value` | Lo mismo con `isAssistantPaused`. |
| 400 | `search should not be empty` | Vacío o solo espacios. |
| 400 | `search must be shorter than or equal to 200 characters` · `search must be a string` | Más de 200 caracteres tras `trim`. Si el parámetro se repite, llegan los dos. |

**Efectos**

Ninguno (solo lectura).

**Notas para el frontend**

- **Orden:** `lastMessageAt` descendente (los `null` al final) y, a igualdad, `id` descendente. La conversación sube cuando llega un mensaje del cliente y cuando alguien encola una respuesta, manual o aprobada desde Samanta. Los cambios de estado de un mensaje no la mueven.
- **`unreadCount`:** cuenta los `INBOUND` con `readAt = null`. Es del equipo, no de cada usuario, y los `OUTBOUND` nunca cuentan.
- **Contador de la Bandeja:** no hay un total global de mensajes sin leer. `?unreadOnly=true&limit=1` da en `pagination.total` las conversaciones con algo sin leer. ft-crm suma `unreadCount` de hasta 100 conversaciones (`useUnreadSummary`) y marca el resultado como parcial si hay más.
- **Búsqueda (`search`):**
  - Busca coincidencias parciales en `firstName`, `lastName` y `email` del cliente, sin distinguir mayúsculas, y en `phone` tal como se guardó.
  - Si el texto tiene algún dígito, busca además esos dígitos, juntos y sin el resto de caracteres, en el teléfono normalizado. Un dígito suelto amplía mucho el resultado: «Mesa 4» encuentra a todos los clientes con un 4 en el teléfono.
  - No busca en el texto de los mensajes ni por el identificador de Messenger o Instagram.
- **Nombres del cliente:**
  - WhatsApp: el cliente nuevo llega sin nombre y con `phone` (`+51987654321`). Si ese teléfono ya era de un cliente, la conversación usa ese cliente con sus datos. El nombre aparece cuando alguien lo edita en Clientes.
  - Messenger: el cliente llega sin `phone` ni `email`. Cuando llega un mensaje nuevo de un cliente sin `firstName` ni `lastName`, bk-crm pide a Meta su nombre visible y lo guarda completo en `firstName` (`"Rosa Mamani"`), con `lastName` en `null`. Puede aparecer un instante después del mensaje. Si Meta no lo da, queda en `null` y se vuelve a pedir con el siguiente mensaje del cliente. Nunca reemplaza un nombre puesto en el CRM.
  - Instagram: igual que Messenger, sin `phone` ni `email`. Si el servidor tiene `INSTAGRAM_ACCESS_TOKEN`, bk-crm pide a Meta el nombre del perfil y lo guarda en `firstName`; si el perfil no tiene nombre, guarda el usuario con arroba (`"@ana.q"`).
  - Web (desde el 9/11): el cliente nuevo de una reserva de la web llega con el nombre del formulario y su WhatsApp o su correo ([03 › Solicitudes que llegan de la web](03-clientes-reservas.md#solicitudes-que-llegan-de-la-web)).
  - Prepara un texto de respaldo para cuando falte el nombre: el teléfono, «Cliente de Messenger» o «Cliente de Instagram». ft-crm ya lo hace: `customerName()` usa el teléfono y, sin él, el respaldo del canal.
- **Responsable inelegible:** `assignedUser.isEligible = false` significa que el responsable se desactivó o ya no tiene ADMIN ni OPERATOR. Resáltalo para que un ADMIN reasigne.
- **Páginas:** pedir una página posterior a la última devuelve `data: []` con la `page` pedida.
- **Vista previa:** la lista no trae el último mensaje. ft-crm lo pide con `GET /conversations/:id/messages?limit=1` por fila, con la clave `qk.lastMessage(id, lastMessageAt)`. Como los recibos de entrega no cambian `lastMessageAt`, el estado que muestra la vista previa no se refresca solo.
- `toSearch` ya omite los filtros vacíos y envía los booleanos como texto.

## Ver detalle de una conversación
`GET /conversations/:id`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `Conversation` |
| ft-crm | `conversationsApi.get(id: string): Promise<Conversation>` (existe) |
| Caché | `qk.conversation(id)` |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. Acepta cualquier versión de UUID. |

No tiene query: si envías parámetros, se ignoran.

**Respuesta**

```json
{
  "id": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
  "customerId": "c3e8a9b2-5d4f-4a6e-8c1b-7f2d9e0a3b56",
  "channel": "WHATSAPP",
  "isAssistantPaused": false,
  "assignedUserId": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "lastMessageAt": "2026-11-03T02:32:11.984Z",
  "createdAt": "2026-10-28T19:14:05.320Z",
  "updatedAt": "2026-11-03T02:32:11.986Z",
  "customer": {
    "id": "c3e8a9b2-5d4f-4a6e-8c1b-7f2d9e0a3b56",
    "firstName": "Lucía",
    "lastName": "Quispe",
    "phone": "+51987654321",
    "email": null
  },
  "assignedUser": {
    "id": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
    "firstName": "Carlos",
    "lastName": "Huamán",
    "isActive": true,
    "isEligible": true
  },
  "unreadCount": 1
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OWNER ni OPERATOR. |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 404 | `Conversación no encontrada` | La conversación no existe. |

**Efectos**

Ninguno (solo lectura). Consultar no marca nada como leído.

**Notas para el frontend**

- Devuelve el mismo objeto que cada fila de la lista, sin mensajes. Úsalo para la cabecera del chat: nombre del cliente, canal, pausa, responsable y `unreadCount`.
- ft-crm lo consulta por id (`useConversation`) para que la conversación abierta siga visible aunque un filtro de la lista la oculte, y no reintenta ante 400 o 404.
- Después de pausar o asignar no hace falta pedirlo de nuevo: esas rutas ya devuelven la conversación actualizada.

## Ver historial de mensajes
`GET /conversations/:id/messages`

| | |
|---|---|
| Roles | ADMIN, OWNER, OPERATOR |
| Respuesta | 200 · `Paginated<Message>` |
| ft-crm | `conversationsApi.messages(id: string, query?: ListMessagesQuery): Promise<Paginated<Message>>` (existe) |
| Caché | `qk.messages(id)` para la página 1 del chat y `qk.lastMessage(id, lastMessageAt)` para la vista previa de la lista. Las páginas anteriores viven en el estado del componente (`useConversationMessages`). |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |

**Query**

| Campo | Tipo | Obligatorio | Por defecto | Reglas |
|---|---|---|---|---|
| `page` | number | No | `1` | Entero de 1 a 1 000 000. La página 1 trae lo más reciente. |
| `limit` | number | No | `50` | Entero de 1 a 100. |

No admite otros parámetros, ni siquiera los filtros de la lista (`channel`, `search`…): responden 400 `property <campo> should not exist`.

**Ejemplo de petición**

```ts
// Página reciente del chat
const recent = await conversationsApi.messages("6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14", { page: 1, limit: 50 });
// GET /api/backend/conversations/6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14/messages?page=1&limit=50

// Vista previa de la lista: solo el último mensaje
const last = (await conversationsApi.messages("6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14", { limit: 1 })).data[0] ?? null;
// GET /api/backend/conversations/6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14/messages?limit=1
```

**Respuesta** (ejemplo con `?page=1&limit=3`)

```json
{
  "data": [
    {
      "id": "1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f",
      "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
      "channel": "WHATSAPP",
      "sequence": 7,
      "externalMessageId": "wamid.HBgLNTE5ODc2NTQzMjEVAgASGBQzQUI3RjY0QjE4QzJEMUE5NzUwNAA=",
      "direction": "INBOUND",
      "status": "PROCESSED",
      "type": "TEXT",
      "content": "¿Tienen mesa para 4 personas este sábado a las 8 pm?",
      "templateName": null,
      "authorUserId": null,
      "occurredAt": "2026-11-03T02:32:09.000Z",
      "receivedAt": "2026-11-03T02:32:11.984Z",
      "processedAt": "2026-11-03T02:32:13.402Z",
      "sentAt": null,
      "deliveredAt": null,
      "providerReadAt": null,
      "failedAt": null,
      "readAt": null,
      "errorCode": null,
      "createdAt": "2026-11-03T02:32:11.986Z",
      "updatedAt": "2026-11-03T02:32:13.404Z",
      "attachments": []
    },
    {
      "id": "4c6e8a0b-2d4f-4e7a-b1c3-5d7f9a1b3c5e",
      "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
      "channel": "WHATSAPP",
      "sequence": 6,
      "externalMessageId": "wamid.HBgLNTE5ODc2NTQzMjEVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA",
      "direction": "OUTBOUND",
      "status": "DELIVERED",
      "type": "TEXT",
      "content": "¡Gracias por la foto, Lucía! La compartimos con el equipo de sala.",
      "templateName": null,
      "authorUserId": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
      "occurredAt": null,
      "receivedAt": null,
      "processedAt": null,
      "sentAt": "2026-11-03T02:29:12.000Z",
      "deliveredAt": "2026-11-03T02:29:13.000Z",
      "providerReadAt": null,
      "failedAt": null,
      "readAt": null,
      "errorCode": null,
      "createdAt": "2026-11-03T02:29:10.551Z",
      "updatedAt": "2026-11-03T02:29:15.302Z",
      "attachments": []
    },
    {
      "id": "7e9a1c3b-5d7f-4b2e-8a4c-6e8f0b2d4a6c",
      "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
      "channel": "WHATSAPP",
      "sequence": 5,
      "externalMessageId": "wamid.HBgLNTE5ODc2NTQzMjEVAgASGBQzRUI5MDJBQ0Y4NjE0QjJDNzAxMwA=",
      "direction": "INBOUND",
      "status": "PROCESSED",
      "type": "IMAGE",
      "content": "Así quedó la mesa la última vez",
      "templateName": null,
      "authorUserId": null,
      "occurredAt": "2026-11-03T02:25:40.000Z",
      "receivedAt": "2026-11-03T02:25:41.218Z",
      "processedAt": "2026-11-03T02:25:42.904Z",
      "sentAt": null,
      "deliveredAt": null,
      "providerReadAt": null,
      "failedAt": null,
      "readAt": "2026-11-03T02:28:03.117Z",
      "errorCode": null,
      "createdAt": "2026-11-03T02:25:41.220Z",
      "updatedAt": "2026-11-03T02:28:03.119Z",
      "attachments": [
        {
          "id": "0d2f4b6a-8c1e-4a3d-9f5b-7a9c1e3f5b7d",
          "type": "IMAGE",
          "fileName": null,
          "mimeType": "image/jpeg",
          "sizeBytes": null,
          "externalMediaId": "1043958217712345",
          "url": null,
          "createdAt": "2026-11-03T02:25:41.220Z"
        }
      ]
    }
  ],
  "pagination": { "page": 1, "limit": 3, "total": 7, "totalPages": 3 }
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OWNER ni OPERATOR. |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `property <campo> should not exist` | Parámetro no declarado (también `channel` o `search`). |
| 400 | `page must not be greater than 1000000` · `page must not be less than 1` · `page must be an integer number` | `page` fuera de rango, vacío, decimal o no numérico. |
| 400 | `limit must not be greater than 100` · `limit must not be less than 1` · `limit must be an integer number` | Lo mismo con `limit`. |
| 404 | `Conversación no encontrada` | La conversación no existe. |

**Efectos**

Ninguno (solo lectura). Ver el historial no marca nada como leído: para eso está [Marcar como leído](#marcar-como-leído-hasta-un-mensaje).

**Notas para el frontend**

- **Orden y paginación:**
  - `sequence` descendente: la página 1 trae lo más reciente. Para pintar el chat, ordena por `sequence` ascendente.
  - `sequence` es correlativo por conversación (1, 2, 3…) y es el orden real del chat. No ordenes por fechas: la hora de Meta y la del servidor no coinciden.
  - Los mensajes nuevos desplazan las páginas. Para «cargar anteriores», pide la página siguiente y deduplica por `id`; ft-crm ya lo hace (`mergeMessages` y `loadOlder`).
  - `pagination.total` cuenta los mensajes de las dos direcciones.
- **Hora de la burbuja:** `occurredAt` en los `INBOUND` (si es `null`, `receivedAt`) y `sentAt` en los `OUTBOUND` (si es `null`, `createdAt`). Es lo que hace `messageTimestamp`.
- **Fechas según la dirección:**

  | Campo | INBOUND | OUTBOUND |
  |---|---|---|
  | `occurredAt` | Hora que informa Meta. Solo es `null` en los datos de demostración. | Siempre `null`. |
  | `receivedAt` | Llegada a bk-crm. | Siempre `null`. |
  | `processedAt` | Fin del procesamiento interno (`PROCESSED`). | Siempre `null`. |
  | `createdAt` | Momento en que se guardó (casi igual a `receivedAt`). | Momento en que se encoló. |
  | `sentAt` | Siempre `null`. | Meta aceptó el envío. Un recibo de Meta con una hora anterior lo adelanta. |
  | `deliveredAt` | Siempre `null`. | Recibo de entrega (WhatsApp o Messenger). En Instagram siempre es `null`: bk-crm no procesa sus recibos. |
  | `providerReadAt` | Siempre `null`. | El cliente lo leyó (solo WhatsApp). |
  | `failedAt` | Fallo del procesamiento. | Fallo del envío o de la entrega. |
  | `readAt` | Lectura del equipo en el CRM. | Siempre `null`. |

- **Autor:** `authorUserId` es `null` en los `INBOUND`. En los `OUTBOUND` nunca es `null`:
  - Si lo envió Samanta sola ([modo automático](#samanta-automática)) o es el aviso al cliente de una reserva de la web (desde el 9/11), es el usuario de sistema `SAMANTA_USER_ID` = `00000000-0000-4000-8000-00000000a0a1`.
  - Si no, es quien envió el mensaje o quien aprobó el borrador.
  - Un mensaje es de Samanta si su autor es `SAMANTA_USER_ID` o si su id es el `outboundMessageId` de un borrador `APPROVED` ([Listar borradores](#listar-borradores-de-samanta)).
  - La regla actual de ft-crm, «`OUTBOUND` sin autor = Samanta» (`messageAuthor`), nunca se cumple con datos reales.
- **Nombre del autor:** solo llega el id, y `GET /users` es solo para ADMIN. Muestra «Tú» si coincide con `GET /auth/me`, el nombre del responsable si coincide con `assignedUser.id`, o «Equipo».
- **Tipos de mensaje:**
  - `TEXT`: el texto va en `content`. Los entrantes pueden tener hasta 16 000 caracteres. Desde el 9/11, el toque del cliente en un botón de WhatsApp (de una plantilla o de un mensaje interactivo) también llega como `TEXT`, con el texto del botón en `content` (p. ej. «Sí, continuar»).
  - `IMAGE` y `FILE`: solo llegan por WhatsApp (foto o documento). La metadata va en `attachments` y el pie de foto en `content` (`null` si no hay).
  - `OTHER`: contenido que el canal aún no soporta, sin `attachments`. `content` trae `[Mensaje de WhatsApp no compatible todavía]` (audio, video, sticker…), `[Adjunto de Messenger no compatible todavía]` o `[Adjunto de Instagram no compatible todavía]` (adjunto sin texto).
  - Los salientes siempre son `TEXT`. Los que salieron como plantilla de WhatsApp traen su nombre en `templateName` ([Message](#message)).
- **Adjuntos:** solo hay metadata (`externalMediaId`, `mimeType`, `fileName`). Desde WhatsApp, `url` y `sizeBytes` llegan `null`, y no hay endpoint para descargar el archivo. Muestra «[Imagen]» o «[Archivo: nombre]», como ya hace `messageText`.
- **Qué mostrar según el estado** (el detalle, en [Estados y transiciones](#estados-y-transiciones)):

  | `status` | Dirección | Qué mostrar |
  |---|---|---|
  | `RECEIVED`, `PROCESSING`, `PROCESSED` | INBOUND | Nada especial: el texto se muestra desde que llega. |
  | `FAILED` | INBOUND | El mensaje igual, con un indicador discreto. |
  | `QUEUED` | OUTBOUND | «En cola». Con `errorCode` `WHATSAPP_RATE_LIMITED`, `MESSENGER_RATE_LIMITED` o `INSTAGRAM_RATE_LIMITED`, «Reintentando…»: Meta pidió esperar y el backend reintenta solo. |
  | `SENDING` | OUTBOUND | «Enviando…». En un reintento sigue trayendo `*_RATE_LIMITED` (el worker no borra el código al tomarlo): muestra también «Reintentando…», como ya hace `outboundStatusView`. |
  | `SENT` | OUTBOUND | «Enviado» (✓). Es el último estado posible en Instagram: bk-crm no procesa sus recibos. |
  | `DELIVERED` | OUTBOUND | «Entregado» (✓✓). Es el último estado posible en Messenger. En Instagram nunca llega. |
  | `READ` | OUTBOUND | «Leído» (✓✓ resaltado). Solo en WhatsApp, y no llega si el cliente ocultó las confirmaciones. |
  | `UNKNOWN` | OUTBOUND | «Estado incierto: verifica antes de reenviar». Meta pudo recibirlo y el backend nunca lo reenvía. |
  | `FAILED` | OUTBOUND | «No enviado» o «No entregado», según `errorCode`. |

- Los textos de fallo de ft-crm (`outboundErrorKind` y `OUTBOUND_ERROR_TEXT` en `channel-utils.ts`, que usa `outboundStatusView`) ya reconocen los tres prefijos, `WHATSAPP_*`, `MESSENGER_*` e `INSTAGRAM_*`, y el código nuevo `WHATSAPP_TEMPLATE_EXPIRED` (cambio del 8/11, sin commit).
- **Diagnóstico:** ante un `FAILED` o `UNKNOWN` que no se entiende, pasa el `id` del mensaje al equipo de backend. Cada vez que Meta responde al envío con un error HTTP (4xx, 429 o 5xx), el log `WHATSAPP_SEND_HTTP_ERROR`, `MESSENGER_SEND_HTTP_ERROR` o `INSTAGRAM_SEND_HTTP_ERROR` lo registra con ese id, el estado HTTP y los códigos numéricos de Meta. Un timeout o un error de red no deja esa línea.
- `externalMessageId` es el id de Meta (wamid en WhatsApp; mid en Messenger e Instagram). En un `OUTBOUND` aparece al llegar a `SENT`.

## Enviar un mensaje de texto
`POST /conversations/:id/messages`

| | |
|---|---|
| Roles | ADMIN, OPERATOR. La asignación no limita: cualquiera de los dos puede responder aunque la conversación sea de otra persona. |
| Respuesta | 202 · `Message`: el mensaje en cola o, si repites la clave, el mismo mensaje en su estado actual |
| ft-crm | `conversationsApi.send(id: string, content: string, idempotencyKey?: string): Promise<Message>` (existe). Pasa siempre la clave: el valor por defecto crea una nueva en cada llamada. |
| Caché | Agrega el mensaje a `qk.messages(id)` con `setQueryData` (`storeSentMessage`). Invalida `["conversations", "list"]` y `qk.conversation(id)` (cambian `lastMessageAt` y el orden) y `qk.assistantDrafts(id)` (los borradores pendientes quedan desactualizados). |
| Cabeceras y límites | `Idempotency-Key` obligatoria. Timeout del BFF: `CRM_BACKEND_TIMEOUT_MS` (15 s por defecto). |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |

**Cabeceras**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `Idempotency-Key` | string | Sí | 16 a 80 caracteres `[A-Za-z0-9_-]` (`^[a-zA-Z0-9_-]{16,80}$`). Única por conversación, para todos los usuarios. No la empieces con `samanta-`. Un `crypto.randomUUID()` sirve (`newIdempotencyKey()`). |
| `Content-Type` | string | Sí | `application/json`. `apiFetch` la pone sola. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `type` | `"TEXT"` | Sí | Exactamente `TEXT`, en mayúsculas. |
| `content` | string | Sí | Al menos un carácter que no sea espacio en blanco (`/\S/`). No admite `null`. Tope del DTO: 4096 caracteres contando cada emoji como 1. Tope real por canal, con `content.length` (unidades UTF-16; un emoji suele contar 2): 4096 en `WHATSAPP`, 2000 en `FACEBOOK` y 1000 en `INSTAGRAM`. Instagram exige además como máximo 1000 bytes en UTF-8 (`new TextEncoder().encode(content).length`): una tilde o una «ñ» ocupan 2 bytes, y un emoji, 4. No se recorta: se envía tal cual. |
| Cualquier otro | — | — | 400 `property <campo> should not exist` (`to`, `status`, `authorUserId`, `externalMessageId`, `sentAt`…). El backend calcula el autor, el destinatario y el estado. |

**Ejemplo de petición**

```ts
// Genera la clave al pulsar «Enviar» y guárdala con el texto para reintentar ese mismo envío.
const key = newIdempotencyKey();
const message = await conversationsApi.send(
  "8b0d2f4a-6c8e-4a1b-9d3f-5a7c9e1b3d5f",
  "¡Hola, Rosa! Sí atendemos el feriado, de 12:00 a 22:00. ¿Te ayudamos con una reserva?",
  key,
);
```

```http
POST /api/backend/conversations/8b0d2f4a-6c8e-4a1b-9d3f-5a7c9e1b3d5f/messages
Content-Type: application/json
Idempotency-Key: 3b9d6c1e-2f4a-4c8e-9b1d-5a7c9e2f4b6d

{"type":"TEXT","content":"¡Hola, Rosa! Sí atendemos el feriado, de 12:00 a 22:00. ¿Te ayudamos con una reserva?"}
```

**Respuesta** (202, conversación de Messenger)

```json
{
  "id": "5f7a9c1e-3b5d-4f8a-a2c4-6e8a0c2e4f6b",
  "conversationId": "8b0d2f4a-6c8e-4a1b-9d3f-5a7c9e1b3d5f",
  "channel": "FACEBOOK",
  "sequence": 4,
  "externalMessageId": null,
  "direction": "OUTBOUND",
  "status": "QUEUED",
  "type": "TEXT",
  "content": "¡Hola, Rosa! Sí atendemos el feriado, de 12:00 a 22:00. ¿Te ayudamos con una reserva?",
  "templateName": null,
  "authorUserId": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "occurredAt": null,
  "receivedAt": null,
  "processedAt": null,
  "sentAt": null,
  "deliveredAt": null,
  "providerReadAt": null,
  "failedAt": null,
  "readAt": null,
  "errorCode": null,
  "createdAt": "2026-11-03T02:35:10.291Z",
  "updatedAt": "2026-11-03T02:35:10.291Z",
  "attachments": []
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. OWNER o SUPPORT). |
| 400 | `property <campo> should not exist` | Campos que no son `type` ni `content`. Va primero en el array. |
| 400 | `type must be equal to TEXT` | `type` falta o no es exactamente `TEXT`. |
| 400 | `content must be shorter than or equal to 4096 characters` · `content must match /\S/ regular expression` · `content must be a string` | `content` falta, es `null` o no es texto (llegan los tres); vacío o solo espacios (el segundo); más de 4096 caracteres contando cada emoji como 1 (el primero). |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 400 | `Idempotency-Key debe contener 16 a 80 caracteres alfanuméricos, guion o guion bajo` | La cabecera falta o tiene otro formato. |
| 409 | `Idempotency-Key ya utilizada con otros datos` | La clave ya se usó en esta conversación con otro `type` o `content`, o la usó otro usuario. Se comprueba antes que el canal y la ventana. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 400 | `Conversación sin destinatario habilitado` | El canal no tiene envío: `WEBSITE`, `PHONE`, `EMAIL` u `OTHER`. `INSTAGRAM` sí tiene envío desde el 4/11 (commit `eca059b`). |
| 503 | `WhatsApp no está habilitado` · `Messenger no está habilitado` · `Instagram no está habilitado` · `El envío por Instagram no está configurado` | El canal de la conversación está apagado en el servidor (`WHATSAPP_ENABLED`, `MESSENGER_ENABLED` o `INSTAGRAM_ENABLED`). El último llega con Instagram encendido sin `INSTAGRAM_ACCESS_TOKEN`: recibe mensajes, pero no responde. Se comprueba antes que la longitud: con Instagram apagado, un texto de 1500 caracteres da 503. |
| 400 | `WhatsApp admite hasta 4096 caracteres por respuesta` · `Messenger admite hasta 2000 caracteres por respuesta` · `Instagram admite hasta 1000 caracteres por respuesta` | `content.length` supera el tope del canal (p. ej. 2001 caracteres en Messenger, 1001 en Instagram o 3000 emojis en WhatsApp). |
| 400 | `Instagram admite hasta 1000 bytes por respuesta; las tildes y los emojis ocupan más de uno` | Instagram: `content.length` ≤ 1000, pero el texto ocupa más de 1000 bytes en UTF-8 (p. ej. 600 «á» = 1200 bytes, o 251 emojis). Se comprueba después del tope de caracteres. |
| 400 | `Conversación sin destinatario habilitado` | WhatsApp: el cliente no tiene un teléfono internacional válido (se le quitó o se cambió por uno nacional sin país). Messenger: el cliente no es una identidad de la página configurada. Instagram: el cliente no es una identidad (IGSID) de la cuenta configurada en `INSTAGRAM_ACCOUNT_ID`, p. ej. porque se cambió esa cuenta: los clientes de la anterior se quedan sin destinatario. |
| 409 | `Ventana de WhatsApp cerrada; se requiere una plantilla aprobada` · `Ventana de Messenger cerrada; el cliente debe enviar un nuevo mensaje` · `Ventana de Instagram cerrada; el cliente debe enviar un nuevo mensaje` | No hay un `INBOUND` de ese cliente en las últimas 24 h. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta con la misma clave. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb. |
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre. |

**Efectos**

- Crea un mensaje `OUTBOUND` `TEXT` en `QUEUED`, con su entrada en la cola de envío. El autor es quien llama. El destinatario se fija en ese momento: el teléfono normalizado (WhatsApp), el PSID (Messenger) o el IGSID (Instagram) del cliente.
- La conversación suma 1 a su secuencia y actualiza `lastMessageAt` y `updatedAt`: sube en la bandeja.
- Los borradores `READY` de la conversación quedan desactualizados: pasan a `STALE` en la siguiente consulta o acción sobre ellos. Uno en `GENERATING` queda `STALE` al terminar, y una respuesta automática pendiente se descarta.
- Con el [modo automático](#samanta-automática) activo, pausa a Samanta en esa conversación si no estaba en pausa: `isAssistantPaused: true` y `assistantPauseReason: "OPERATOR_REPLIED"`. Así no responden los dos a la vez. Sin modo automático no toca la pausa.
- No cambia el responsable, `unreadCount` ni el `lastContactAt` del cliente.
- Un worker hace el envío a Meta fuera de la petición. Repetir la misma clave no tiene efectos.

**Notas para el frontend**

- **202 = en cola.** El 202 confirma que el mensaje se guardó, no que llegó. Agrega el `Message` devuelto al chat (`storeSentMessage`) y sigue su `status` con el polling del historial.
- **Idempotencia:**
  - Genera la clave cuando el usuario pulsa «Enviar» y guárdala con el texto; reutilízala solo para reintentar ese mismo envío (timeout, error de red, doble clic). El Composer de ft-crm ya lo hace (`pendingKey`).
  - Misma clave, mismo autor, mismo `type` y mismo `content`: 202 con el mensaje original en su estado actual (puede venir ya `SENT` o `FAILED`), sin reenviar. No asumas `QUEUED`.
  - Un reintento tardío devuelve el original aunque la ventana ya se haya cerrado, porque la repetición se resuelve antes.
  - bk-crm usa `samanta-<draftId>` como clave al aprobar borradores: no uses ese prefijo.
- **Longitud por canal:** cuenta con `content.length`, igual que el backend: 4096 en WhatsApp, 2000 en Messenger y 1000 en Instagram. En Instagram cuenta además los bytes UTF-8 (`new TextEncoder().encode(texto).length` ≤ 1000). ft-crm ya lo hace: el Composer toma el tope de `OUTBOUND_TEXT_MAX_LENGTH` (`replyMaxLength`) y, en Instagram, cuenta en bytes (`replyMaxBytes` y `utf8Length`, con `OUTBOUND_TEXT_MAX_BYTES`) y no deja enviar más de 1000.
- **Ventana de 24 h:**
  - Se puede responder si hay un `INBOUND` de esta conversación, del mismo teléfono (WhatsApp), PSID (Messenger) o IGSID (Instagram), y del mismo número, página o cuenta de Instagram del negocio, con `occurredAt` en las últimas 24 h. Cuenta cualquier `INBOUND` guardado, también los `OTHER` (adjuntos).
  - Fuera de la ventana, en WhatsApp solo se puede escribir con una plantilla aprobada, que la Bandeja no puede enviar: el backend solo las usa para avisar al cliente de una reserva de la web ([Mensajes salientes](#mensajes-salientes-direction-outbound)). En Messenger e Instagram hay que esperar a que el cliente escriba.
  - El worker la vuelve a comprobar antes de enviar: un mensaje encolado justo antes del cierre puede terminar `FAILED` con `*_WINDOW_CLOSED`.
  - Si se cambia el teléfono del cliente en Clientes, la ventana se evalúa con el número nuevo; lo que ya estaba en cola sale al número anterior.
  - Deshabilita el editor 24 h después del `occurredAt` del último `INBOUND` cargado. ft-crm ya lo estima (`estimateReplyWindow`) en los canales de `SENDABLE_CHANNELS`, que desde el 8/11 incluye `INSTAGRAM`. El 409 del backend es la respuesta definitiva.
- **Canales:** `WHATSAPP`, `FACEBOOK` e `INSTAGRAM` tienen envío; `WEBSITE`, `PHONE`, `EMAIL` y `OTHER` no (400 `Conversación sin destinatario habilitado`).
  - En Messenger e Instagram no hay teléfono: el backend resuelve el destinatario (PSID o IGSID), que no se expone. El Composer solo debe exigir `customer.phone` en WhatsApp.
  - ft-crm ya lo hace: `SENDABLE_CHANNELS` (`src/lib/api/types.ts`) incluye `INSTAGRAM` y `composerState` ya no bloquea Instagram (cambio del 8/11, sin commit).
  - Con acceso estándar a la API de Meta, Instagram solo entrega a cuentas que tienen un rol en la app de Meta. A cualquier otra cuenta, el POST responde 202, pero el mensaje termina `FAILED` con `INSTAGRAM_SEND_REJECTED`.
- **Asignación:** el backend deja responder a cualquier ADMIN u OPERATOR aunque la conversación sea de otra persona. ft-crm bloquea al OPERATOR en ese caso (`composerState`): es una regla de la interfaz, no del backend.
- **Textos de error:** elige los textos según `conversation.channel`. ft-crm ya lo hace: `sendErrorText`, `sendChannelName` y `windowClosedText` tienen caso de Instagram desde el 8/11. En Instagram, el backend responde:
  - 503 `Instagram no está habilitado` o `El envío por Instagram no está configurado`: es una función apagada en el servidor, no falta de conexión;
  - 400 `Instagram admite hasta 1000 caracteres por respuesta` o `Instagram admite hasta 1000 bytes por respuesta; las tildes y los emojis ocupan más de uno`;
  - 400 `Conversación sin destinatario habilitado`;
  - 409 `Ventana de Instagram cerrada; el cliente debe enviar un nuevo mensaje`.

  Más detalle en [Bandeja](05-implementacion-ft-crm.md#bandeja) del 05.
- **Espacios:** el backend no recorta `content`. El Composer envía `draft.trim()`: mantenlo.
- **Reenviar:** no hay endpoint de reintento. Reenviar es un POST nuevo con una clave nueva. Ante un `UNKNOWN`, no reenvíes sin confirmar antes que el cliente no lo recibió.

## Marcar como leído hasta un mensaje
`PATCH /conversations/:id/read`

| | |
|---|---|
| Roles | ADMIN, OPERATOR |
| Respuesta | 200 · `MarkConversationReadResponse` |
| ft-crm | `conversationsApi.markRead(id: string, throughMessageId: string): Promise<MarkConversationReadResponse>` (existe) |
| Caché | Pon `unreadCount: 0` en `qk.conversation(id)` y en las listas (`storeConversationRead`) e invalida `["conversations", "list"]` y `qk.conversation(id)` para traer el valor real. Invalida `qk.messages(id)` solo si muestras `readAt`. |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `throughMessageId` | `Uuid` | Sí | UUID de un mensaje de esta conversación, de cualquier dirección: el más reciente que el usuario vio. No admite `null`. |
| Cualquier otro | — | — | 400 `property <campo> should not exist`. |

**Ejemplo de petición**

```ts
await conversationsApi.markRead("6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14", "1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f");
```

```http
PATCH /api/backend/conversations/6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14/read
Content-Type: application/json

{"throughMessageId":"1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f"}
```

**Respuesta**

```json
{
  "updated": 1,
  "throughMessageId": "1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. OWNER o SUPPORT). |
| 400 | `property <campo> should not exist` | Campos extra. |
| 400 | `throughMessageId must be a UUID` | Falta (también con el body vacío), es `null` o no es un UUID. |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 404 | `Mensaje no encontrado en esta conversación` | `throughMessageId` no existe o es de otra conversación. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb. |
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre. |

**Efectos**

- Pone `readAt` (hora del servidor) en todos los `INBOUND` de la conversación con `readAt = null` y `sequence` menor o igual que la del mensaje indicado. `unreadCount` baja en la misma cantidad.
- No cambia la conversación (`updatedAt`, `lastMessageAt`) ni los `OUTBOUND`.
- No avisa a Meta: el cliente no ve un doble check azul.

**Notas para el frontend**

- Envía el `id` del mensaje más reciente que el usuario vio de verdad. En la página 1 del historial es `data[0].id`; en la lista ya ordenada de ft-crm, `messages.at(-1).id`.
- Los mensajes que llegan después del corte siguen sin leer: no hay carreras.
- Es idempotente: repetirlo responde `updated: 0`.
- La lectura es del equipo, no de cada usuario.
- OWNER no puede marcar (403). ft-crm ya lo evita con el permiso `conversation.read`, y solo marca con la pestaña visible, 500 ms después de mostrar el último mensaje (`useMarkAsRead`).
- `storeConversationRead` pone `unreadCount` en 0, pero si llegó otro mensaje después del corte el valor real es mayor: por eso hay que invalidar después.

## Pausar o reanudar a Samanta en la conversación
`PATCH /conversations/:id/assistant`

| | |
|---|---|
| Roles | ADMIN, OPERATOR. La asignación no limita: cualquiera de los dos puede cambiarla. |
| Respuesta | 200 · `Conversation` |
| ft-crm | `conversationsApi.setAssistantPaused(id: string, paused: boolean): Promise<Conversation>` (existe) |
| Caché | Guarda la respuesta en `qk.conversation(id)` y en las listas (`storeConversation`). Invalida `["conversations", "list"]` si hay listas filtradas por `isAssistantPaused`, y `qk.assistantDrafts(id)`. |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `paused` | boolean | Sí | Booleano JSON (`true` o `false`). `"false"` como texto, `1` o `null` responden 400. |
| Cualquier otro | — | — | 400 `property <campo> should not exist`. |

**Ejemplo de petición**

```ts
const conversation = await conversationsApi.setAssistantPaused("6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14", true);
```

```http
PATCH /api/backend/conversations/6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14/assistant
Content-Type: application/json

{"paused":true}
```

**Respuesta**

```json
{
  "id": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
  "customerId": "c3e8a9b2-5d4f-4a6e-8c1b-7f2d9e0a3b56",
  "channel": "WHATSAPP",
  "isAssistantPaused": true,
  "assignedUserId": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "lastMessageAt": "2026-11-03T02:34:02.407Z",
  "createdAt": "2026-10-28T19:14:05.320Z",
  "updatedAt": "2026-11-03T02:40:18.602Z",
  "customer": {
    "id": "c3e8a9b2-5d4f-4a6e-8c1b-7f2d9e0a3b56",
    "firstName": "Lucía",
    "lastName": "Quispe",
    "phone": "+51987654321",
    "email": null
  },
  "assignedUser": {
    "id": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
    "firstName": "Carlos",
    "lastName": "Huamán",
    "isActive": true,
    "isEligible": true
  },
  "unreadCount": 0
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. OWNER o SUPPORT). |
| 400 | `property <campo> should not exist` | Campos extra (p. ej. `assignedUserId`: la asignación va por otra ruta). |
| 400 | `paused must be a boolean value` | Falta `paused` o no es un booleano JSON. |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb. |
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre. |

**Efectos**

- Cambia `isAssistantPaused` y `updatedAt`.
- Pausar fija `assistantPauseReason: "MANUAL"` y `assistantPausedAt` en ese momento, aunque ya estuviera en pausa por otro motivo. Reanudar deja los dos en `null`. Enviar el valor que ya tiene también responde 200.
- Mientras siga en pausa:
  - Samanta no responde sola.
  - Generar un borrador responde 409.
  - Los borradores `READY` pasan a `STALE` en la siguiente consulta o acción sobre ellos; uno en `GENERATING` queda `STALE` al terminar.
- No detiene la recepción ni el envío de mensajes, no impide las respuestas manuales y no cambia el responsable.

**Notas para el frontend**

- Con el [modo automático](#samanta-automática), la pausa es lo que decide si Samanta responde sola en la conversación. Sin modo automático solo afecta a los borradores.
- El «modo» que muestra ft-crm (Samanta, En pausa, Operador) es un concepto de la interfaz que se deriva de la pausa y del responsable (`conversationMode`). `assistantPauseReason` dice además por qué se pausó.
- Reanudar no recupera los borradores que ya pasaron a `STALE`. Un borrador que nadie consultó durante la pausa sigue `READY` al reanudar, si no hubo otros cambios. Refresca el panel de Samanta y la cabecera.
- ft-crm encadena esta ruta con la asignación («Pasar a humano», «Devolver a Samanta»). Son llamadas independientes y cada una puede fallar por su cuenta: maneja el error de cada paso.

## Asignar, tomar o liberar una conversación
`PATCH /conversations/:id/assignee`

| | |
|---|---|
| Roles | ADMIN, OPERATOR (un OPERATOR solo toma conversaciones libres o se libera de las propias) |
| Respuesta | 200 · `Conversation` |
| ft-crm | `conversationsApi.assign(id: string, body: AssignConversationRequest): Promise<Conversation>` (existe) |
| Caché | Guarda la respuesta con `storeConversation` e invalida `["conversations", "list"]` (cambia el resultado del filtro `assignedUserId`). |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `assignedUserId` | `Uuid` o `null` | Sí | `null` desasigna. Si no es `null`, tiene que ser el UUID de un usuario activo con rol ADMIN u OPERATOR. Omitirlo responde 400: no desasigna. `""` y `false` también responden 400. |
| Cualquier otro | — | — | 400 `property <campo> should not exist`. |

Quién puede asignar a quién:

| Quien llama | Conversación libre | Asignada a quien llama | Asignada a otra persona |
|---|---|---|---|
| ADMIN | Asigna a cualquier usuario elegible, o `null` | Igual | Igual: reemplaza al responsable o desasigna |
| OPERATOR sin ADMIN | Solo su propio id (tomar) o `null` | Su propio id (sin cambios) o `null` (liberar) | 403, con cualquier valor |
| OWNER o SUPPORT | 403 | 403 | 403 |

**Ejemplo de petición**

```ts
// Un OPERATOR toma una conversación libre (su id sale de GET /auth/me)
await conversationsApi.assign("8b0d2f4a-6c8e-4a1b-9d3f-5a7c9e1b3d5f", {
  assignedUserId: "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
});

// Y la libera
await conversationsApi.assign("8b0d2f4a-6c8e-4a1b-9d3f-5a7c9e1b3d5f", { assignedUserId: null });
```

```http
PATCH /api/backend/conversations/8b0d2f4a-6c8e-4a1b-9d3f-5a7c9e1b3d5f/assignee
Content-Type: application/json

{"assignedUserId":"9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d"}
```

**Respuesta** (después de tomarla)

```json
{
  "id": "8b0d2f4a-6c8e-4a1b-9d3f-5a7c9e1b3d5f",
  "customerId": "3a5c7e9b-1d3f-4b6a-8c0e-2d4f6a8c0e2b",
  "channel": "FACEBOOK",
  "isAssistantPaused": false,
  "assignedUserId": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "lastMessageAt": "2026-11-03T02:35:10.288Z",
  "createdAt": "2026-11-03T01:57:02.118Z",
  "updatedAt": "2026-11-03T02:41:55.130Z",
  "customer": {
    "id": "3a5c7e9b-1d3f-4b6a-8c0e-2d4f6a8c0e2b",
    "firstName": "Rosa Mamani",
    "lastName": null,
    "phone": null,
    "email": null
  },
  "assignedUser": {
    "id": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
    "firstName": "Carlos",
    "lastName": "Huamán",
    "isActive": true,
    "isEligible": true
  },
  "unreadCount": 0
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. OWNER o SUPPORT). |
| 400 | `property <campo> should not exist` | Campos extra. |
| 400 | `assignedUserId must be a UUID` | El campo se omitió, viene vacío, es `false` o no es un UUID. |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 403 | `Solo puedes tomar conversaciones libres o desasignarte de las propias` | Un OPERATOR sin ADMIN intenta asignar a otra persona o tocar una conversación asignada a otra persona. |
| 404 | `Usuario no encontrado` | `assignedUserId` no existe. |
| 400 | `Responsable no elegible` | El usuario está inactivo o no tiene ADMIN ni OPERATOR (p. ej. es solo OWNER o SUPPORT). |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb. |
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre. |

**Efectos**

- Cambia `assignedUserId` y `updatedAt`. Asignar el valor que ya tiene también responde 200.
- Un OPERATOR deja de poder generar, editar, aprobar o rechazar borradores de Samanta en una conversación asignada a otra persona (403 `Conversación asignada a otro operador`).
- No cambia la pausa y no limita la lectura ni las respuestas manuales.

**Notas para el frontend**

- Obtén el `id` y los `roles` del usuario actual con `GET /auth/me`.
- Para el selector de responsable, un ADMIN puede usar `GET /users` (solo ADMIN) y mostrar los activos con ADMIN u OPERATOR. Al OPERATOR muéstrale solo «Tomar» y «Liberar».
- Si `assignedUser.isEligible` es `false` (el responsable se desactivó o perdió sus roles después), muestra un aviso para que un ADMIN reasigne.
- No hay asignación automática: ningún mensaje ni acción de Samanta cambia el responsable.
- ft-crm decide qué botones mostrar con `conversationControls`, que ya sigue estas reglas.

## Generar un borrador con Samanta
`POST /conversations/:id/assistant-drafts`

| | |
|---|---|
| Roles | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otra persona) |
| Respuesta | 201 · `SamantaDraft`, también cuando queda `STALE` o `FAILED`: revisa `status` |
| ft-crm | `assistantDraftsApi.generate(conversationId: string, sourceMessageId: string, idempotencyKey: string): Promise<SamantaDraft>` (nueva) |
| Caché | Guarda la respuesta en `qk.assistantDraft(conversationId, draft.id)` e invalida `qk.assistantDrafts(conversationId)`. |
| Cabeceras y límites | `Idempotency-Key` obligatoria. 429 al llegar al límite diario global (`SAMANTA_DAILY_LIMIT`, 100) o al de generaciones simultáneas (`SAMANTA_CONCURRENT_LIMIT`, 2). bk-crm espera a la IA hasta `SAMANTA_TIMEOUT_MS` (20 s; máximo 60 s), por eso el BFF da a esta ruta 65 s en lugar de los 15 s generales. |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |

**Cabeceras**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `Idempotency-Key` | string | Sí | `^[a-zA-Z0-9_-]{16,80}$`. Única por conversación. Una clave nueva por cada clic en «Generar»; la misma solo para recuperar o reintentar esa generación. |
| `Content-Type` | string | Sí | `application/json`. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `sourceMessageId` | `Uuid` | Sí | UUID del último mensaje de texto del cliente. Tiene que ser `INBOUND`, de tipo `TEXT`, con texto que no sea solo espacios y `content.length` ≤ 4096. Después de él solo puede haber mensajes `INBOUND` de tipo `OTHER` (reacciones, stickers, audios), que no cuentan. No admite `null`. |
| Cualquier otro | — | — | 400 `property <campo> should not exist` (p. ej. `model`). |

**Ejemplo de petición**

```ts
const [newest] = (await conversationsApi.messages(conversationId, { limit: 1 })).data;
if (newest?.direction === "INBOUND" && newest.type === "TEXT") {
  const key = newIdempotencyKey(); // una por clic en «Generar»
  const draft = await assistantDraftsApi.generate(conversationId, newest.id, key);
}
```

```http
POST /api/backend/conversations/6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14/assistant-drafts
Content-Type: application/json
Idempotency-Key: 9c2f7e4a-1b3d-4f6a-8e0c-2d4b6f8a0c1e

{"sourceMessageId":"1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f"}
```

**Respuesta** (201)

```json
{
  "id": "d8f0a2c4-6e8b-4d1f-a3c5-7e9b1d3f5a7c",
  "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
  "sourceMessageId": "1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f",
  "baselineSequence": 7,
  "idempotencyKey": "9c2f7e4a-1b3d-4f6a-8e0c-2d4b6f8a0c1e",
  "createdById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "reviewedById": null,
  "editedById": null,
  "status": "READY",
  "mode": "MANUAL",
  "revision": 1,
  "model": "gpt-6-luna",
  "promptVersion": "samanta-v3",
  "knowledgeHash": "3f9a1c7e5b2d4f6081a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
  "originalContent": "¡Hola! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? Un miembro del equipo confirmará la disponibilidad.",
  "content": "¡Hola! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? Un miembro del equipo confirmará la disponibilidad.",
  "intent": "RESERVATION",
  "requiresHuman": true,
  "missingFields": ["nombre"],
  "inputTokens": 2148,
  "outputTokens": 87,
  "errorCode": null,
  "availableAt": null,
  "generationStartedAt": "2026-11-03T02:32:50.058Z",
  "generationExpiresAt": "2026-11-03T02:33:20.051Z",
  "expiresAt": "2026-11-03T02:47:50.051Z",
  "reviewedAt": null,
  "outboundMessageId": null,
  "createdAt": "2026-11-03T02:32:50.058Z",
  "updatedAt": "2026-11-03T02:32:54.733Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. OWNER o SUPPORT). |
| 400 | `property <campo> should not exist` | Campos extra. Va primero en el array. |
| 400 | `sourceMessageId must be a UUID` | Falta, es `null` o no es un UUID. |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 503 | `Samanta está desactivada` | `SAMANTA_ENABLED` no es `true`. Se comprueba antes que la clave. |
| 400 | `Idempotency-Key inválida (16 a 80 caracteres)` | La cabecera falta o tiene otro formato. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 403 | `Conversación asignada a otro operador` | Un OPERATOR sin ADMIN actúa sobre una conversación asignada a otra persona. |
| 409 | `Idempotency-Key utilizada con otros datos` | La clave ya se usó en esta conversación con otro `sourceMessageId` o por otro usuario. |
| 409 | `Samanta está pausada en esta conversación` | `isAssistantPaused` es `true`. |
| 409 | `Selecciona el último mensaje entrante de texto (máximo 4096 caracteres)` | `sourceMessageId` no es de esta conversación, no es `INBOUND` o `TEXT`, está vacío, supera 4096 o después llegó otro mensaje que cuenta (cualquier `OUTBOUND` o un `INBOUND` que no sea `OTHER`). |
| 503 | `WhatsApp no está habilitado` · `Messenger no está habilitado` · `Instagram no está habilitado` · `El envío por Instagram no está configurado` | El canal de la conversación está apagado en el servidor. El último aparece con Instagram encendido sin `INSTAGRAM_ACCESS_TOKEN`, que solo recibe. Se comprueba antes de llamar a la IA. |
| 400 | `Conversación sin destinatario habilitado` | El canal no tiene envío (p. ej. `WEBSITE`) o el cliente no tiene destinatario. |
| 409 | `Ventana de WhatsApp cerrada; se requiere una plantilla aprobada` (o el texto de ventana cerrada de Messenger o Instagram) | El último mensaje del cliente tiene más de 24 h. Antes se generaba igual y el borrador no se podía aprobar; ahora no se llama a la IA. |
| 429 | `Límite de generación de Samanta alcanzado` | Se llegó al límite diario (generaciones iniciadas desde las 00:00 UTC, manuales y automáticas, incluidas las fallidas) o hay tantas generaciones en curso como permite el límite simultáneo. El body es `{ "statusCode": 429, "message": "…" }`, sin `error` ni `Retry-After`. |
| 409 | `Ya hay un borrador en generación` | Otro borrador de esta conversación sigue en `GENERATING` y no venció. |
| 409 | `Configura el restaurante antes de usar Samanta` | Falta la configuración del restaurante (`PUT /restaurant-config`). |
| 409 | `Contexto comercial demasiado extenso; requiere revisión manual` | La configuración del restaurante sola supera 32 000 bytes en UTF-8. Si lo que no cabe es el catálogo, se envían menos elementos en lugar de fallar. |
| 409 | `Historial demasiado extenso; requiere revisión manual` | Solo si ni siquiera cabe el último mensaje: los anteriores se omiten, del más antiguo al más reciente, hasta que el contexto quepa en 48 000 bytes. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta con la misma clave. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb. |
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre. |
| 504 | `El servidor del CRM tardó demasiado en responder. Inténtalo de nuevo.` (`code: "BACKEND_UNAVAILABLE"`) | Lo responde el BFF si bk-crm tarda más de 65 s. Repite con la misma clave. |

**Efectos**

- Crea el borrador en `GENERATING` antes de llamar a la IA (las consultas lo ven así mientras tanto) y lo deja en `READY`, `STALE` o `FAILED` al terminar.
- Cuenta para el límite diario aunque falle. Si OpenAI cobró la llamada, los tokens quedan en `inputTokens` y `outputTokens`, también cuando el borrador termina `STALE` o `FAILED` (por ejemplo, una respuesta cortada por el límite de tokens).
- Envía a la IA:
  - la configuración del restaurante, con su WhatsApp, correo, web y un enlace de Google Maps si tiene coordenadas;
  - hasta 30 elementos activos y aprobados de categorías activas, sin promociones vencidas ni eventos pasados, con hasta 10 variantes y 10 preguntas frecuentes cada uno;
  - la fecha, la hora y el día de la semana locales del restaurante;
  - el nombre del cliente;
  - sus solicitudes abiertas (`customer.pendingReservations`, desde el 9/11): hasta 3, las más recientes, de cualquier canal. Solo entran las que no tienen una reserva vinculada, están en `INCOMPLETE_DATA`, `READY_TO_SEND`, `SENT_TO_OWNER`, `WAITING_RESPONSE`, `MODIFICATION_REQUESTED` o `RENEGOTIATING`, y tienen fecha futura o, si no tienen fecha, se crearon en los últimos 30 días. De cada una van:
    - el código: el de la web (`externalReference`, `SM-…`) si lo tiene y, si no, el `RES-…`;
    - el canal (`sourceChannel`), la fecha y la hora locales con el día de la semana, y las personas;
    - solo en las de la web (`WEBSITE`), `formNotes`: lo que escribió el cliente en el formulario (`specialRequirements` y `comments`), sin las líneas que empiezan con `CRM: ` y con los enlaces, correos y teléfonos cambiados por `[enlace]`, `[correo]` y `[número]`, hasta 300 caracteres;
  - sus próximas reservas confirmadas (`customer.upcomingReservations`, desde el 9/11): hasta 3, las más cercanas, en `CONFIRMED`, `UPCOMING` o `RESCHEDULED` y con fecha futura, cada una con su código, su fecha y hora locales y las personas;
  - el canal con su largo máximo de respuesta: 4096 caracteres en WhatsApp, 2000 en Messenger y 800 en Instagram, que deja margen para su tope en bytes;
  - los últimos 20 mensajes de la conversación (entrantes y salientes ya enviados), cada uno con su hora local.

  No envía el teléfono ni el correo del cliente, las notas internas (del cliente, de las reservas ni las líneas `CRM: ` de las solicitudes) ni otras conversaciones. Con el prompt `samanta-v3`, Samanta no vuelve a pedir los datos de una solicitud que el cliente ya hizo: la menciona por su código y pregunta solo lo que falta o lo que quiere cambiar.
- No envía nada al cliente ni crea solicitudes ni reservas.
- Con la misma clave y los mismos datos no vuelve a llamar a la IA: devuelve el borrador que ya existe, con el estado recalculado.

**Notas para el frontend**

- **Cuándo habilitar «Generar»:**
  - El usuario tiene ADMIN u OPERATOR.
  - La conversación es `WHATSAPP`, `FACEBOOK` o `INSTAGRAM`.
  - `isAssistantPaused` es `false`.
  - El último mensaje que no es un `INBOUND` de tipo `OTHER` es `INBOUND` y `TEXT`, con texto y `content.length` ≤ 4096. Las reacciones, stickers y audios que llegaron después no bloquean.
  - Si el usuario es OPERATOR sin ADMIN, la conversación está libre o es suya.
  - Si el último mensaje del cliente tiene más de 24 h, deshabilítalo y explica que la ventana está cerrada.
- **Espera:** la petición dura lo que tarde la IA, hasta `SAMANTA_TIMEOUT_MS`. Muestra un estado de carga y no la canceles.
- **Recuperar tras un corte:** si la petición falla por red o con 504, repítela con la misma clave. Devuelve el borrador, que puede venir `GENERATING`; en ese caso síguelo con [Ver un borrador](#ver-un-borrador-de-samanta). Una clave nueva es otra generación: consume cuota y tokens.
- **Resultado:** sin error, siempre 201. Mira `status`:
  - `READY`: texto listo para revisar, editar, aprobar o rechazar.
  - `STALE`: durante la generación llegó otro mensaje, se pausó a Samanta o cambió la información comercial. Si fue esto último, trae el texto de todos modos.
  - `FAILED`: la IA falló; `errorCode` dice por qué.
  - `GENERATING`: solo al repetir la clave mientras la primera petición sigue en curso.
- **`errorCode` de un `FAILED`:**
  - Muestra siempre «No se pudo generar» y ofrece generar de nuevo con otra clave.
  - Para el equipo, distingue entre los fallos que se resuelven solos (reintentar) y los de configuración, que alguien tiene que corregir.

  | `errorCode` | Causa | Qué hacer |
  |---|---|---|
  | `AI_TIMEOUT` | La IA tardó más de `SAMANTA_TIMEOUT_MS` | Reintentar |
  | `AI_RATE_LIMITED` | OpenAI limitó la velocidad | Reintentar más tarde |
  | `AI_UNAVAILABLE` | OpenAI falló (5xx) o hubo un error de red | Reintentar más tarde |
  | `AI_QUOTA_EXCEEDED` | La cuenta de OpenAI no tiene saldo, facturación o cuota | Avisar al administrador: reintentar no sirve |
  | `AI_AUTH_FAILED` | Clave inválida o región no admitida (401/403) | Avisar al administrador |
  | `AI_MODEL_NOT_FOUND` | El modelo de `SAMANTA_MODEL` no existe o la cuenta no tiene acceso | Avisar al administrador |
  | `AI_REQUEST_REJECTED` | OpenAI rechazó la petición (otro 4xx) | Avisar al administrador |
  | `AI_INCOMPLETE_RESPONSE` | La respuesta quedó cortada, en general por `SAMANTA_MAX_OUTPUT_TOKENS` | Reintentar; si se repite, subir el límite |
  | `AI_INVALID_RESPONSE` · `AI_REFUSED_RESPONSE` · `AI_RESPONSE_TOO_LARGE` | Respuesta inválida, rechazada o demasiado grande | Reintentar |
  | `AI_GENERATION_EXPIRED` | La generación quedó abandonada | Reintentar |

  Las respuestas automáticas usan además códigos `AUTO_*` ([Samanta automática](#samanta-automática)).
- **Qué mostrar en `READY`:** el texto editable, `intent`, un aviso si `requiresHuman` es `true`, `missingFields` como etiquetas de texto libre y una cuenta atrás hasta `expiresAt` (15 min desde que se pidió).
- **Límites:** el 429 es global, no por usuario, y no hay endpoint para consultar la cuota restante. Las respuestas automáticas consumen la misma cuota diaria. Solo puede haber una generación en curso por conversación.
- **503:** `Samanta está desactivada` llega sin `code`: no lo trates como falta de conexión ([Errores comunes](#errores-comunes-a-todas-las-rutas)).

## Listar borradores de Samanta
`GET /conversations/:id/assistant-drafts`

| | |
|---|---|
| Roles | ADMIN, OPERATOR, OWNER |
| Respuesta | 200 · `SamantaDraftListResponse` |
| ft-crm | `assistantDraftsApi.list(conversationId: string): Promise<SamantaDraftListResponse>` (nueva) |
| Caché | `qk.assistantDrafts(conversationId)` (nueva) |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |

No tiene query ni paginación: si envías parámetros, se ignoran.

**Respuesta**

```json
{
  "data": [
    {
      "id": "d8f0a2c4-6e8b-4d1f-a3c5-7e9b1d3f5a7c",
      "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
      "sourceMessageId": "1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f",
      "baselineSequence": 7,
      "idempotencyKey": "9c2f7e4a-1b3d-4f6a-8e0c-2d4b6f8a0c1e",
      "createdById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
      "reviewedById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
      "editedById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
      "status": "APPROVED",
      "mode": "MANUAL",
      "revision": 2,
      "model": "gpt-6-luna",
      "promptVersion": "samanta-v3",
      "knowledgeHash": "3f9a1c7e5b2d4f6081a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
      "originalContent": "¡Hola! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? Un miembro del equipo confirmará la disponibilidad.",
      "content": "¡Hola, Lucía! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? En breve te confirmamos la disponibilidad.",
      "intent": "RESERVATION",
      "requiresHuman": true,
      "missingFields": ["nombre"],
      "inputTokens": 2148,
      "outputTokens": 87,
      "errorCode": null,
      "availableAt": null,
      "generationStartedAt": "2026-11-03T02:32:50.058Z",
      "generationExpiresAt": "2026-11-03T02:33:20.051Z",
      "expiresAt": "2026-11-03T02:47:50.051Z",
      "reviewedAt": "2026-11-03T02:34:02.415Z",
      "outboundMessageId": "e2a4c6e8-0b1d-4f3a-8c5e-7a9b1d3f5c7e",
      "createdAt": "2026-11-03T02:32:50.058Z",
      "updatedAt": "2026-11-03T02:34:02.418Z"
    },
    {
      "id": "b4d6f8a0-2c4e-4f6a-9b1d-3e5f7a9c1b3d",
      "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
      "sourceMessageId": "2b4d6f80-1a3c-4e5f-9b7d-8c0e2a4b6d8f",
      "baselineSequence": 3,
      "idempotencyKey": "0e2c4a6b-8d1f-4e3a-b5c7-9d1e3f5a7b9c",
      "createdById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
      "reviewedById": null,
      "editedById": null,
      "status": "FAILED",
      "mode": "MANUAL",
      "revision": 1,
      "model": "gpt-6-luna",
      "promptVersion": "samanta-v3",
      "knowledgeHash": "3f9a1c7e5b2d4f6081a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
      "originalContent": null,
      "content": null,
      "intent": null,
      "requiresHuman": true,
      "missingFields": [],
      "inputTokens": null,
      "outputTokens": null,
      "errorCode": "AI_TIMEOUT",
      "availableAt": null,
      "generationStartedAt": "2026-11-03T02:32:50.058Z",
      "generationExpiresAt": "2026-11-02T23:41:37.512Z",
      "expiresAt": "2026-11-02T23:56:07.512Z",
      "reviewedAt": null,
      "outboundMessageId": null,
      "createdAt": "2026-11-02T23:41:07.519Z",
      "updatedAt": "2026-11-02T23:41:27.840Z"
    }
  ]
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OPERATOR ni OWNER (p. ej. solo SUPPORT). |
| 400 | `Validation failed (uuid is expected)` | `:id` no es un UUID. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta. |

**Efectos**

- Recalcula y guarda el estado de cada borrador devuelto: un `GENERATING` con `generationExpiresAt` vencido pasa a `FAILED` (`AI_GENERATION_EXPIRED`), y un `READY` o `GENERATING` pasa a `STALE` si llegó otro mensaje, si Samanta está en pausa o si venció `expiresAt`.
- No comprueba cambios en la información comercial: eso se detecta al terminar la generación, al editar y al aprobar.

**Notas para el frontend**

- Devuelve como máximo los 50 borradores más recientes (`createdAt` y luego `id`, descendente), sin paginación ni filtros. El envoltorio es `{ data }`, sin `pagination`.
- Funciona aunque Samanta esté desactivada.
- Cualquier ADMIN, OPERATOR u OWNER puede leer los borradores, aunque la conversación esté asignada a otra persona. OWNER puede consultar, pero no actuar.
- Úsala para el panel de Samanta y para marcar como «Samanta» los mensajes cuyo `id` coincide con el `outboundMessageId` de un borrador `APPROVED`. Solo cubre los 50 borradores más recientes: un mensaje aprobado desde un borrador más antiguo se verá como de quien lo aprobó.
- Como la consulta recalcula estados, un borrador puede volver `STALE` sin que nadie haya actuado sobre él. Refréscala después de enviar, pausar, aprobar o rechazar, y con el ritmo del chat mientras el panel esté abierto.

## Ver un borrador de Samanta
`GET /conversations/:id/assistant-drafts/:draftId`

| | |
|---|---|
| Roles | ADMIN, OPERATOR, OWNER |
| Respuesta | 200 · `SamantaDraft` |
| ft-crm | `assistantDraftsApi.get(conversationId: string, draftId: string): Promise<SamantaDraft>` (nueva) |
| Caché | `qk.assistantDraft(conversationId, draftId)` (nueva) |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |
| `draftId` | `Uuid` | Id del borrador. Tiene que ser de esa conversación. |

No tiene query: si envías parámetros, se ignoran.

**Respuesta** (un borrador mientras la IA trabaja)

```json
{
  "id": "d8f0a2c4-6e8b-4d1f-a3c5-7e9b1d3f5a7c",
  "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
  "sourceMessageId": "1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f",
  "baselineSequence": 7,
  "idempotencyKey": "9c2f7e4a-1b3d-4f6a-8e0c-2d4b6f8a0c1e",
  "createdById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "reviewedById": null,
  "editedById": null,
  "status": "GENERATING",
  "mode": "MANUAL",
  "revision": 1,
  "model": "gpt-6-luna",
  "promptVersion": "samanta-v3",
  "knowledgeHash": "3f9a1c7e5b2d4f6081a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
  "originalContent": null,
  "content": null,
  "intent": null,
  "requiresHuman": true,
  "missingFields": [],
  "inputTokens": null,
  "outputTokens": null,
  "errorCode": null,
  "availableAt": null,
  "generationStartedAt": "2026-11-03T02:32:50.058Z",
  "generationExpiresAt": "2026-11-03T02:33:20.051Z",
  "expiresAt": "2026-11-03T02:47:50.051Z",
  "reviewedAt": null,
  "outboundMessageId": null,
  "createdAt": "2026-11-03T02:32:50.058Z",
  "updatedAt": "2026-11-03T02:32:50.058Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN, OPERATOR ni OWNER (p. ej. solo SUPPORT). |
| 400 | `Validation failed (uuid is expected)` | `:id` o `:draftId` no es un UUID. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 404 | `Borrador no encontrado` | El borrador no existe o es de otra conversación. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta. |

**Efectos**

Los mismos que la lista, para este borrador: puede guardarlo como `FAILED` (`AI_GENERATION_EXPIRED`) o `STALE`.

**Notas para el frontend**

- Úsala para seguir un borrador en `GENERATING`, por ejemplo después de un 504 o al recargar la página. Consulta cada 2 o 3 s ([flujo de Samanta](README.md#samanta-borradores-con-revisión-humana)) hasta que el estado cambie. La espera tiene tope: la primera consulta después de `generationExpiresAt` lo deja `FAILED`.
- Deja de consultar cuando el estado sea final (`APPROVED`, `REJECTED`, `STALE` o `FAILED`).
- Lo pueden leer ADMIN, OPERATOR y OWNER, aunque la conversación esté asignada a otra persona.

## Editar un borrador
`PATCH /conversations/:id/assistant-drafts/:draftId`

| | |
|---|---|
| Roles | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otra persona) |
| Respuesta | 200 · `SamantaDraft` |
| ft-crm | `assistantDraftsApi.edit(conversationId: string, draftId: string, body: EditSamantaDraftRequest): Promise<SamantaDraft>` (nueva) |
| Caché | Guarda la respuesta en `qk.assistantDraft(conversationId, draftId)` e invalida `qk.assistantDrafts(conversationId)`. |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |
| `draftId` | `Uuid` | Id del borrador. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `revision` | number | Sí | Entero de 1 a 2 147 483 646. Tiene que ser la `revision` actual del borrador. |
| `content` | string | Sí | Al menos un carácter que no sea espacio en blanco. No admite `null`. Tope del DTO: 4096 caracteres contando cada emoji como 1; el servicio exige además `content.length` ≤ 4096. Se guarda tal cual, sin recortar. |
| Cualquier otro | — | — | 400 `property <campo> should not exist` (p. ej. `intent` o `missingFields`: no se pueden editar). |

**Ejemplo de petición**

```ts
const edited = await assistantDraftsApi.edit("6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14", draft.id, {
  revision: draft.revision,
  content:
    "¡Hola, Lucía! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? En breve te confirmamos la disponibilidad.",
});
```

```http
PATCH /api/backend/conversations/6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14/assistant-drafts/d8f0a2c4-6e8b-4d1f-a3c5-7e9b1d3f5a7c
Content-Type: application/json

{"revision":1,"content":"¡Hola, Lucía! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? En breve te confirmamos la disponibilidad."}
```

**Respuesta**

```json
{
  "id": "d8f0a2c4-6e8b-4d1f-a3c5-7e9b1d3f5a7c",
  "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
  "sourceMessageId": "1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f",
  "baselineSequence": 7,
  "idempotencyKey": "9c2f7e4a-1b3d-4f6a-8e0c-2d4b6f8a0c1e",
  "createdById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "reviewedById": null,
  "editedById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "status": "READY",
  "mode": "MANUAL",
  "revision": 2,
  "model": "gpt-6-luna",
  "promptVersion": "samanta-v3",
  "knowledgeHash": "3f9a1c7e5b2d4f6081a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
  "originalContent": "¡Hola! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? Un miembro del equipo confirmará la disponibilidad.",
  "content": "¡Hola, Lucía! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? En breve te confirmamos la disponibilidad.",
  "intent": "RESERVATION",
  "requiresHuman": true,
  "missingFields": ["nombre"],
  "inputTokens": 2148,
  "outputTokens": 87,
  "errorCode": null,
  "availableAt": null,
  "generationStartedAt": "2026-11-03T02:32:50.058Z",
  "generationExpiresAt": "2026-11-03T02:33:20.051Z",
  "expiresAt": "2026-11-03T02:47:50.051Z",
  "reviewedAt": null,
  "outboundMessageId": null,
  "createdAt": "2026-11-03T02:32:50.058Z",
  "updatedAt": "2026-11-03T02:33:41.270Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. OWNER o SUPPORT). |
| 400 | `property <campo> should not exist` | Campos extra. Va primero en el array. |
| 400 | `content must be shorter than or equal to 4096 characters` · `content must match /\S/ regular expression` · `content must be a string` | `content` falta, es `null` o no es texto (los tres); vacío o solo espacios (el segundo); más de 4096 caracteres contando cada emoji como 1 (el primero). Van antes que los de `revision`. |
| 400 | `revision must not be greater than 2147483646` · `revision must not be less than 1` · `revision must be an integer number` | `revision` falta, es `null` o viene como texto (los tres); es 0 o negativa (el segundo); es decimal (el tercero); supera el tope (el primero). |
| 400 | `Validation failed (uuid is expected)` | `:id` o `:draftId` no es un UUID. |
| 503 | `Samanta está desactivada` | `SAMANTA_ENABLED` no es `true`. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 403 | `Conversación asignada a otro operador` | Un OPERATOR sin ADMIN actúa sobre una conversación asignada a otra persona. |
| 404 | `Borrador no encontrado` | El borrador no existe o es de otra conversación. |
| 409 | `El borrador cambió; vuelve a revisarlo` | `revision` no es la actual. Se comprueba antes que el estado. |
| 409 | `Borrador desactualizado o fallido; genera uno nuevo` | El borrador está `STALE` o `FAILED`, o queda `STALE` en esta llamada (mensaje nuevo, pausa, `expiresAt` vencido o cambio en la información comercial). |
| 409 | `El borrador no está disponible para revisión` | El borrador está `GENERATING`, `APPROVED` o `REJECTED`. |
| 400 | `Contenido inválido` | `content.length` supera 4096 aunque pasó el DTO (p. ej. por emojis, que cuentan 2). |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb. |
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre. |

**Efectos**

- Guarda `content`, pone `editedById` y suma 1 a `revision`. El estado sigue `READY`.
- `originalContent`, `intent`, `requiresHuman` y `missingFields` no cambian.
- Si el borrador quedó desactualizado, lo guarda como `STALE` y responde 409.

**Notas para el frontend**

- Guarda la `revision` de la respuesta: aprobar o rechazar con la anterior responde 409 `El borrador cambió; vuelve a revisarlo`.
- Si dos personas editan a la vez, la segunda recibe ese 409: vuelve a pedir el borrador y muestra el texto actual antes de que siga.
- Editar no es idempotente: si reintentas tras un error de red o un 504 y la primera llamada sí llegó, la `revision` ya subió y recibes el mismo 409. Pide el borrador y compara su `content` con el que enviaste antes de repetir.
- Solo se edita en `READY`. `SAMANTA_DRAFT_ACTIONS` ([Tipos TypeScript](#tipos-typescript)) dice qué acciones admite cada estado.
- `intent`, `requiresHuman` y `missingFields` describen el texto original de la IA: tras editar, pueden no coincidir con el texto nuevo.
- Para el contador del editor usa `content.length`, con tope 4096, que es lo que acepta esta ruta. Para poder aprobar, el texto tiene que caber en el canal: 4096 caracteres en WhatsApp, 2000 en Messenger, y 1000 caracteres y 1000 bytes UTF-8 en Instagram. Si no cabe, aprobar responde 400 y el borrador sigue `READY`. En Instagram, Samanta recibe un tope de 800 caracteres, pero no lo garantiza. ft-crm ya aplica estos topes en el editor del borrador (8/11).

## Aprobar un borrador y encolar el envío
`POST /conversations/:id/assistant-drafts/:draftId/approve`

| | |
|---|---|
| Roles | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otra persona) |
| Respuesta | 202 · `SamantaDraft` en `APPROVED`, con `outboundMessageId` |
| ft-crm | `assistantDraftsApi.approve(conversationId: string, draftId: string, revision: number): Promise<SamantaDraft>` (nueva) |
| Caché | Guarda la respuesta en `qk.assistantDraft(conversationId, draftId)`. Invalida `qk.assistantDrafts(conversationId)`, `qk.messages(conversationId)` (hay un saliente nuevo), `qk.conversation(conversationId)` y `["conversations", "list"]`. |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |
| `draftId` | `Uuid` | Id del borrador. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `revision` | number | Sí | Entero de 1 a 2 147 483 646. Tiene que ser la `revision` actual. |
| Cualquier otro | — | — | 400 `property <campo> should not exist` (p. ej. `content`: para cambiar el texto, edita antes). |

**Ejemplo de petición**

```ts
const approved = await assistantDraftsApi.approve("6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14", edited.id, edited.revision);
```

```http
POST /api/backend/conversations/6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14/assistant-drafts/d8f0a2c4-6e8b-4d1f-a3c5-7e9b1d3f5a7c/approve
Content-Type: application/json

{"revision":2}
```

**Respuesta** (202)

```json
{
  "id": "d8f0a2c4-6e8b-4d1f-a3c5-7e9b1d3f5a7c",
  "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
  "sourceMessageId": "1c3e5a7b-9d2f-4b4a-8e6c-0a2b4c6d8e0f",
  "baselineSequence": 7,
  "idempotencyKey": "9c2f7e4a-1b3d-4f6a-8e0c-2d4b6f8a0c1e",
  "createdById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "reviewedById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "editedById": "9a7b5c3d-1e2f-4a6b-8c9d-0e1f2a3b4c5d",
  "status": "APPROVED",
  "mode": "MANUAL",
  "revision": 2,
  "model": "gpt-6-luna",
  "promptVersion": "samanta-v3",
  "knowledgeHash": "3f9a1c7e5b2d4f6081a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
  "originalContent": "¡Hola! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? Un miembro del equipo confirmará la disponibilidad.",
  "content": "¡Hola, Lucía! Con gusto te ayudamos con tu solicitud para 4 personas este sábado a las 8 p. m. ¿A nombre de quién la registramos? En breve te confirmamos la disponibilidad.",
  "intent": "RESERVATION",
  "requiresHuman": true,
  "missingFields": ["nombre"],
  "inputTokens": 2148,
  "outputTokens": 87,
  "errorCode": null,
  "availableAt": null,
  "generationStartedAt": "2026-11-03T02:32:50.058Z",
  "generationExpiresAt": "2026-11-03T02:33:20.051Z",
  "expiresAt": "2026-11-03T02:47:50.051Z",
  "reviewedAt": "2026-11-03T02:34:02.415Z",
  "outboundMessageId": "e2a4c6e8-0b1d-4f3a-8c5e-7a9b1d3f5c7e",
  "createdAt": "2026-11-03T02:32:50.058Z",
  "updatedAt": "2026-11-03T02:34:02.418Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. OWNER o SUPPORT). |
| 400 | `property <campo> should not exist` | Campos extra (p. ej. `content`). |
| 400 | `revision must not be greater than 2147483646` · `revision must not be less than 1` · `revision must be an integer number` | `revision` falta, es `null` o viene como texto (los tres); es 0 o negativa; es decimal; supera el tope. |
| 400 | `Validation failed (uuid is expected)` | `:id` o `:draftId` no es un UUID. |
| 503 | `Samanta está desactivada` | `SAMANTA_ENABLED` no es `true`. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 403 | `Conversación asignada a otro operador` | Un OPERATOR sin ADMIN actúa sobre una conversación asignada a otra persona. |
| 404 | `Borrador no encontrado` | El borrador no existe o es de otra conversación. |
| 409 | `El borrador cambió; vuelve a revisarlo` | `revision` no es la actual. Se comprueba antes que el estado. |
| 409 | `Borrador desactualizado o fallido; genera uno nuevo` | El borrador está `STALE` o `FAILED`, o queda `STALE` en esta llamada (mensaje nuevo, pausa, `expiresAt` vencido o cambio en la información comercial). |
| 409 | `El borrador no está disponible para revisión` | El borrador está `GENERATING` o `REJECTED`, o ya lo aprobó otra persona. |
| 409 | `Idempotency-Key ya utilizada con otros datos` | Ya hay en la conversación un mensaje con la clave `samanta-<draftId>` de otro autor o con otro texto (alguien envió a mano con ese prefijo). El borrador sigue `READY`. |
| 503 | `WhatsApp no está habilitado` · `Messenger no está habilitado` · `Instagram no está habilitado` · `El envío por Instagram no está configurado` | El canal de la conversación está apagado en el servidor, o Instagram no tiene `INSTAGRAM_ACCESS_TOKEN`. El borrador sigue `READY`. |
| 400 | `WhatsApp admite hasta 4096 caracteres por respuesta` · `Messenger admite hasta 2000 caracteres por respuesta` · `Instagram admite hasta 1000 caracteres por respuesta` · `Instagram admite hasta 1000 bytes por respuesta; las tildes y los emojis ocupan más de uno` | El `content` del borrador (admite hasta 4096) no cabe en el canal. El borrador sigue `READY`: edítalo y vuelve a aprobar. |
| 400 | `Conversación sin destinatario habilitado` | El cliente ya no tiene destinatario en el canal: en WhatsApp, sin teléfono internacional válido; en Messenger o Instagram, es una identidad de otra página o cuenta. El borrador sigue `READY`. |
| 409 | `Ventana de WhatsApp cerrada; se requiere una plantilla aprobada` · `Ventana de Messenger cerrada; el cliente debe enviar un nuevo mensaje` · `Ventana de Instagram cerrada; el cliente debe enviar un nuevo mensaje` | No hay un `INBOUND` del cliente en las últimas 24 h. El borrador sigue `READY`. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb. |
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre. |

**Efectos**

- En una sola transacción:
  - crea un mensaje `OUTBOUND` `TEXT` en `QUEUED` con el `content` actual del borrador (el editado, si se editó), con quien aprueba como autor y la clave interna `samanta-<draftId>`;
  - pasa el borrador a `APPROVED` con `reviewedById`, `reviewedAt` y `outboundMessageId`.
- El mensaje nuevo suma 1 a la secuencia de la conversación: los demás borradores `READY` pasan a `STALE` al consultarlos, y la conversación sube en la bandeja (`lastMessageAt`).
- Si el encolado falla (clave usada, canal apagado, texto más largo que el tope del canal, sin destinatario o ventana cerrada), no se crea nada y el borrador sigue `READY`.

**Notas para el frontend**

- `APPROVED` no significa entregado. Busca `outboundMessageId` en la página 1 del historial y sigue su `status` como el de cualquier saliente. No hay endpoint para pedir un mensaje suelto.
- Repetir la aprobación (mismo usuario, misma `revision`) responde 202 con el mismo borrador y no duplica el mensaje. Si otra persona ya lo aprobó, recibes 409 `El borrador no está disponible para revisión`.
- En el historial, ese mensaje tiene como `authorUserId` a quien aprobó: identifícalo como de Samanta por `outboundMessageId`.
- La ventana de 24 h se comprueba igual que al enviar a mano: si el último mensaje del cliente tiene más de 24 h, deshabilita «Aprobar» y explica por qué.
- Si la respuesta es 409 por desactualización, refresca el panel y ofrece generar otro borrador.

## Rechazar un borrador
`POST /conversations/:id/assistant-drafts/:draftId/reject`

| | |
|---|---|
| Roles | ADMIN, OPERATOR (un OPERATOR no puede si la conversación está asignada a otra persona) |
| Respuesta | 200 · `SamantaDraft` en `REJECTED` |
| ft-crm | `assistantDraftsApi.reject(conversationId: string, draftId: string, revision: number): Promise<SamantaDraft>` (nueva) |
| Caché | Guarda la respuesta en `qk.assistantDraft(conversationId, draftId)` e invalida `qk.assistantDrafts(conversationId)`. |

**Parámetros de ruta**

| Parámetro | Tipo | Reglas |
|---|---|---|
| `id` | `Uuid` | Id de la conversación. |
| `draftId` | `Uuid` | Id del borrador. |

**Body**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `revision` | number | Sí | Entero de 1 a 2 147 483 646. Tiene que ser la `revision` actual. |
| Cualquier otro | — | — | 400 `property <campo> should not exist`. |

**Ejemplo de petición**

```ts
const rejected = await assistantDraftsApi.reject("6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14", draft.id, draft.revision);
```

```http
POST /api/backend/conversations/6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14/assistant-drafts/a1c3e5f7-9b2d-4f6a-8c0e-1d3f5a7b9c2e/reject
Content-Type: application/json

{"revision":1}
```

**Respuesta** (200; otro borrador, rechazado por un ADMIN)

```json
{
  "id": "a1c3e5f7-9b2d-4f6a-8c0e-1d3f5a7b9c2e",
  "conversationId": "6f1c2a4e-8b7d-4c1e-9a3f-2d5e7b9c0a14",
  "sourceMessageId": "6a8c0e2b-4d6f-4a1c-9e3b-5d7f9b1d3f5a",
  "baselineSequence": 9,
  "idempotencyKey": "7b1d3f5a-9c2e-4b6d-8f0a-2c4e6a8b0d1f",
  "createdById": "2e4a6c8e-0b2d-4f6a-8c1e-3a5c7e9b1d3f",
  "reviewedById": "2e4a6c8e-0b2d-4f6a-8c1e-3a5c7e9b1d3f",
  "editedById": null,
  "status": "REJECTED",
  "mode": "MANUAL",
  "revision": 1,
  "model": "gpt-6-luna",
  "promptVersion": "samanta-v3",
  "knowledgeHash": "3f9a1c7e5b2d4f6081a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
  "originalContent": "¡Hola! Gracias por escribirnos. ¿Para qué fecha y cuántas personas deseas la reserva?",
  "content": "¡Hola! Gracias por escribirnos. ¿Para qué fecha y cuántas personas deseas la reserva?",
  "intent": "RESERVATION",
  "requiresHuman": true,
  "missingFields": ["fecha", "personas"],
  "inputTokens": 1984,
  "outputTokens": 41,
  "errorCode": null,
  "availableAt": null,
  "generationStartedAt": "2026-11-03T03:05:11.337Z",
  "generationExpiresAt": "2026-11-03T03:05:41.330Z",
  "expiresAt": "2026-11-03T03:20:11.330Z",
  "reviewedAt": "2026-11-03T03:06:02.904Z",
  "outboundMessageId": null,
  "createdAt": "2026-11-03T03:05:11.337Z",
  "updatedAt": "2026-11-03T03:06:02.907Z"
}
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 401 | `Tu sesión terminó. Vuelve a iniciar sesión.` (`SESSION_EXPIRED`) · `Inicia sesión para continuar.` (`NO_SESSION`) | Lo responde el BFF: no hay una sesión válida. |
| 403 | `No tienes permisos para realizar esta acción` | El usuario no tiene ADMIN ni OPERATOR (p. ej. OWNER o SUPPORT). |
| 400 | `property <campo> should not exist` | Campos extra. |
| 400 | `revision must not be greater than 2147483646` · `revision must not be less than 1` · `revision must be an integer number` | `revision` falta, es `null` o viene como texto (los tres); es 0 o negativa; es decimal; supera el tope. |
| 400 | `Validation failed (uuid is expected)` | `:id` o `:draftId` no es un UUID. |
| 404 | `Conversación no encontrada` | La conversación no existe. |
| 403 | `Conversación asignada a otro operador` | Un OPERATOR sin ADMIN actúa sobre una conversación asignada a otra persona. |
| 404 | `Borrador no encontrado` | El borrador no existe o es de otra conversación. |
| 409 | `El borrador cambió; vuelve a revisarlo` | `revision` no es la actual. Se comprueba antes que el estado. |
| 409 | `Borrador desactualizado o fallido; genera uno nuevo` | El borrador está `STALE` o `FAILED`, o pasa a uno de esos estados en esta llamada (mensaje nuevo, pausa, vencimiento). No comprueba la información comercial. |
| 409 | `El borrador no está disponible para revisión` | El borrador está `GENERATING` o `APPROVED`, o ya lo rechazó otra persona. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención en la base de datos. Reintenta. |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El body supera 100 kb. |
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). `apiFetch` no envía `charset`, así que desde ft-crm no ocurre. |

**Efectos**

- Pasa el borrador a `REJECTED`, con `reviewedById` y `reviewedAt`. Es un estado final.
- No envía nada al cliente.

**Notas para el frontend**

- Funciona aunque Samanta esté desactivada: no responde 503.
- Repetirlo con el mismo usuario y la misma `revision` responde 200 con el mismo borrador.
- No hace falta rechazar para descartar: un borrador sin usar deja de servir con el siguiente mensaje o a los 15 min, y queda `STALE` en la siguiente consulta. Rechazar deja constancia de quién lo descartó.

## Samanta automática

No hay rutas nuevas. Con `SAMANTA_AUTO_ENABLED=true` en el servidor, Samanta responde sola a cada mensaje de texto del cliente en las conversaciones sin pausa de los canales configurados (`SAMANTA_AUTO_CHANNELS`: WhatsApp, Messenger e Instagram). El frontend lo ve en las rutas que ya usa.

**Flujo**

1. Llega un mensaje de texto. Al procesarlo, el backend crea un borrador `mode: "AUTO"` en `SCHEDULED` con `availableAt` = llegada + `SAMANTA_AUTO_DELAY_MS` (8 s por defecto). Aparece en [Listar borradores](#listar-borradores-de-samanta).
2. Si el cliente escribe otra vez antes de `availableAt`, ese borrador pasa a `STALE` y se crea otro para el mensaje nuevo: una sola respuesta para varios mensajes seguidos. Las reacciones, stickers y audios no programan respuesta ni cancelan la pendiente.
3. Llegado `availableAt`, pasa a `GENERATING` y la IA responde con el historial.
4. Con envío activo, pasa a `APPROVED`: el mensaje se encola como cualquier envío, con `authorUserId` y `reviewedById` = `SAMANTA_USER_ID`, y aparece en el historial. En modo sombra (`SAMANTA_AUTO_SEND=false`) queda en `READY` y no se envía nada: el equipo lo revisa y lo aprueba o rechaza como uno manual.

**Cuándo deja de responder (pausa automática)**

| Situación | Qué pasa | `assistantPauseReason` |
|---|---|---|
| El cliente pide una persona, reclama, cancela o cambia una reserva, menciona alergias, o confirma los datos de una reserva | Samanta envía su respuesta (p. ej. «Te comunico con una persona del equipo») y pausa la conversación | `SAMANTA_HANDOFF` |
| Falla la IA, el envío se rechaza o se supera un límite | Pausa sin enviar nada. El borrador queda `FAILED` con su `errorCode` | `SAMANTA_HANDOFF` |
| Un operador envía un mensaje a mano | Pausa; la respuesta automática pendiente se descarta (`STALE`) | `OPERATOR_REPLIED` |
| Alguien pausa con `PATCH :id/assistant` | Pausa | `MANUAL` |

Una conversación pausada no se reanuda sola. Al reanudarla (`{ "paused": false }`), Samanta responde desde el siguiente mensaje del cliente; los que llegaron durante la pausa los atiende la persona.

**`errorCode` de las respuestas automáticas**

| `errorCode` | Causa | ¿Pausa? |
|---|---|---|
| `AUTO_DAILY_LIMIT` | Se agotó `SAMANTA_DAILY_LIMIT` (compartido con los borradores manuales) | Sí |
| `AUTO_CONVERSATION_LIMIT` | Se superó `SAMANTA_AUTO_MAX_PER_HOUR` respuestas en la conversación en una hora | Sí |
| `AUTO_SEND_REJECTED` | El canal rechazó el texto: más largo que su tope (en Instagram, también más de 1000 bytes) o la ventana se cerró mientras se generaba | Sí |
| `AI_CONTEXT_UNAVAILABLE` | Falta la configuración del restaurante o no cabe en el contexto | Sí |
| `AUTO_EXPIRED` · `AUTO_INTERNAL_ERROR` | La respuesta quedó demasiado tiempo pendiente, o hubo un error interno | Sí |
| `AUTO_CANNOT_REPLY` | El canal está apagado, el cliente no tiene destinatario o la ventana de 24 h está cerrada. No se llama a la IA | No |
| `AI_*` | Igual que en los manuales ([Generar](#generar-un-borrador-con-samanta)) | Sí |

**Notas para el frontend**

- **Mensajes de Samanta:** `authorUserId === SAMANTA_USER_ID`. Muéstralos como «Samanta», no como «Equipo».
- **Panel de Samanta:**
  - Un borrador `AUTO` en `SCHEDULED` o `GENERATING` es «Samanta está respondiendo».
  - En `APPROVED` ya se envió: no ofrezcas aprobarlo.
  - En `READY` (modo sombra), ofrece revisarlo, aprobarlo o rechazarlo igual que uno manual.
  - Sigue en pie la regla de aprobación: un OPERATOR sin ADMIN solo puede en conversaciones libres o suyas.
- **Bandeja:**
  - Destaca las conversaciones con `assistantPauseReason: "SAMANTA_HANDOFF"`: Samanta pidió que las atienda una persona.
  - El motivo concreto está en el último borrador `AUTO` (`intent`, `requiresHuman`, `errorCode`).
  - El `conversationMode` actual sigue sirviendo: sin pausa es «Samanta».
- **Actualización:** no hay eventos. El polling que ya existe trae la pausa (lista y detalle de conversaciones), los mensajes de Samanta (historial) y los borradores (`qk.assistantDrafts(id)`).
- **Reservas:** Samanta recoge fecha, hora, personas y nombre, y transfiere. No confirma ni crea solicitudes ni reservas. Desde el 9/11 conoce las solicitudes abiertas y las próximas reservas del cliente ([Generar › Efectos](#generar-un-borrador-con-samanta)): si el cliente ya pidió la reserva en la web, la menciona por su código y no vuelve a pedirle los datos.

## Webhooks de Meta (no usar desde el frontend)
`GET /webhooks/whatsapp` · `POST /webhooks/whatsapp` · `GET /webhooks/messenger` · `POST /webhooks/messenger` · `GET /webhooks/instagram` · `POST /webhooks/instagram`

Los llama Meta, directo a bk-crm, para verificar la suscripción y para entregar mensajes y recibos. El frontend nunca los usa: el BFF responde 404 `Ruta no disponible.` a `/api/backend/webhooks/*`. Se documentan para entender qué llega a la Bandeja y cuándo. Para el frontend, su efecto visible son conversaciones, mensajes y cambios de estado nuevos en el siguiente polling.

**Instagram.** `GET /webhooks/instagram` y `POST /webhooks/instagram` siguen las reglas de los de Messenger: verificación con `INSTAGRAM_VERIFY_TOKEN`, firma `X-Hub-Signature-256` con `META_APP_SECRET`, 200 `{ "received": true }` y 503 `Instagram no está habilitado` con el canal apagado. La activación está en `bk-crm/docs/instagram-webhook.md`. Lo que llega a la Bandeja:
- Cada mensaje directo crea o reutiliza el cliente por cuenta e IGSID, sin `phone` ni `email`, y su conversación `INSTAGRAM`. El texto se guarda como `TEXT`, y un adjunto sin texto, como `OTHER` con `[Adjunto de Instagram no compatible todavía]`.
- Si el cliente no tiene `firstName` ni `lastName` y el servidor tiene `INSTAGRAM_ACCESS_TOKEN`, bk-crm pide a Meta el nombre del perfil y lo guarda en `firstName`; si el perfil no tiene nombre, guarda `@usuario`.
- Se ignoran los ecos, los mensajes borrados o no compatibles, las reacciones, los postbacks y los recibos. Por eso los salientes de Instagram nunca pasan de `SENT`, y lo que el restaurante responda desde la app de Instagram no aparece en la Bandeja.

### Verificar el webhook de WhatsApp
`GET /webhooks/whatsapp`

| | |
|---|---|
| Roles | Pública: la llama Meta, sin JWT |
| Respuesta | 200 · texto plano con el valor de `hub.challenge` (`Content-Type: text/plain; charset=utf-8`) |
| ft-crm | No se usa desde el navegador: el BFF bloquea `/webhooks/*`. |
| Caché | — (no cambia datos) |

**Query**

| Campo | Tipo | Obligatorio | Por defecto | Reglas |
|---|---|---|---|---|
| `hub.mode` | string | Sí | — | Debe ser `subscribe`. |
| `hub.verify_token` | string | Sí | — | Igual a `WHATSAPP_VERIFY_TOKEN` del servidor. |
| `hub.challenge` | string | Sí | — | No vacío. Se devuelve tal cual. |

**Ejemplo de petición**

```http
GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=1158201444
```

**Respuesta**

```text
1158201444
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 503 | `WhatsApp no está habilitado` | `WHATSAPP_ENABLED` no es `true`. Se comprueba primero. |
| 403 | `Verificación inválida` | `hub.mode` distinto de `subscribe`, token distinto, o `hub.challenge` vacío, ausente o repetido. |

El cuerpo de estos errores es el JSON habitual (`statusCode`, `message`, `error`), pero llega con `Content-Type: text/plain; charset=utf-8`: Nest pone la cabecera de la ruta antes de ejecutarla y `res.json` no la reemplaza.

**Efectos**

Ninguno.

### Recibir eventos de WhatsApp
`POST /webhooks/whatsapp`

| | |
|---|---|
| Roles | Pública: la llama Meta, autenticada por la firma |
| Respuesta | 200 · `MetaWebhookAck` |
| ft-crm | No se usa desde el navegador: el BFF bloquea `/webhooks/*`. |
| Caché | Ninguna directa: lo que guarda aparece en el siguiente polling de `qk.conversations(query)`, `qk.conversation(id)` y `qk.messages(id)`. |

**Cabeceras**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `X-Hub-Signature-256` | string | Sí | `sha256=` y 64 caracteres hexadecimales: HMAC-SHA256 del cuerpo crudo con `META_APP_SECRET`. |
| `Content-Type` | string | Sí | `application/json`, que es lo que envía Meta. Con otro tipo, el evento no se procesa. |

**Body** (solo los campos que lee bk-crm; el resto se ignora)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `object` | string | Sí | Solo se procesa `whatsapp_business_account`. |
| `entry[].id` | string | Sí | Tiene que ser `WHATSAPP_BUSINESS_ACCOUNT_ID`; si no, la entrada se ignora. |
| `entry[].changes[].field` | string | Sí | Solo se procesa `messages`. |
| `entry[].changes[].value.metadata.phone_number_id` | string | Sí | Tiene que ser `WHATSAPP_PHONE_NUMBER_ID`. |
| `…value.messages[]` | array | No | `from`: teléfono internacional sin `+` (7 a 15 dígitos, sin 0 inicial). `id`: wamid, hasta 255 caracteres. `timestamp`: segundos Unix, como mucho 60 s en el futuro. `type`. `text.body`: hasta 16 000 caracteres. `image` y `document`: `id`, `mime_type`, `filename` y `caption`. `button.text` (tipo `button`: botón de respuesta rápida de una plantilla) e `interactive.button_reply.title` o `interactive.list_reply.title` (tipo `interactive`): el texto que eligió el cliente. |
| `…value.statuses[]` | array | No | `id` (wamid de un saliente), `status` (`sent`, `delivered`, `read` o `failed`; los demás se ignoran) y `timestamp`. |

**Ejemplo de petición**

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102938475610293",
      "changes": [
        {
          "field": "messages",
          "value": {
            "messaging_product": "whatsapp",
            "metadata": { "display_phone_number": "51911222333", "phone_number_id": "109876543210987" },
            "messages": [
              {
                "from": "51987654321",
                "id": "wamid.HBgLNTE5ODc2NTQzMjEVAgASGBQzQUI3RjY0QjE4QzJEMUE5NzUwNAA=",
                "timestamp": "1793673129",
                "type": "text",
                "text": { "body": "¿Tienen mesa para 4 personas este sábado a las 8 pm?" }
              }
            ],
            "statuses": [
              {
                "id": "wamid.HBgLNTE5ODc2NTQzMjEVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA",
                "status": "delivered",
                "timestamp": "1793672953",
                "recipient_id": "51987654321"
              }
            ]
          }
        }
      ]
    }
  ]
}
```

**Respuesta**

```json
{ "received": true }
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El cuerpo supera 100 kb. |
| 400 | Texto del parser de JSON | El cuerpo no es JSON válido. Lo rechaza el parser, antes que la firma. |
| 503 | `WhatsApp no está habilitado` | `WHATSAPP_ENABLED` no es `true`. |
| 403 | `Firma inválida` | Falta la firma, no tiene el formato o no coincide con los bytes recibidos. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención al guardar. Meta reintenta la entrega. |
| 500 | `Ocurrió un error interno` | Falla la base de datos u otro error no controlado. El evento no se confirma y Meta lo reintenta. |

**Efectos**

- Por cada mensaje:
  - busca o crea el cliente por teléfono (`+<from>`). Si el teléfono ya era de un cliente, usa ese cliente y actualiza su `lastContactAt`;
  - crea la conversación `WHATSAPP` del cliente si no existe;
  - guarda el `INBOUND` en `RECEIVED` con su entrada en la cola, suma 1 a la secuencia y actualiza `lastMessageAt`.
- `text` se guarda como `TEXT`; `image` como `IMAGE` y `document` como `FILE`, con la metadata en `attachments` y el pie en `content`.
- Desde el 9/11, el toque de un botón se guarda como `TEXT`, con el texto del botón en `content` (hasta 1000 caracteres): tipo `button` (botón de respuesta rápida de una plantilla, `button.text`) o tipo `interactive` (`button_reply.title` o `list_reply.title`). Samanta lo responde como cualquier mensaje de texto.
- Cualquier otro tipo, o un botón sin texto, se guarda como `OTHER` con `[Mensaje de WhatsApp no compatible todavía]`.
- Un wamid repetido no se duplica ni toca el cliente.
- Los recibos se guardan y el worker los aplica cada 2 s ([Estados y transiciones](#estados-y-transiciones)). Si el mensaje aún no llegó a `SENT`, el recibo se vuelve a mirar cada 60 s.
- Se ignoran, con 200: otro `object`, otra cuenta, otro número u otro `field`.
- Quedan en cuarentena (solo se guarda una huella, con el código `WHATSAPP_EVENT_INVALID`), también con 200: eventos mal formados, fechas futuras, un `from` que `libphonenumber` no reconoce como teléfono válido y un wamid ya guardado con otro teléfono. Ese mensaje no llega a la Bandeja.
- No guarda el nombre de perfil del cliente: un cliente nuevo de WhatsApp queda sin nombre.

**Notas para el frontend**

- Un cliente nuevo de WhatsApp llega sin nombre: muestra su teléfono hasta que alguien lo edite en Clientes.
- La entrega y la lectura de los salientes llegan por esta ruta, así que tardan lo que tarde Meta en enviarlas, más el ciclo de 2 s del worker.

### Verificar el webhook de Messenger
`GET /webhooks/messenger`

| | |
|---|---|
| Roles | Pública: la llama Meta, sin JWT |
| Respuesta | 200 · texto plano con el valor de `hub.challenge` (`Content-Type: text/plain; charset=utf-8`) |
| ft-crm | No se usa desde el navegador: el BFF bloquea `/webhooks/*`. |
| Caché | — (no cambia datos) |

**Query**

| Campo | Tipo | Obligatorio | Por defecto | Reglas |
|---|---|---|---|---|
| `hub.mode` | string | Sí | — | Debe ser `subscribe`. |
| `hub.verify_token` | string | Sí | — | Igual a `MESSENGER_VERIFY_TOKEN` del servidor. |
| `hub.challenge` | string | Sí | — | No vacío. Se devuelve tal cual. |

**Ejemplo de petición**

```http
GET /webhooks/messenger?hub.mode=subscribe&hub.verify_token=<MESSENGER_VERIFY_TOKEN>&hub.challenge=8837419920
```

**Respuesta**

```text
8837419920
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 503 | `Messenger no está habilitado` | `MESSENGER_ENABLED` no es `true`. Se comprueba primero. |
| 403 | `Verificación inválida` | `hub.mode` distinto de `subscribe`, token distinto, o `hub.challenge` vacío, ausente o repetido. |

Como en WhatsApp, el cuerpo de estos errores es JSON pero llega con `Content-Type: text/plain; charset=utf-8`.

**Efectos**

Ninguno.

### Recibir eventos de Messenger
`POST /webhooks/messenger`

| | |
|---|---|
| Roles | Pública: la llama Meta, autenticada por la firma |
| Respuesta | 200 · `MetaWebhookAck` |
| ft-crm | No se usa desde el navegador: el BFF bloquea `/webhooks/*`. |
| Caché | Ninguna directa: lo que guarda aparece en el siguiente polling de `qk.conversations(query)`, `qk.conversation(id)` y `qk.messages(id)`. |

**Cabeceras**

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `X-Hub-Signature-256` | string | Sí | `sha256=` y 64 caracteres hexadecimales: HMAC-SHA256 del cuerpo crudo con `META_APP_SECRET`. |
| `Content-Type` | string | Sí | `application/json`, que es lo que envía Meta. Con otro tipo, el evento no se procesa. |

**Body** (solo los campos que lee bk-crm; el resto se ignora)

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `object` | string | Sí | Solo se procesa `page` (Instagram y otros se ignoran). |
| `entry[].id` | string | Sí | Tiene que ser `MESSENGER_PAGE_ID`. |
| `entry[].messaging[].recipient.id` | string | Sí | Tiene que ser la página; si no, el evento se ignora. |
| `entry[].messaging[].sender.id` | string | Sí | PSID numérico del cliente, de hasta 80 dígitos. Si es la propia página, se ignora. |
| `…timestamp` | number | Sí en los mensajes | Milisegundos Unix, como mucho 60 s en el futuro. En una entrega puede faltar si trae `watermark`. |
| `…message` | object | No | `mid` (hasta 255 caracteres) y `text` (hasta 16 000). Se ignoran los ecos (`is_echo`), los borrados (`is_deleted`) y los no soportados (`is_unsupported`). |
| `…delivery` | object | No | `mids` y `watermark` (milisegundos); los dos son opcionales. |

**Ejemplo de petición**

```json
{
  "object": "page",
  "entry": [
    {
      "id": "100200300400500",
      "time": 1793673312004,
      "messaging": [
        {
          "sender": { "id": "7329184650123987" },
          "recipient": { "id": "100200300400500" },
          "timestamp": 1793671123950,
          "message": { "mid": "m_Aq3xV9pL2kR7tY1uZ8wB4cD6eF0gH5jK", "text": "¿Hasta qué hora atienden el feriado?" }
        },
        {
          "sender": { "id": "7329184650123987" },
          "recipient": { "id": "100200300400500" },
          "timestamp": 1793673312000,
          "delivery": { "mids": ["m_Ht5yU2iO8pA4sD6fG1hJ3kL9zX7cV0bN"], "watermark": 1793673311400 }
        }
      ]
    }
  ]
}
```

**Respuesta**

```json
{ "received": true }
```

**Errores**

| Código | Mensaje exacto | Cuándo |
|---|---|---|
| 415 | `unsupported charset "<CHARSET>"` | `Content-Type` con un charset que no empieza por `utf-` (p. ej. `latin1`, o `utf8` sin guion). |
| 413 | `El cuerpo de la petición supera el tamaño máximo permitido` | El cuerpo supera 100 kb. |
| 400 | Texto del parser de JSON | El cuerpo no es JSON válido. Lo rechaza el parser, antes que la firma. |
| 503 | `Messenger no está habilitado` | `MESSENGER_ENABLED` no es `true`. |
| 403 | `Firma inválida` | Falta la firma, no tiene el formato o no coincide con los bytes recibidos. |
| 409 | `Conflicto de mensajería; vuelve a intentarlo` | Contención al guardar. Meta reintenta la entrega. |
| 500 | `Ocurrió un error interno` | Falla la base de datos u otro error no controlado. El evento no se confirma y Meta lo reintenta. |

**Efectos**

- Por cada mensaje:
  - busca o crea el cliente por página y PSID. Nunca lo mezcla con un cliente de teléfono o email, y no le inventa `phone` ni `email`. Si ya existía, actualiza su `lastContactAt`;
  - crea la conversación `FACEBOOK` del cliente si no existe y guarda el `INBOUND` (`TEXT` si trae `text`; si solo trae adjuntos, `OTHER` con `[Adjunto de Messenger no compatible todavía]`).
- **Nombre automático:** para los clientes sin `firstName` ni `lastName`, bk-crm pide a Meta el remitente del mensaje recién guardado y guarda su nombre en `firstName` (hasta 100 caracteres; `lastName` queda `null`).
  - Nunca sobrescribe un nombre puesto en el CRM.
  - Hace como mucho 3 consultas por webhook, en paralelo, de hasta 2 s cada una, después de guardar los mensajes.
  - Si Meta no da el nombre o da uno genérico («Facebook User», «Usuario de Facebook»), queda `null` y se vuelve a intentar con el siguiente mensaje del cliente. Si la consulta falla, el log registra `MESSENGER_NAME_LOOKUP_FAILED`, sin el PSID ni el nombre.
- **Entregas:** marca `DELIVERED` los `mids` listados y, con `watermark`, las respuestas `SENT` a ese cliente cuyo `sentAt` no pasa de `watermark` + 2 s. `deliveredAt` es la hora del evento, o el `watermark` si el evento no trae una hora válida o es anterior a él. En las respuestas confirmadas solo por `watermark`, nunca es anterior a su `sentAt`.
- Se ignoran, con 200: lecturas (`read`), postbacks, eventos `standby` y otras páginas.
- Quedan en cuarentena (código `MESSENGER_EVENT_INVALID`), también con 200: eventos mal formados, ids no numéricos, fechas futuras y un `mid` ya guardado con otro remitente.

**Notas para el frontend**

- Messenger v1 no informa lecturas: el último estado posible de un saliente es `DELIVERED`.
- El nombre del cliente puede aparecer un instante después de su mensaje, porque la consulta a Meta se hace después de guardarlo.

## Modelos

### Conversation

Respuesta de cada fila de `GET /conversations`, de `GET /conversations/:id` y de `PATCH /conversations/:id/assistant` y `/assignee` (`conversationSelect` y `conversationResponse` en `src/messaging/messaging.select.ts`).

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id de la conversación. |
| `customerId` | `Uuid` | No | Cliente. Hay una sola conversación por cliente y canal. |
| `channel` | `ContactChannel` | No | Canal. Messenger es `FACEBOOK`. Las conversaciones se crean al llegar un mensaje de WhatsApp, Messenger o Instagram y, desde el 9/11, la `WHATSAPP` de un cliente de la web cuando el backend le envía la plantilla de su solicitud ([03](03-clientes-reservas.md#solicitudes-que-llegan-de-la-web)). |
| `isAssistantPaused` | boolean | No | `true`: Samanta no responde sola ni se pueden generar o usar borradores. Por defecto, `false`. |
| `assistantPauseReason` | `AssistantPauseReason` | Sí | Por qué está en pausa: `MANUAL` (alguien la pausó con `PATCH :id/assistant`), `OPERATOR_REPLIED` (un operador escribió a mano con el modo automático activo) o `SAMANTA_HANDOFF` (Samanta transfirió la conversación a una persona). `null` si no está en pausa. Las pausas anteriores al 8/11 tienen `MANUAL`. |
| `assistantPausedAt` | `IsoDateTime` | Sí | Desde cuándo está en pausa. `null` si no lo está. |
| `assignedUserId` | `Uuid` | Sí | Responsable. `null`: conversación libre. |
| `lastMessageAt` | `IsoDateTime` | Sí | Hora de llegada (del servidor) del último `INBOUND` o de encolado del último `OUTBOUND`. Ordena la bandeja. `null` si la conversación no tiene mensajes. |
| `createdAt` | `IsoDateTime` | No | Creación: el primer mensaje del cliente por ese canal, o la plantilla de WhatsApp que avisa de una solicitud de la web. |
| `updatedAt` | `IsoDateTime` | No | Última escritura: mensaje nuevo, pausa o asignación. Marcar como leído no lo cambia. |
| `customer` | `ConversationCustomer` | No | Datos básicos del cliente. |
| `assignedUser` | `ConversationAssignedUser` | Sí | Responsable; `null` si no hay. |
| `unreadCount` | number | No | `INBOUND` con `readAt = null`. Es del equipo, no de cada usuario. |

No se exponen `externalConversationId` ni `lastSequence`.

### ConversationCustomer (`Conversation.customer`)

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del cliente (para `GET /customers/:id`). |
| `firstName` | string | Sí | Nombre. Cliente nuevo de WhatsApp: `null` hasta que alguien lo edite en Clientes (si el teléfono ya era de un cliente, trae el nombre que tenía). Messenger: el nombre visible que da Meta, completo, si lo da. Instagram: el nombre del perfil o, si no tiene, `@usuario`. Cliente nuevo de la web: el nombre del formulario. |
| `lastName` | string | Sí | Apellido. Messenger e Instagram nunca lo completan solos. |
| `phone` | string | Sí | Teléfono tal como se guardó (WhatsApp: `+51987654321`). Messenger e Instagram: `null`, salvo que alguien lo agregue en Clientes. No hace falta para responder en esos canales. |
| `email` | string | Sí | Correo. `null` en los clientes creados por WhatsApp, Messenger o Instagram, salvo que alguien lo agregue. |

No incluye el canal de origen, el estado ni las notas (están en `GET /customers/:id`). Los identificadores de Messenger (PSID) e Instagram (IGSID), que son el destinatario de las respuestas, no se exponen en ninguna ruta.

### ConversationAssignedUser (`Conversation.assignedUser`)

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del usuario. |
| `firstName` | string | No | Nombre. |
| `lastName` | string | No | Apellido. |
| `isActive` | boolean | No | El usuario está activo. |
| `isEligible` | boolean | No | Está activo y tiene rol ADMIN u OPERATOR. `false`: conviene reasignar. |

### Message

Respuesta de cada fila de `GET /conversations/:id/messages` y de `POST /conversations/:id/messages` (`messageSelect`).

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del mensaje. |
| `conversationId` | `Uuid` | No | Conversación. |
| `channel` | `ContactChannel` | No | Canal de la conversación. |
| `sequence` | number | No | Correlativo por conversación desde 1: orden real del chat. |
| `externalMessageId` | string | Sí | wamid (WhatsApp) o mid (Messenger e Instagram). `INBOUND`: siempre viene. `OUTBOUND`: desde `SENT`. |
| `direction` | `MessageDirection` | No | `INBOUND` (cliente → CRM) u `OUTBOUND` (CRM → cliente). |
| `status` | `MessageStatus` | No | Ver [Estados y transiciones](#estados-y-transiciones). |
| `type` | `MessageType` | No | `TEXT`, `IMAGE`, `FILE` u `OTHER`. Los salientes siempre son `TEXT`. Un toque del cliente en un botón (de una plantilla o un mensaje interactivo) llega como `INBOUND` `TEXT` con el texto del botón, p. ej. «Sí, continuar». |
| `content` | string | Sí | Texto. `null` solo en `IMAGE` o `FILE` sin pie de foto. En una plantilla, es la versión del CRM del texto enviado. |
| `templateName` | string | Sí | Solo `OUTBOUND` de WhatsApp: nombre de la plantilla aprobada en Meta con que se envió (p. ej. `solicitud_reserva_web`), el único tipo de mensaje que puede escribir primero o con la ventana de 24 h cerrada. `null` en los demás. Desde el 9/11. |
| `authorUserId` | `Uuid` | Sí | `INBOUND`: `null`. `OUTBOUND`: quien envió o aprobó el borrador, o `SAMANTA_USER_ID` si Samanta respondió sola o avisó al cliente de una reserva de la web; nunca `null`. |
| `occurredAt` | `IsoDateTime` | Sí | `INBOUND`: hora que informa Meta. `OUTBOUND`: `null`. |
| `receivedAt` | `IsoDateTime` | Sí | `INBOUND`: llegada a bk-crm. `OUTBOUND`: `null`. |
| `processedAt` | `IsoDateTime` | Sí | `INBOUND` en `PROCESSED`: fin del procesamiento. |
| `sentAt` | `IsoDateTime` | Sí | `OUTBOUND`: Meta aceptó el envío. |
| `deliveredAt` | `IsoDateTime` | Sí | `OUTBOUND`: entregado (WhatsApp y Messenger). En Instagram siempre es `null`. |
| `providerReadAt` | `IsoDateTime` | Sí | `OUTBOUND` de WhatsApp: leído por el cliente. |
| `failedAt` | `IsoDateTime` | Sí | Momento del fallo (`FAILED`). |
| `readAt` | `IsoDateTime` | Sí | `INBOUND`: leído por el equipo en el CRM. `OUTBOUND`: siempre `null`. |
| `errorCode` | `MessageErrorCode` | Sí | Motivo del estado. Ver [Estados y transiciones](#estados-y-transiciones). |
| `createdAt` | `IsoDateTime` | No | Creación del registro. |
| `updatedAt` | `IsoDateTime` | No | Cambia con cada cambio de estado, de `errorCode` o de `readAt`. |
| `attachments` | `MessageAttachment[]` | No | Metadata de adjuntos, por `id` ascendente. Vacío salvo en `IMAGE` y `FILE`. |

No se exponen la clave de idempotencia, el destinatario, la cuenta del negocio, los intentos de envío ni el motivo interno del error.

### MessageAttachment

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del adjunto. |
| `type` | `"IMAGE" \| "FILE" \| "OTHER"` | No | Hoy solo llegan `IMAGE` (foto) y `FILE` (documento), por WhatsApp. |
| `fileName` | string | Sí | Nombre del documento, si Meta lo da. |
| `mimeType` | string | Sí | Tipo MIME, si Meta lo da. |
| `sizeBytes` | number | Sí | Tamaño. WhatsApp no lo envía: `null`. |
| `externalMediaId` | string | Sí | Id del archivo en Meta. En WhatsApp siempre viene. |
| `url` | string | Sí | URL del archivo. WhatsApp no la envía: `null`. |
| `createdAt` | `IsoDateTime` | No | Creación. |

### MarkConversationReadResponse

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `updated` | number | No | `INBOUND` marcados en esta llamada (0 si ya estaban leídos). |
| `throughMessageId` | `Uuid` | No | El mismo id que se envió. |

### SamantaDraft

Respuesta de todas las rutas de borradores: la fila completa del borrador.

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `id` | `Uuid` | No | Id del borrador. |
| `conversationId` | `Uuid` | No | Conversación (`WHATSAPP`, `FACEBOOK` o `INSTAGRAM`). |
| `sourceMessageId` | `Uuid` | No | Mensaje `INBOUND` de texto al que responde. |
| `baselineSequence` | number | No | `sequence` de `sourceMessageId`. Si después llega un mensaje que cuenta (cualquier `OUTBOUND`, o un `INBOUND` que no sea `OTHER`), el borrador queda desactualizado. |
| `idempotencyKey` | string | No | Clave usada al generar. En los automáticos, `auto-<sourceMessageId>`. |
| `createdById` | `Uuid` | No | Quien pidió la generación; `SAMANTA_USER_ID` en los automáticos. |
| `reviewedById` | `Uuid` | Sí | Quien aprobó o rechazó; `SAMANTA_USER_ID` si Samanta lo envió sola. |
| `editedById` | `Uuid` | Sí | Último usuario que editó el texto. |
| `status` | `SamantaDraftStatus` | No | Ver [Estados y transiciones](#estados-y-transiciones). |
| `mode` | `SamantaDraftMode` | No | `MANUAL`: lo pidió una persona con [Generar](#generar-un-borrador-con-samanta). `AUTO`: lo creó Samanta al llegar un mensaje ([Samanta automática](#samanta-automática)). |
| `revision` | number | No | Empieza en 1 y suma 1 con cada edición. |
| `model` | string | No | Modelo de IA (`SAMANTA_MODEL`; por defecto, `gpt-6-luna`). |
| `promptVersion` | string | No | Versión del prompt: `samanta-v3` desde el 9/11 (con las solicitudes y las reservas del cliente en el contexto). Los borradores anteriores traen `samanta-v2` (8/11) o `samanta-drafts-v1`. |
| `knowledgeHash` | string | No | SHA-256 (hex) de la configuración y el catálogo usados. Si cambian, el borrador queda `STALE` al editar o aprobar. `""` mientras un automático espera en `SCHEDULED`. |
| `originalContent` | string | Sí | Texto que dio la IA. `null` mientras está `GENERATING`, si falló, o si quedó `STALE` durante la generación por un mensaje nuevo, una pausa o el vencimiento. |
| `content` | string | Sí | Texto actual (el editado, si se editó). Mismos casos de `null`. Nunca es `null` en `READY` ni en `APPROVED`. |
| `intent` | `SamantaIntent` | Sí | Intención detectada. Se guarda junto con el texto de la IA: es `null` en los mismos casos que `originalContent`, aunque la IA haya respondido. |
| `requiresHuman` | boolean | No | `true` por defecto. Toma el valor de la IA solo cuando se guarda su texto; si no, se queda en `true`. No se recalcula al editar. |
| `missingFields` | string[] | No | Datos que faltan, en texto libre (hasta 8, de hasta 80 caracteres). `[]` mientras no se guarde el texto de la IA. |
| `inputTokens` | number | Sí | Tokens de entrada. `null` si OpenAI no cobró la llamada. Si la cobró, se guardan aunque el texto se descarte (`STALE` o `FAILED`). |
| `outputTokens` | number | Sí | Tokens de salida. `null` si OpenAI no cobró la llamada. |
| `errorCode` | `SamantaErrorCode` | Sí | Solo en `FAILED`. |
| `availableAt` | `IsoDateTime` | Sí | Solo en los automáticos: cuándo se responde (llegada del mensaje + `SAMANTA_AUTO_DELAY_MS`). `null` en los manuales. |
| `generationStartedAt` | `IsoDateTime` | Sí | Cuándo se llamó a la IA. Es lo que cuenta para el límite diario. `null` si nunca llegó a generarse (un automático descartado en `SCHEDULED`). |
| `generationExpiresAt` | `IsoDateTime` | Sí | Inicio de la generación + `SAMANTA_TIMEOUT_MS` + 10 s. Después, un `GENERATING` pasa a `FAILED`. `null` mientras un automático espera en `SCHEDULED`. |
| `expiresAt` | `IsoDateTime` | No | Creación + 15 min. Después, un `READY` pasa a `STALE`. |
| `reviewedAt` | `IsoDateTime` | Sí | Momento de la aprobación o el rechazo. |
| `outboundMessageId` | `Uuid` | Sí | Mensaje creado al aprobar. Siempre presente en `APPROVED`, y solo en ese estado. |
| `createdAt` | `IsoDateTime` | No | Creación. |
| `updatedAt` | `IsoDateTime` | No | Último cambio. |

### SamantaDraftListResponse

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `data` | `SamantaDraft[]` | No | Hasta 50 borradores, los más recientes primero. |

### MetaWebhookAck

| Campo | Tipo | Null | Significado |
|---|---|---|---|
| `received` | `true` | No | Siempre `true`: Meta da el evento por entregado. |

## Estados y transiciones

### Mensajes entrantes (`direction: "INBOUND"`)

Ninguna ruta cambia estos estados: los mueve el worker de procesamiento (necesita `MESSAGING_ENABLED=true`). En v1, el procesamiento solo valida el mensaje: no responde ni crea nada.

| Estado | Significado | Pasa a |
|---|---|---|
| `RECEIVED` | Guardado; espera al worker. Con `errorCode` `MESSAGE_PROCESSING_TEMPORARY`, el intento anterior falló y se reintentará tras una espera que empieza en 1 s, se duplica y llega como mucho a 60 s. | `PROCESSING` |
| `PROCESSING` | Un worker lo está procesando. En un reintento conserva `MESSAGE_PROCESSING_TEMPORARY` hasta terminar. | `PROCESSED` (borra `errorCode`), `RECEIVED` (fallo temporal) o `FAILED` |
| `PROCESSED` | Final. `processedAt` tiene la hora. | — |
| `FAILED` | Final. `errorCode`: `MESSAGE_INVALID` (no pasó la validación) o `MESSAGE_ATTEMPTS_EXHAUSTED` (5 intentos agotados). | — |

`readAt` es independiente del estado: lo pone [Marcar como leído](#marcar-como-leído-hasta-un-mensaje).

### Mensajes salientes (`direction: "OUTBOUND"`)

Se crean en `QUEUED` con [Enviar un mensaje](#enviar-un-mensaje-de-texto) o con [Aprobar un borrador](#aprobar-un-borrador-y-encolar-el-envío) (ADMIN u OPERATOR). El backend crea además los suyos, con `authorUserId` = `SAMANTA_USER_ID`: las respuestas de [Samanta automática](#samanta-automática) y, desde el 9/11, el aviso al cliente de una reserva de la web, que es un mensaje normal o, con la ventana de 24 h cerrada, una plantilla de WhatsApp con `templateName` ([03](03-clientes-reservas.md#solicitudes-que-llegan-de-la-web)). Las plantillas no dependen de la ventana. Después solo los mueve el sistema: el worker de envío y los recibos de Meta. No hay ruta para reintentar, cancelar ni cambiar el estado de un mensaje.

| Estado | Significado | Pasa a |
|---|---|---|
| `QUEUED` | En cola. Con `*_RATE_LIMITED`, Meta respondió 429 y se reintentará tras la mayor de dos esperas: la que pidió Meta y una que crece desde 1 s con cada intento. Si su canal está apagado, se queda aquí hasta que se encienda. | `SENDING`; `FAILED` con `*_SEND_INVALID`, `*_WINDOW_CLOSED` o, en una plantilla con más de 6 h en cola, `WHATSAPP_TEMPLATE_EXPIRED` |
| `SENDING` | Un worker está llamando a Meta. En un reintento conserva el `*_RATE_LIMITED` anterior hasta terminar. | `SENT` (borra `errorCode`); `QUEUED` (429, hasta 5 intentos); `UNKNOWN`; `FAILED` con `*_SEND_REJECTED` |
| `SENT` | Meta lo aceptó: hay `externalMessageId` y `sentAt`. | `DELIVERED`, `READ` (WhatsApp) o `FAILED` con `*_DELIVERY_FAILED`. En Instagram es final: bk-crm no procesa sus recibos. |
| `DELIVERED` | Meta confirmó la entrega. | `READ` (WhatsApp) |
| `READ` | Final. El cliente lo leyó (solo WhatsApp). | — |
| `UNKNOWN` | Envío incierto: timeout, error de red, HTTP 5xx o 408, respuesta sin id, o el worker se cayó durante el envío. Meta pudo recibirlo. Nunca se reenvía solo. | `SENT` o `FAILED`, solo si llega tarde la respuesta del mismo intento |
| `FAILED` | No se envió o no se entregó; `errorCode` dice por qué. | `DELIVERED` o `READ` si después llega un recibo de entrega o lectura |

Reglas de los recibos de Meta:
- `READ` nunca retrocede.
- `DELIVERED` y `READ` prevalecen sobre `FAILED`, pero un recibo `sent` tardío no deshace un `FAILED`.
- Un recibo que llega antes de que el mensaje esté `SENT` espera y se vuelve a revisar cada 60 s.
- Las fechas (`sentAt`, `deliveredAt`, `providerReadAt`, `failedAt`) conservan la más temprana entre los recibos.

`errorCode` de los salientes (con prefijo `WHATSAPP_`, `MESSENGER_` o `INSTAGRAM_`; `INSTAGRAM_DELIVERY_FAILED` no se produce, porque Instagram no tiene recibos):

| Código | Estado | Significado | Texto sugerido |
|---|---|---|---|
| `*_RATE_LIMITED` | `QUEUED` o `SENDING` | Meta limitó el envío (429); hay un reintento programado o en curso. | «Reintentando…» |
| `*_SEND_UNKNOWN` | `UNKNOWN` | No se sabe si Meta lo recibió. | «Estado incierto: verifica antes de reenviar» |
| `*_SEND_INVALID` | `FAILED` | No se podía enviar: sin destinatario, texto vacío o más largo que el tope (en Instagram, también con más de 1000 bytes), una plantilla sin idioma, cambió el número, la página o la cuenta de Instagram del negocio, o intentos agotados. | «No se envió» |
| `*_WINDOW_CLOSED` | `FAILED` | La ventana de 24 h se cerró antes de enviar. No aplica a las plantillas. | «No se envió: pasaron más de 24 h desde el último mensaje del cliente» |
| `*_SEND_REJECTED` | `FAILED` | Meta lo rechazó (4xx) o siguió limitando tras 5 intentos. En Instagram, también cuando la cuenta del cliente no tiene un rol en la app de Meta y la app solo tiene acceso estándar. | «No se envió: el canal lo rechazó» |
| `*_DELIVERY_FAILED` | `FAILED` | Meta lo aceptó, pero después informó que no pudo entregarlo. Solo WhatsApp y Messenger. | «No se pudo entregar» |
| `WHATSAPP_TEMPLATE_EXPIRED` | `FAILED` | Solo plantillas de WhatsApp (desde el 9/11): pasaron más de 6 h en cola sin poder enviarse, por ejemplo con WhatsApp o Redis caídos. Se descarta para no avisar tarde al cliente. | «No se envió: la plantilla esperó demasiado en cola» |

### Conversación: pausa y responsable

| Dato | Valores | Cómo cambia | Quién | Error si no se permite |
|---|---|---|---|---|
| `isAssistantPaused` | `false` (por defecto) o `true`, en cualquier dirección | [`PATCH /conversations/:id/assistant`](#pausar-o-reanudar-a-samanta-en-la-conversación) | ADMIN, OPERATOR | 403 `No tienes permisos para realizar esta acción` (OWNER, SUPPORT) |
| `assignedUserId` | `null` (libre) o el id de un usuario elegible | [`PATCH /conversations/:id/assignee`](#asignar-tomar-o-liberar-una-conversación) | ADMIN: cualquier cambio. OPERATOR: tomar una libre o liberar la suya | 403 `Solo puedes tomar conversaciones libres o desasignarte de las propias`; 404 `Usuario no encontrado`; 400 `Responsable no elegible` |

Cambios automáticos de la pausa, solo con el [modo automático](#samanta-automática) activo:

| Cuándo | Resultado |
|---|---|
| Un operador envía un mensaje a mano ([Enviar](#enviar-un-mensaje-de-texto)) y la conversación no estaba en pausa | `isAssistantPaused: true`, `assistantPauseReason: "OPERATOR_REPLIED"` |
| Samanta transfiere la conversación: el cliente pide una persona, hay un reclamo o una cancelación, confirma los datos de una reserva, falla la IA o el envío, o se supera un límite | `isAssistantPaused: true`, `assistantPauseReason: "SAMANTA_HANDOFF"` |

Nadie reanuda solo: para que Samanta vuelva a atender, alguien llama a `PATCH :id/assistant` con `{ "paused": false }`. Ningún cambio automático toca el responsable. Si el responsable se desactiva o pierde sus roles, sigue asignado con `isEligible: false`.

### Borradores de Samanta (`SamantaDraft.status`)

| Estado | Significado | ¿Final? | Qué mostrar |
|---|---|---|---|
| `SCHEDULED` | Solo automáticos: Samanta responderá a partir de `availableAt`. Espera unos segundos por si el cliente sigue escribiendo. | No | «Samanta está por responder». |
| `GENERATING` | La IA está generando. | No | Indicador de carga y polling del borrador. |
| `READY` | Texto listo para editar, aprobar o rechazar. | No | Texto editable, `intent`, aviso de `requiresHuman`, `missingFields` y cuenta atrás hasta `expiresAt`. |
| `APPROVED` | Aprobado: se encoló el mensaje `outboundMessageId`. | Sí | «Enviado a la cola», con el estado del mensaje `outboundMessageId`. |
| `REJECTED` | Descartado por una persona. | Sí | «Descartado». |
| `STALE` | Desactualizado: llegó otro mensaje, se pausó a Samanta, venció o cambió la información comercial. | Sí | «Desactualizado», con la opción de generar otro. |
| `FAILED` | La generación falló o quedó abandonada (`errorCode`). | Sí | «No se pudo generar», con la opción de generar otro. |

| Desde | Hacia | Cuándo | Quién |
|---|---|---|---|
| — | `GENERATING` | [Generar](#generar-un-borrador-con-samanta) crea el borrador antes de llamar a la IA. | ADMIN u OPERATOR (no asignado a otra persona) |
| `GENERATING` | `READY` | La IA da un texto válido y la información comercial no cambió. | Sistema, en la misma petición |
| `GENERATING` | `STALE` | Solo al terminar (consultarlo ya no lo cambia, para no liberar su plaza antes de tiempo): llegó otro mensaje que cuenta, Samanta está en pausa o venció `expiresAt`. Los manuales, además, si cambió la información comercial. | Sistema |
| `GENERATING` | `FAILED` | La IA falló (`AI_*`), o se consulta o actúa después de `generationExpiresAt` (`AI_GENERATION_EXPIRED`). | Sistema |
| — | `SCHEDULED` | Automático: el worker procesó un mensaje de texto del cliente en una conversación sin pausa. Si ya había otro `SCHEDULED` en la conversación, ese pasa a `STALE` (una sola respuesta para varios mensajes seguidos). | Sistema |
| `SCHEDULED` | `GENERATING` | Automático: llegó `availableAt`, hay cupo y la ventana de 24 h está abierta. | Sistema |
| `SCHEDULED` | `STALE` | Automático: llegó un mensaje más nuevo, alguien escribió, se pausó a Samanta o se apagó el canal. | Sistema |
| `SCHEDULED` | `FAILED` | Automático: límite diario (`AUTO_DAILY_LIMIT`) o por conversación (`AUTO_CONVERSATION_LIMIT`), canal sin envío o ventana cerrada (`AUTO_CANNOT_REPLY`), contexto inválido (`AI_CONTEXT_UNAVAILABLE`) o venció (`AUTO_EXPIRED`). | Sistema |
| `GENERATING` | `APPROVED` | Automático con envío activo: Samanta encola la respuesta, con `reviewedById` = `SAMANTA_USER_ID`. | Sistema |
| `GENERATING` | `READY` | Automático en modo sombra (`SAMANTA_AUTO_SEND=false`): queda para revisión, igual que uno manual. | Sistema |
| `READY` | `READY` (`revision` + 1) | [Editar](#editar-un-borrador). | ADMIN u OPERATOR (no asignado a otra persona) |
| `READY` | `APPROVED` | [Aprobar](#aprobar-un-borrador-y-encolar-el-envío). | ADMIN u OPERATOR (no asignado a otra persona) |
| `READY` | `REJECTED` | [Rechazar](#rechazar-un-borrador). | ADMIN u OPERATOR (no asignado a otra persona) |
| `READY` | `STALE` | Al consultarlo o actuar: llegó otro mensaje que cuenta (cualquier `OUTBOUND`, o un `INBOUND` que no sea `OTHER`), Samanta está en pausa o venció `expiresAt`. Las reacciones, stickers y audios (`INBOUND` `OTHER`) no lo invalidan. Al editar o aprobar, además, si cambió la información comercial. | Sistema |

Los borradores manuales no cambian en segundo plano: el sistema los recalcula y guarda cuando alguien los consulta (lista o detalle) o actúa sobre ellos. Mientras tanto, un borrador que todavía dice `READY` ya no se puede usar si:

- en la página 1 del historial hay, con `sequence` mayor que `baselineSequence`, un `OUTBOUND` o un `INBOUND` que no sea `OTHER`;
- `isAssistantPaused` es `true`;
- o pasó `expiresAt`.

Los automáticos (`SCHEDULED` y `GENERATING`) los avanza un proceso en segundo plano del backend.

Errores de una acción no permitida:

| Situación | Error |
|---|---|
| `revision` distinta de la actual (se comprueba antes que el estado) | 409 `El borrador cambió; vuelve a revisarlo` |
| El borrador está `STALE` o `FAILED`, o queda así en esa llamada | 409 `Borrador desactualizado o fallido; genera uno nuevo` |
| Editar, aprobar o rechazar un borrador `GENERATING`, `APPROVED` o `REJECTED` (salvo repetir la misma aprobación o el mismo rechazo con el mismo usuario) | 409 `El borrador no está disponible para revisión` |
| OPERATOR sin ADMIN en una conversación asignada a otra persona | 403 `Conversación asignada a otro operador` |
| Samanta apagada (`SAMANTA_ENABLED` distinto de `true`), al generar, editar o aprobar | 503 `Samanta está desactivada` |

## Preguntas abiertas

Lo que el código no resuelve. Las respuestas dependen del equipo de backend o de producto.

1. **Adjuntos:** solo hay metadata (`externalMediaId`; `url` y `sizeBytes` llegan `null` desde WhatsApp) y no hay endpoint para descargar o previsualizar imágenes y documentos. ¿Está previsto un proxy de medios?
2. **Nombre del autor de los salientes:** solo llega `authorUserId`, y `GET /users` es solo para ADMIN. ¿Se agregará el nombre al mensaje, o un endpoint ligero de usuarios para OPERATOR y OWNER?
3. **Filtro «sin asignar»:** `assignedUserId` solo acepta un UUID. ¿Se necesita un filtro de conversaciones libres?
4. **Vencimiento de la ventana de 24 h:** no se expone (p. ej. un `windowExpiresAt`). El frontend lo estima con el último `INBOUND` cargado, que puede no estar en la página actual. ¿Se agregará a la conversación?
5. **Mensaje individual:** no existe `GET /conversations/:id/messages/:messageId`, útil para seguir el `outboundMessageId` de un borrador aprobado. ¿Se necesita?
6. **Tiempo real:** no hay WebSockets ni SSE, ni límite de peticiones en estas rutas. ¿Son aceptables para el backend los intervalos actuales de ft-crm (6 s la lista, 4 s el chat, 1,5 s con envíos pendientes y una consulta por fila para la vista previa) y los 2 o 3 s sugeridos para un borrador en `GENERATING`? ¿Se planea un canal en tiempo real?
7. **Vista previa del último mensaje:** la lista no la incluye y ft-crm hace una llamada por fila. ¿Se agregará a `GET /conversations`?
8. ~~**Samanta en Messenger:**~~ Resuelta el 8/11: Samanta atiende en `WHATSAPP`, `FACEBOOK` e `INSTAGRAM`, con borradores manuales y en modo automático.
9. **Recibos en Messenger e Instagram:** v1 ignora los eventos `read` de Messenger, así que un saliente de Messenger nunca pasa de `DELIVERED`. De Instagram no procesa ningún recibo (ni entrega ni lectura): sus salientes terminan en `SENT`. ¿Se procesarán?
10. **Mensajes `UNKNOWN`:** la API no permite resolverlos (marcarlos como enviados o no enviados) ni reintentarlos. ¿Se agregará algo para eso?
11. **Estado de las integraciones:** el frontend solo se entera de que WhatsApp, Messenger, Instagram o Samanta están apagados (o de que Instagram no tiene token de envío) por el 503 al intentar usarlos. ¿Se expondrá un endpoint de capacidades para ocultar esos botones de antemano?
12. **Cuota de Samanta:** el límite diario es global y no hay forma de consultar cuántas generaciones quedan. ¿Se expondrá?
13. **Nombre en WhatsApp:** bk-crm no guarda un nombre para los clientes nuevos de WhatsApp (el adaptador solo lee el teléfono). ¿Se tomará el nombre del perfil, como en Messenger?
14. **Búsqueda con dígitos:** cualquier dígito del texto activa la búsqueda por teléfono solo con esos dígitos («Mesa 4» encuentra todos los teléfonos con un 4). ¿Es el comportamiento deseado?

## Tipos TypeScript

Bloque autocontenido: compila con `tsc --strict` y repite los tipos compartidos (`Uuid`, `IsoDateTime`, `ContactChannel`, `Pagination`, `Paginated<T>`, `CustomerSummary`) con la misma definición que `ft-crm/src/lib/api/types.ts`. En el frontend, declara los compartidos una sola vez.

Qué cambia respecto de `src/lib/api/types.ts` de ft-crm:
- `ApiErrorBody` usa la forma ampliada de [05](05-implementacion-ft-crm.md#22-typests): `code` pasa a `BffErrorCode` y se añaden `path`, `method` y `timestamp`, opcionales.
- `Message.errorCode` pasa de `string | null` a `MessageErrorCode | null`, con los códigos que produce el backend.
- `Message.authorUserId`: el comentario «`null` = automático (Samanta)» es incorrecto. Un `OUTBOUND` siempre tiene autor: los que envió Samanta sola llevan `SAMANTA_USER_ID`, y los de un borrador aprobado, el de quien aprobó.
- Son nuevos del 8/11: `SAMANTA_USER_ID`, `AssistantPauseReason`, `SamantaDraftMode`, `Conversation.assistantPauseReason`, `Conversation.assistantPausedAt`, el estado `SCHEDULED`, los códigos `AI_QUOTA_EXCEEDED`, `AI_AUTH_FAILED`, `AI_MODEL_NOT_FOUND`, `AI_CONTEXT_UNAVAILABLE` y `AUTO_*`, y los campos `mode`, `availableAt` y `generationStartedAt` de `SamantaDraft`. `generationExpiresAt` admite `null`.
- Son nuevos del 9/11: `Message.templateName`, el código `WHATSAPP_TEMPLATE_EXPIRED` y los campos `button` e `interactive` de `WhatsAppWebhookPayload`.
- `SendMessageRequest.content` no tiene un único tope de 4096: es 4096 en WhatsApp, 2000 en Messenger y 1000 en Instagram, medido con `content.length` (`OUTBOUND_TEXT_MAX_LENGTH`). Instagram exige además ≤ 1000 bytes UTF-8 (`OUTBOUND_TEXT_MAX_BYTES`). `OUTBOUND_CONTENT_MAX_LENGTH` (4096) es solo el tope del DTO.
- Son nuevos `InternalErrorResponse`, `SendableChannel`, `SENDABLE_CHANNELS`, `OUTBOUND_TEXT_MAX_LENGTH`, `OUTBOUND_TEXT_MAX_BYTES`, `RESERVED_IDEMPOTENCY_PREFIX`, `IdempotencyHeaders`, los códigos de error de los mensajes y todos los tipos de Samanta y de los webhooks. `SENDABLE_CHANNELS` incluye `WHATSAPP`, `FACEBOOK` e `INSTAGRAM`. El ft-crm actual ya tiene los de envío: su `SENDABLE_CHANNELS` (`src/lib/api/types.ts`) incluye `INSTAGRAM` y tiene `OUTBOUND_TEXT_MAX_BYTES` desde el 8/11, sin commit.
- `ConversationCustomer`, `ConversationAssignedUser`, `Conversation`, `MessageAttachment`, `ListConversationsQuery`, `ListMessagesQuery`, `MarkConversationReadRequest`, `MarkConversationReadResponse`, `UpdateAssistantPauseRequest` y `AssignConversationRequest` no cambian de forma.

```ts
/* ==========================================================================
 * Bandeja: conversaciones, mensajes (WhatsApp, Messenger e Instagram),
 * borradores de Samanta y webhooks de Meta. Reflejan las respuestas de bk-crm
 * al 3/11/2026, con los cambios del 8/11 y del 9/11.
 * Fechas: string ISO 8601 en UTC ("2026-11-03T02:32:11.984Z").
 * ========================================================================== */

/* ----------------------------------------------------------------------------
 * Compartidos: misma definición que ft-crm/src/lib/api/types.ts, salvo
 * ApiErrorBody, que usa la forma ampliada del 05 (BffErrorCode y campos del 500).
 * -------------------------------------------------------------------------- */

export type Uuid = string;
export type IsoDateTime = string;

export const CONTACT_CHANNELS = ["WHATSAPP", "FACEBOOK", "INSTAGRAM", "WEBSITE", "PHONE", "EMAIL", "OTHER"] as const;
/** Canal de contacto. Messenger se representa como FACEBOOK. */
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  /** Math.ceil(total / limit); 0 cuando total = 0. */
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

/** Cuerpo de error: `message` es string[] en la validación de DTO y string en los demás casos. */
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  /** No viene en el 429 de Samanta, en el 500 ni en los errores que genera el BFF. */
  error?: string;
  /** Solo lo agrega el BFF de ft-crm. */
  code?: BffErrorCode;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  path?: string;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  method?: string;
  /** Solo en el 500 no controlado (ft-crm aún no lo declara). */
  timestamp?: IsoDateTime;
}

/** Error 500 no controlado de bk-crm: trae `path`, `method` y `timestamp` en lugar de `error`. */
export interface InternalErrorResponse {
  statusCode: 500;
  message: "Ocurrió un error interno";
  path: string;
  method: string;
  timestamp: IsoDateTime;
}

/** Cliente embebido en solicitudes, reservas y conversaciones. */
export interface CustomerSummary {
  id: Uuid;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
}

/* ----------------------------------------------------------------------------
 * Canales con envío, límites y cabecera de idempotencia
 * -------------------------------------------------------------------------- */

/** Canales en los que bk-crm puede enviar (tienen transporte registrado). */
export type SendableChannel = Extract<ContactChannel, "WHATSAPP" | "FACEBOOK" | "INSTAGRAM">;
export const SENDABLE_CHANNELS: readonly SendableChannel[] = ["WHATSAPP", "FACEBOOK", "INSTAGRAM"];

/** Máximo de `content.length` (unidades UTF-16, igual que String.length) por canal. */
export const OUTBOUND_TEXT_MAX_LENGTH: Readonly<Record<SendableChannel, number>> = {
  WHATSAPP: 4096,
  FACEBOOK: 2000,
  INSTAGRAM: 1000,
};

/** Tope en bytes UTF-8 (new TextEncoder().encode(texto).length): solo Instagram. Las tildes ocupan 2 y los emojis 4. */
export const OUTBOUND_TEXT_MAX_BYTES: Readonly<Partial<Record<SendableChannel, number>>> = {
  INSTAGRAM: 1000,
};

/** Tope del DTO de envío (cuenta cada emoji como 1). El límite real es OUTBOUND_TEXT_MAX_LENGTH. */
export const OUTBOUND_CONTENT_MAX_LENGTH = 4096;

/** Formato de Idempotency-Key en POST /messages y POST /assistant-drafts. */
export const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{16,80}$/;

/** Prefijo reservado: el backend usa "samanta-<draftId>" al aprobar un borrador. */
export const RESERVED_IDEMPOTENCY_PREFIX = "samanta-";

/** Cabecera obligatoria de los POST idempotentes del módulo. */
export interface IdempotencyHeaders {
  "Idempotency-Key": string;
}

/* ----------------------------------------------------------------------------
 * Mensajes
 * -------------------------------------------------------------------------- */

/** INBOUND = cliente → CRM; OUTBOUND = CRM → cliente. */
export type MessageDirection = "INBOUND" | "OUTBOUND";

/** Estados de un mensaje entrante (informativos: el contenido se muestra desde RECEIVED). */
export type InboundMessageStatus = "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED";

/** Estados de un mensaje saliente. Flujo normal: QUEUED → SENDING → SENT → DELIVERED → READ (Instagram termina en SENT). */
export type OutboundMessageStatus =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  /** Solo WhatsApp: Messenger nunca llega a READ, e Instagram nunca pasa de SENT (bk-crm no procesa sus recibos). */
  | "READ"
  /** Envío incierto: Meta pudo recibirlo. No se reenvía solo. */
  | "UNKNOWN"
  | "FAILED";

export type MessageStatus = InboundMessageStatus | OutboundMessageStatus;

/**
 * Los salientes siempre son TEXT, también las plantillas. IMAGE y FILE solo llegan por WhatsApp.
 * El toque de un botón de WhatsApp (plantilla o mensaje interactivo) llega como TEXT con el texto del botón.
 */
export type MessageType = "TEXT" | "IMAGE" | "FILE" | "OTHER";

/** Códigos de `Message.errorCode` en mensajes entrantes. */
export type InboundMessageErrorCode =
  /** RECEIVED (y el PROCESSING del reintento): fallo temporal, el worker reintenta solo. */
  | "MESSAGE_PROCESSING_TEMPORARY"
  /** FAILED: el mensaje no pasó la validación interna. */
  | "MESSAGE_INVALID"
  /** FAILED: se agotaron los 5 intentos de procesamiento. */
  | "MESSAGE_ATTEMPTS_EXHAUSTED";

/**
 * Códigos de `Message.errorCode` en mensajes salientes (prefijo WHATSAPP_, MESSENGER_ o INSTAGRAM_).
 * *_RATE_LIMITED aparece en QUEUED y también en el SENDING del reintento.
 * Instagram no tiene *_DELIVERY_FAILED: bk-crm no procesa sus recibos.
 */
export type OutboundMessageErrorCode =
  | "WHATSAPP_RATE_LIMITED"
  | "WHATSAPP_SEND_UNKNOWN"
  | "WHATSAPP_SEND_INVALID"
  | "WHATSAPP_WINDOW_CLOSED"
  | "WHATSAPP_SEND_REJECTED"
  | "WHATSAPP_DELIVERY_FAILED"
  /** FAILED: una plantilla pasó más de 6 h en cola sin poder enviarse (desde el 9/11). */
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

/** Metadata de un adjunto entrante. No hay endpoint para descargar el archivo. */
export interface MessageAttachment {
  id: Uuid;
  type: "IMAGE" | "FILE" | "OTHER";
  fileName: string | null;
  mimeType: string | null;
  /** null en los adjuntos de WhatsApp. */
  sizeBytes: number | null;
  /** Id del archivo en Meta. */
  externalMediaId: string | null;
  /** null en los adjuntos de WhatsApp. */
  url: string | null;
  createdAt: IsoDateTime;
}

/** Mensaje del historial; también la respuesta 202 de POST /conversations/:id/messages. */
export interface Message {
  id: Uuid;
  conversationId: Uuid;
  channel: ContactChannel;
  /** Correlativo por conversación (1, 2, 3…): orden real del chat y corte de lectura. */
  sequence: number;
  /** wamid (WhatsApp) o mid (Messenger e Instagram). En OUTBOUND es null hasta SENT. */
  externalMessageId: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  type: MessageType;
  /** null en IMAGE/FILE sin pie de foto. Entrantes: hasta 16 000 caracteres. En una plantilla, la versión del CRM del texto enviado. */
  content: string | null;
  /** Solo OUTBOUND de WhatsApp: plantilla aprobada en Meta con que se envió (p. ej. "solicitud_reserva_web"); null en los demás mensajes. */
  templateName: string | null;
  /**
   * INBOUND: siempre null. OUTBOUND: usuario que lo envió o que aprobó el borrador de Samanta.
   * Un OUTBOUND creado por la API nunca tiene autor null.
   */
  authorUserId: Uuid | null;
  /** INBOUND: hora del proveedor. OUTBOUND: null. */
  occurredAt: IsoDateTime | null;
  /** INBOUND: llegada a bk-crm. OUTBOUND: null. */
  receivedAt: IsoDateTime | null;
  /** INBOUND: fin del procesamiento interno. OUTBOUND: null. */
  processedAt: IsoDateTime | null;
  /** OUTBOUND: Meta aceptó el envío. INBOUND: null. */
  sentAt: IsoDateTime | null;
  /** OUTBOUND: recibo de entrega (WhatsApp y Messenger; en Instagram siempre null). INBOUND: null. */
  deliveredAt: IsoDateTime | null;
  /** OUTBOUND (solo WhatsApp): el cliente lo leyó. INBOUND: null. */
  providerReadAt: IsoDateTime | null;
  /** Momento del fallo (FAILED). */
  failedAt: IsoDateTime | null;
  /** INBOUND: leído por el equipo en el CRM. OUTBOUND: siempre null. */
  readAt: IsoDateTime | null;
  errorCode: MessageErrorCode | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Ordenados por id ascendente. Vacío en TEXT y en los salientes. */
  attachments: MessageAttachment[];
}

/* ----------------------------------------------------------------------------
 * Conversaciones
 * -------------------------------------------------------------------------- */

/** Cliente de la conversación. En Messenger e Instagram no hay phone ni email (no hacen falta para responder); el nombre puede faltar. */
export interface ConversationCustomer extends CustomerSummary {}

/** Responsable de la conversación. */
export interface ConversationAssignedUser {
  id: Uuid;
  firstName: string;
  lastName: string;
  isActive: boolean;
  /** true si está activo y tiene rol ADMIN u OPERATOR. false: conviene reasignar. */
  isEligible: boolean;
}

/**
 * Por qué Samanta está en pausa: MANUAL (PATCH /assistant), OPERATOR_REPLIED (un operador
 * escribió con el modo automático activo) o SAMANTA_HANDOFF (Samanta pasó la conversación a una persona).
 */
export type AssistantPauseReason = "MANUAL" | "OPERATOR_REPLIED" | "SAMANTA_HANDOFF";

/** Usuario de sistema que firma las respuestas automáticas de Samanta (inactivo; no aparece en GET /users). */
export const SAMANTA_USER_ID: Uuid = "00000000-0000-4000-8000-00000000a0a1";

/** Misma forma en el listado, el detalle y las respuestas de PATCH /assistant y /assignee. */
export interface Conversation {
  id: Uuid;
  customerId: Uuid;
  channel: ContactChannel;
  /** Samanta pausada: no responde sola ni se pueden generar o usar borradores. */
  isAssistantPaused: boolean;
  /** null si no está en pausa. */
  assistantPauseReason: AssistantPauseReason | null;
  /** Desde cuándo está en pausa; null si no lo está. */
  assistantPausedAt: IsoDateTime | null;
  assignedUserId: Uuid | null;
  /** Última actividad: llegada de un INBOUND o encolado de un OUTBOUND. Orden de la bandeja. */
  lastMessageAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  customer: ConversationCustomer;
  assignedUser: ConversationAssignedUser | null;
  /** INBOUND con readAt = null (lectura compartida por el equipo). */
  unreadCount: number;
}

/** Query de GET /conversations. Omite las claves vacías: un parámetro vacío o no declarado da 400. */
export interface ListConversationsQuery {
  /** Entero 1–1 000 000. Por defecto 1. */
  page?: number;
  /** Entero 1–100. Por defecto 50. */
  limit?: number;
  /** Un solo canal. */
  channel?: ContactChannel;
  customerId?: Uuid;
  /** Responsable. No hay filtro de "sin asignar". */
  assignedUserId?: Uuid;
  /** Viaja como "true"/"false". true = al menos un INBOUND sin leer; false no filtra. */
  unreadOnly?: boolean;
  /** Viaja como "true"/"false". */
  isAssistantPaused?: boolean;
  /** 1–200 caracteres tras trim. Nombre, apellido, email y teléfono del cliente; no busca en mensajes. */
  search?: string;
}

/** Query de GET /conversations/:id/messages (orden: sequence descendente). */
export interface ListMessagesQuery {
  /** Entero 1–1 000 000. Por defecto 1 (lo más reciente). */
  page?: number;
  /** Entero 1–100. Por defecto 50. */
  limit?: number;
}

/** Body de POST /conversations/:id/messages (+ IdempotencyHeaders). */
export interface SendMessageRequest {
  type: "TEXT";
  /** Al menos un carácter no blanco. content.length ≤ 4096 en WhatsApp, ≤ 2000 en Messenger y ≤ 1000 en Instagram, que además admite ≤ 1000 bytes UTF-8. */
  content: string;
}

/** Body de PATCH /conversations/:id/read. */
export interface MarkConversationReadRequest {
  /** Id de un mensaje de la conversación: el más reciente que el usuario vio. */
  throughMessageId: Uuid;
}

/** Respuesta de PATCH /conversations/:id/read. */
export interface MarkConversationReadResponse {
  /** INBOUND marcados en esta llamada (0 si ya estaban leídos). */
  updated: number;
  throughMessageId: Uuid;
}

/** Body de PATCH /conversations/:id/assistant. */
export interface UpdateAssistantPauseRequest {
  /** Booleano JSON real ("true" como texto da 400). */
  paused: boolean;
}

/** Body de PATCH /conversations/:id/assignee. */
export interface AssignConversationRequest {
  /** UUID de un usuario activo ADMIN u OPERATOR, o null para desasignar. Obligatorio. */
  assignedUserId: Uuid | null;
}

/* ----------------------------------------------------------------------------
 * Borradores de Samanta
 * -------------------------------------------------------------------------- */

/** APPROVED, REJECTED, STALE y FAILED son finales. SCHEDULED solo existe en los automáticos. */
export type SamantaDraftStatus = "SCHEDULED" | "GENERATING" | "READY" | "APPROVED" | "REJECTED" | "STALE" | "FAILED";

export const SAMANTA_DRAFT_FINAL_STATUSES: readonly SamantaDraftStatus[] = ["APPROVED", "REJECTED", "STALE", "FAILED"];

/** MANUAL: lo pidió una persona. AUTO: lo creó Samanta al llegar un mensaje del cliente. */
export type SamantaDraftMode = "MANUAL" | "AUTO";

/** Acciones que admite cada estado (todas exigen la `revision` actual). */
export const SAMANTA_DRAFT_ACTIONS: Readonly<Record<SamantaDraftStatus, readonly ("edit" | "approve" | "reject")[]>> = {
  SCHEDULED: [],
  GENERATING: [],
  READY: ["edit", "approve", "reject"],
  APPROVED: [],
  REJECTED: [],
  STALE: [],
  FAILED: [],
};

/** Intención que detecta la IA. */
export type SamantaIntent = "GENERAL" | "RESERVATION" | "CANCELLATION" | "HUMAN" | "OTHER";

/** Códigos de error de un borrador FAILED. Los AUTO_* y AI_CONTEXT_UNAVAILABLE solo aparecen en los automáticos. */
export type SamantaErrorCode =
  | "AI_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_AUTH_FAILED"
  | "AI_MODEL_NOT_FOUND"
  | "AI_REQUEST_REJECTED"
  | "AI_INVALID_RESPONSE"
  | "AI_INCOMPLETE_RESPONSE"
  | "AI_REFUSED_RESPONSE"
  | "AI_RESPONSE_TOO_LARGE"
  | "AI_UNAVAILABLE"
  | "AI_GENERATION_EXPIRED"
  | "AI_CONTEXT_UNAVAILABLE"
  | "AUTO_DAILY_LIMIT"
  | "AUTO_CONVERSATION_LIMIT"
  | "AUTO_CANNOT_REPLY"
  | "AUTO_SEND_REJECTED"
  | "AUTO_EXPIRED"
  | "AUTO_INTERNAL_ERROR";

/** Máximo de content.length de un borrador (texto de la IA y texto editado). */
export const SAMANTA_DRAFT_MAX_LENGTH = 4096;

/** Body de POST /conversations/:id/assistant-drafts (+ IdempotencyHeaders). */
export interface GenerateSamantaDraftRequest {
  /**
   * Id del último mensaje de texto del cliente: INBOUND, TEXT, no vacío, content.length ≤ 4096.
   * Después solo puede haber INBOUND de tipo OTHER (reacciones, stickers, audios).
   */
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
  /** Mensaje INBOUND de texto al que responde. */
  sourceMessageId: Uuid;
  /**
   * `sequence` de sourceMessageId. Si después llega un OUTBOUND o un INBOUND que no sea OTHER,
   * el borrador queda STALE.
   */
  baselineSequence: number;
  /** Clave Idempotency-Key usada al generar; "auto-<sourceMessageId>" en los automáticos. */
  idempotencyKey: string;
  /** Quien pidió la generación; SAMANTA_USER_ID en los automáticos. */
  createdById: Uuid;
  /** Quien aprobó o rechazó; SAMANTA_USER_ID si Samanta lo envió sola. */
  reviewedById: Uuid | null;
  /** Último usuario que editó el texto. */
  editedById: Uuid | null;
  status: SamantaDraftStatus;
  mode: SamantaDraftMode;
  /** Empieza en 1 y suma 1 con cada edición. Se envía en editar, aprobar y rechazar. */
  revision: number;
  /** Modelo de IA (SAMANTA_MODEL). */
  model: string;
  /** Versión del prompt: "samanta-v3" desde el 9/11; antes, "samanta-v2" (8/11) o "samanta-drafts-v1". */
  promptVersion: string;
  /** SHA-256 (hex) de la información comercial usada. */
  knowledgeHash: string;
  /**
   * Texto original de la IA. null mientras está GENERATING, si falló, o si quedó STALE durante
   * la generación por un mensaje nuevo, una pausa o el vencimiento (el texto se descarta).
   */
  originalContent: string | null;
  /** Texto actual (el editado, si se editó). null en los mismos casos que originalContent. */
  content: string | null;
  /** Se guarda con el texto de la IA: null en los mismos casos que originalContent. */
  intent: SamantaIntent | null;
  /** true por defecto; toma el valor de la IA solo si se guarda su texto. No se recalcula al editar. */
  requiresHuman: boolean;
  /** Datos que faltan, en texto libre (máx. 8 de hasta 80 caracteres). [] si no se guardó el texto. */
  missingFields: string[];
  /** null si OpenAI no cobró la llamada. Pueden venir en STALE o FAILED: se guardan aunque el texto se descarte. */
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: SamantaErrorCode | null;
  /** Automáticos: cuándo se responde (llegada + SAMANTA_AUTO_DELAY_MS). null en los manuales. */
  availableAt: IsoDateTime | null;
  /** Cuándo se llamó a la IA (cuenta para el límite diario). null si nunca se generó. */
  generationStartedAt: IsoDateTime | null;
  /** Límite de la generación (inicio + SAMANTA_TIMEOUT_MS + 10 s). Después pasa a FAILED. null en SCHEDULED. */
  generationExpiresAt: IsoDateTime | null;
  /** Creación + 15 min. Después pasa a STALE. */
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

/* ----------------------------------------------------------------------------
 * Webhooks de Meta (solo los llama Meta; el BFF los bloquea)
 * -------------------------------------------------------------------------- */

/** Query de GET /webhooks/whatsapp, GET /webhooks/messenger y GET /webhooks/instagram. */
export interface MetaWebhookVerifyQuery {
  "hub.mode": "subscribe";
  "hub.verify_token": string;
  "hub.challenge": string;
}

/** Respuesta 200 de POST /webhooks/whatsapp, POST /webhooks/messenger y POST /webhooks/instagram. */
export interface MetaWebhookAck {
  received: true;
}

/** Campos de un evento de WhatsApp Cloud API que lee bk-crm (el resto se ignora). */
export interface WhatsAppWebhookPayload {
  /** Solo se procesa "whatsapp_business_account". */
  object: string;
  entry?: Array<{
    /** Debe ser WHATSAPP_BUSINESS_ACCOUNT_ID. */
    id: string;
    changes?: Array<{
      /** Solo se procesa "messages". */
      field: string;
      value: {
        /** phone_number_id debe ser WHATSAPP_PHONE_NUMBER_ID. */
        metadata: { phone_number_id: string };
        messages?: Array<{
          /** Teléfono internacional sin "+" (7 a 15 dígitos). */
          from: string;
          id: string;
          /** Segundos Unix en texto. */
          timestamp: string;
          type: string;
          text?: { body: string };
          image?: { id: string; mime_type?: string; caption?: string };
          document?: { id: string; mime_type?: string; filename?: string; caption?: string };
          /** type "button": botón de respuesta rápida de una plantilla. Se guarda como TEXT con `text`. */
          button?: { text: string; payload?: string };
          /** type "interactive": botón o fila elegidos. Se guarda como TEXT con su `title`. */
          interactive?: {
            type: string;
            button_reply?: { id: string; title: string };
            list_reply?: { id: string; title: string; description?: string };
          };
        }>;
        statuses?: Array<{
          id: string;
          /** Solo se procesan sent, delivered, read y failed. */
          status: string;
          timestamp: string;
        }>;
      };
    }>;
  }>;
}

/** Campos de un evento de Messenger que lee bk-crm (el resto se ignora). */
export interface MessengerWebhookPayload {
  /** Solo se procesa "page". */
  object: string;
  entry?: Array<{
    /** Debe ser MESSENGER_PAGE_ID. */
    id: string;
    messaging?: Array<{
      /** PSID numérico del cliente. */
      sender: { id: string };
      /** Debe ser MESSENGER_PAGE_ID. */
      recipient: { id: string };
      /** Milisegundos Unix. */
      timestamp?: number;
      message?: {
        mid: string;
        text?: string;
        is_echo?: boolean;
        is_deleted?: boolean;
        is_unsupported?: boolean;
        attachments?: unknown[];
      };
      delivery?: { mids?: string[]; watermark?: number };
    }>;
  }>;
}
```
