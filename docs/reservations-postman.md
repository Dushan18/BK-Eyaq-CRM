# Solicitudes de reserva, reservas y calendario inicial

## Preparación

1. Inicia el backend: `npm run start:dev` (reinícialo si estaba abierto antes de regenerar Prisma).
2. Define `baseUrl = http://localhost:3000` en Postman.
3. Inicia sesión con el login existente y guarda el access token como `accessToken`.
4. En Authorization selecciona Bearer Token: `{{accessToken}}`.
5. Para POST/PATCH usa Body → raw → JSON. Para GET usa Body → none.
6. Obtén un `customerId` real desde `GET /customers`. No envíes un marcador literal ni el ID de un usuario administrativo.
7. Si usarás un elemento comercial, guarda su ID real como `itemId`. Debe estar activo y APPROVED. Es opcional: puedes omitir completamente `commercialItemId`.
8. Debe existir la configuración global del restaurante. Sin ella, crear solicitudes/reservas devuelve 409.

La migración de este bloque es `20260916055653_add_reservation_requests_and_reservations`. No reinicies la base ni ejecutes `migrate reset`. Para otra instalación, aplica las migraciones mediante el flujo normal del proyecto y ejecuta `npx prisma generate`.

## Permisos

| Operación | ADMIN | OPERATOR | OWNER | SUPPORT |
|---|---|---|---|---|
| Consultar solicitudes/reservas | Sí | Sí | Sí | No |
| Crear/editar/cancelar solicitudes | Sí | Sí | No | No |
| Crear reserva manual | Sí | No | No | No |
| Editar reserva/estado operativo | Sí | Sí | No | No |

Sin token válido: 401. Rol sin permiso: 403. La protección usa el JWT y la sesión existentes, no depende del frontend.

## Fechas de prueba

No reutilices una fecha de ejemplo que ya haya pasado. Para crear una variable futura, ejecuta una vez este código en Scripts → Pre-request de una petición de preparación:

```javascript
const at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
pm.environment.set('reservationAt', at.toISOString());
pm.environment.set('dateFrom', new Date(at.getTime() - 60 * 60 * 1000).toISOString());
pm.environment.set('dateTo', new Date(at.getTime() + 60 * 60 * 1000).toISOString());
```

Se aceptan instantes con segundos y zona explícita: `2026-09-20T19:00:00-05:00` o `2026-09-21T00:00:00Z`. No se aceptan fecha sola ni hora sin zona. Precisión máxima: milisegundos. Respuestas en UTC; el frontend presenta la fecha en `RestaurantConfig.timeZone`.

## 1. Crear solicitud incompleta

```http
POST {{baseUrl}}/reservation-requests
```

```json
{
  "customerId": "{{customerId}}",
  "sourceChannel": "PHONE",
  "comments": "Consulta por una reserva familiar"
}
```

Esperado: **201 Created**, `status: "INCOMPLETE_DATA"`, código generado `RES-año-número`, fecha y cantidad nulas. Guarda el ID devuelto como `requestId` (no confundir con customerId).

En Scripts → Post-response puedes guardar el ID automáticamente:

```javascript
if (pm.response.code === 201) {
  pm.environment.set('requestId', pm.response.json().id);
}
```

No envíes code ni status: los determina el backend.

## 2. Completar o crear una solicitud completa

```http
PATCH {{baseUrl}}/reservation-requests/{{requestId}}
```

```json
{
  "reservationAt": "{{reservationAt}}",
  "numberOfPeople": 4,
  "commercialItemId": "{{itemId}}",
  "quotedPrice": "150.00",
  "currency": "PEN",
  "specialRequirements": "Una silla para bebé"
}
```

Esperado: **200 OK**, `READY_TO_SEND`. Si no tienes itemId, elimina esa línea.

Para crear directamente una solicitud completa usa POST `/reservation-requests` con estos campos más customerId y sourceChannel. Devuelve 201.

Reglas:

- sourceChannel: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL u OTHER. No se hereda automáticamente del cliente.
- numberOfPeople debe ser un número entero ≥ 1, no texto. No se implementa capacidad del restaurante; el máximo técnico es el de INTEGER de PostgreSQL.
- quotedPrice es string, no número JSON. Admite de 0 a 99999999.99, como máximo dos decimales, sin notación exponencial ni redondeo silencioso.
- Monedas disponibles: PEN y USD. Si se introduce un precio sin moneda, usa la moneda del restaurante (en PATCH conserva la moneda anterior si ya había precio).
- El precio no se copia automáticamente del catálogo. Cambiar el catálogo o la configuración no modifica cotizaciones guardadas.
- Omitir un campo conserva su valor; null limpia campos opcionales. Vacío o solo espacios no equivale a null. Un PATCH vacío devuelve 400.
- Borrar fecha o cantidad vuelve la solicitud a INCOMPLETE_DATA. Borrar quotedPrice elimina también su moneda si no se envía currency.
- No se permite moneda sin precio ni borrar la moneda manteniendo el precio.
- Cambiar/asignar fecha exige que sea futura. Editar una nota histórica no rechaza la fecha anterior si no se envía de nuevo.
- Una relación comercial existente se conserva aunque luego se desactive. Asociar un elemento distinto exige que esté activo y aprobado.

## 3. Listar, buscar y consultar solicitudes

```http
GET {{baseUrl}}/reservation-requests
GET {{baseUrl}}/reservation-requests/{{requestId}}
GET {{baseUrl}}/reservation-requests?status=READY_TO_SEND
GET {{baseUrl}}/reservation-requests?customerId={{customerId}}
GET {{baseUrl}}/reservation-requests?commercialItemId={{itemId}}&channel=PHONE
GET {{baseUrl}}/reservation-requests?search=Carlos&page=1&limit=20
GET {{baseUrl}}/reservation-requests?dateFrom={{dateFrom}}&dateTo={{dateTo}}
```

Esperado: **200 OK**. Los filtros se combinan. search busca por código, nombre, apellido o teléfono del cliente. El rango filtra reservationAt, no createdAt; las solicitudes sin fecha no coinciden con un rango.

Listado: `data` y `pagination: { page, limit, total, totalPages }`. Límite predeterminado 20, máximo 100. Orden createdAt descendente y luego ID ascendente. Los conteos y filas se leen sin una transacción de snapshot: pueden variar si otra petición modifica datos simultáneamente.

## 4. Cancelar una solicitud

```http
PATCH {{baseUrl}}/reservation-requests/{{requestId}}/status
```

```json
{ "status": "CANCELLED" }
```

Esperado: **200 OK**. Repetir conserva el resultado sin cambiar updatedAt. Una solicitud cancelada no se puede editar ni reactivar: 409.

Este endpoint no permite READY_TO_SEND, INCOMPLETE_DATA, ACCEPTED, REJECTED ni otros estados futuros: 400. Los dos primeros se calculan, los de aprobación no están habilitados.

## 5. Crear reserva manual — solo ADMIN

```http
POST {{baseUrl}}/reservations
```

```json
{
  "customerId": "{{customerId}}",
  "commercialItemId": "{{itemId}}",
  "reservationAt": "{{reservationAt}}",
  "numberOfPeople": 4,
  "notes": "Reserva registrada manualmente por administración"
}
```

Esperado: **201 Created**, `CONFIRMED`, código `R-año-número`. Guarda el ID como `reservationId`. Puedes omitir commercialItemId y notes.

No envíes reservationRequestId, code ni status. Esta creación manual **no aprueba ni vincula una solicitud**. No admite fechas pasadas. La relación única con solicitudes queda preparada para un futuro flujo transaccional de aceptación.

## 6. Consultar calendario y detalle

```http
GET {{baseUrl}}/reservations
GET {{baseUrl}}/reservations/{{reservationId}}
GET {{baseUrl}}/reservations?dateFrom={{dateFrom}}&dateTo={{dateTo}}
GET {{baseUrl}}/reservations?status=CONFIRMED&customerId={{customerId}}&page=1&limit=20
```

Esperado: **200 OK**, únicamente reservas, ordenadas por reservationAt ascendente y luego ID. Mismo formato de paginación; recorre todas las páginas para mostrar el calendario completo.

Rango: `dateFrom <= reservationAt < dateTo`. Si se envían ambos límites, el inicio debe ser anterior al final. Se permite un único límite y también consultar fechas históricas.

Para un día en Lima, coloca en Params los límites con offset explícito, por ejemplo inicio `2026-09-20T00:00:00-05:00` y final `2026-09-21T00:00:00-05:00`. Para semana/mes usa el comienzo del período y el comienzo del siguiente. Si utilizas un offset positivo en una URL escrita manualmente, codifica `+` como `%2B`.

Sin filtro de estado también se incluyen reservas canceladas e históricas, identificadas por status. Una solicitud READY_TO_SEND o REJECTED nunca aparece aquí.

## 7. Editar/reprogramar una reserva

```http
PATCH {{baseUrl}}/reservations/{{reservationId}}
```

```json
{
  "reservationAt": "{{reservationAt}}",
  "numberOfPeople": 6,
  "notes": "Se amplió el grupo"
}
```

Esperado: **200 OK**, mismo código y estado CONFIRMED. Define una nueva fecha futura en la variable si deseas reprogramar. Solo se editan reservas CONFIRMED; no se borran fecha, cliente ni cantidad con null. Notas y elemento comercial sí admiten null. No hay historial de reprogramaciones en esta fase.

## 8. Estado operativo de la reserva

```http
PATCH {{baseUrl}}/reservations/{{reservationId}}/status
```

```json
{ "status": "CANCELLED" }
```

Esperado: **200 OK**. Para probar servicio usa otra reserva confirmada cuya hora ya haya llegado:

```json
{ "status": "IN_SERVICE" }
```

Después:

```json
{ "status": "COMPLETED" }
```

Transiciones: CONFIRMED → IN_SERVICE/CANCELLED/NO_SHOW; IN_SERVICE → COMPLETED. IN_SERVICE y NO_SHOW requieren que haya llegado la hora. Estados finales no se reactivan. Repetir el mismo estado habilitado es idempotente. UPCOMING y RESCHEDULED están reservados para el futuro y se rechazan con 400.

No cambies directamente la base habitual para simular fechas pasadas: la suite aislada ya cubre esos escenarios con fixtures.

## 9. Casos negativos y compatibilidad

- UUID mal formado → 400; recurso relacionado inexistente → 404.
- Item inactivo/no aprobado al asociarlo → 400.
- Fecha sin zona, pasada al crear/asignar, precio inválido o cantidad < 1 → 400.
- Transición no permitida, edición de cancelado o de reserva no confirmada → 409.
- OPERATOR crea solicitud pero no reserva manual → 201 / 403.
- OWNER consulta pero no modifica → 200 / 403; SUPPORT → 403; sin token → 401.
- No existen endpoints DELETE.
- Crear/editar solicitudes y reservas no altera Customer.status, firstContactAt, lastContactAt ni intereses.
- Las relaciones usan Restrict para proteger historial; desactivar un elemento comercial sigue permitido.
- Los códigos permiten saltos, no se reinician anualmente y no cambian al reprogramar. El año usa la fecha de creación en la zona del restaurante, no la fecha reservada.
- No se implementan disponibilidad, mesas, aprobación, WhatsApp, conversaciones, recordatorios ni auditoría funcional nueva.

## Pruebas automatizadas

```powershell
npx prisma validate
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand
```

La integración de reservas se habilita expresamente. Usa TEST_DATABASE_URL o DATABASE_URL como conexión administrativa a PostgreSQL local/de pruebas, con permiso para crear bases. Crea una base aleatoria `crm_reservations_test_*`, aplica todas las migraciones, prueba con usuarios y JWT reales y elimina únicamente esa base al terminar. No usa las tablas de tu base habitual ni envía correos.

```powershell
$env:RESERVATIONS_INTEGRATION = '1'
try {
  npm run test:e2e -- --runInBand --runTestsByPath test/reservations.integration.e2e-spec.ts
} finally {
  Remove-Item Env:RESERVATIONS_INTEGRATION -ErrorAction SilentlyContinue
}
```

No ejecutes estas pruebas contra un servidor de producción. Requieren la configuración de autenticación que ya usa la aplicación. La suite incluye login, refresh, logout, sesiones, RBAC real, solicitudes, reservas, restricciones SQL, carreras concurrentes y regresión de lectura de módulos anteriores.

Para incluir también la integración de clientes en una ejecución completa, habilita `CUSTOMERS_INTEGRATION=1` además de `RESERVATIONS_INTEGRATION=1`, ejecuta `npm run test:e2e -- --runInBand` y elimina ambas variables al terminar.
