# Demo de cierre — Sprint 2

Esta guía prepara evidencia manual; no afirma que Postman ya se haya ejecutado. Resultados automatizados y matriz completa: [informe de cierre](sprint-2-closure.md).

## Preparación

Usa un entorno de pruebas, no producción. Inicia la API con `npm run start:dev`. La configuración del restaurante y los usuarios de prueba deben existir. No borres datos para repetir la demo: usa nombres/correos distintos.

Variables: baseUrl=http://localhost:3000, accessToken, categoryId, itemId, customerId, requestId, reservationId, rescheduleId, cancelId, operatorId. Los IDs deben salir de respuestas reales, nunca de textos como UUID_DEL_PLATO.

Authorization → Bearer Token → `{{accessToken}}`. GET sin body; POST/PATCH con raw → JSON. No compartas capturas de tokens/contraseñas. Guarda respuestas y status con fecha.

## 1. Login ADMIN

`POST {{baseUrl}}/auth/login`

```json
{ "email": "CORREO_ADMIN_REAL", "password": "CONTRASEÑA_REAL" }
```

Esperado 201. En Post-response:

```javascript
pm.test('Login correcto', () => pm.response.to.have.status(201));
if (pm.response.code === 201) {
  pm.environment.set('accessToken', pm.response.json().accessToken);
}
```

Si hay 401 durante la demo, renueva el token o vuelve a iniciar sesión. No es un fallo de validación del body.

## 2. Categoría y catálogo

`POST {{baseUrl}}/commercial-categories` → 201:

```json
{ "nameEs": "Demo cierre Sprint 2", "displayOrder": 10 }
```

Guarda id como categoryId. `POST {{baseUrl}}/commercial-items` → 201:

```json
{
  "categoryId": "{{categoryId}}",
  "type": "DISH",
  "nameEs": "Trucha demo",
  "basePrice": "39.90",
  "images": [{ "url": "https://example.com/trucha.jpg", "isPrimary": true }],
  "faqs": [{ "questionEs": "¿Incluye guarnición?", "answerEs": "Consultar disponibilidad" }],
  "schedules": [{ "dayOfWeek": "MONDAY", "isAvailable": true, "startTime": "12:00", "endTime": "22:00" }]
}
```

Guarda id como itemId. Verifica DRAFT, isActive=true y precio string. Una URL de ejemplo valida el campo, no demuestra que exista una imagen alojada.

`PATCH {{baseUrl}}/commercial-items/{{itemId}}/approval` → 200:

```json
{ "approvalStatus": "APPROVED" }
```

Consulta:

```http
GET {{baseUrl}}/commercial-items?categoryId={{categoryId}}&type=DISH&approvalStatus=APPROVED&isActive=true&search=Trucha&page=1&limit=1
GET {{baseUrl}}/commercial-items/{{itemId}}
```

Para probar variantes, crea otro DISH/BEVERAGE sin basePrice y con `"variants":[{"nameEs":"Personal","price":"25.00"}]`. SERVICE, PROMOTION y EVENT están cubiertos en integración; sus detalles opcionales están descritos por los DTOs reales.

No edites contenido del ítem después de aprobar sin volver a aprobar: la edición lo devuelve a DRAFT.

## 3. Cliente e interés

`POST {{baseUrl}}/customers` → 201:

```json
{
  "firstName": "Carlos",
  "lastName": "Demo",
  "email": "carlos.demo.cierre@example.com",
  "sourceChannel": "PHONE"
}
```

Guarda id como customerId. Repetir el correo debe devolver 409; no hay normalizedEmail/normalizedPhone en la respuesta.

`POST {{baseUrl}}/customers/{{customerId}}/interests` → 200:

```json
{ "commercialItemId": "{{itemId}}" }
```

Repite: no duplica el interés. Comprueba detalle y filtros:

```http
GET {{baseUrl}}/customers/{{customerId}}
GET {{baseUrl}}/customers?commercialItemId={{itemId}}&channel=PHONE&search=Carlos&page=1&limit=20
```

El query es channel; sourceChannel se usa en el body.

## 4. Solicitud y reserva son registros distintos

Prepara una vez fechas futuras en Scripts → Pre-request de una petición de preparación; no dejes este script regenerando las fechas al consultar:

```javascript
const at = new Date(Date.now() + 7 * 86400000);
pm.environment.set('reservationAt', at.toISOString());
pm.environment.set('dateFrom', new Date(at.getTime() - 3600000).toISOString());
pm.environment.set('dateTo', new Date(at.getTime() + 3600000).toISOString());
pm.environment.set('newReservationAt', new Date(at.getTime() + 86400000).toISOString());
```

`POST {{baseUrl}}/reservation-requests` → 201, READY_TO_SEND:

```json
{
  "customerId": "{{customerId}}",
  "commercialItemId": "{{itemId}}",
  "sourceChannel": "PHONE",
  "reservationAt": "{{reservationAt}}",
  "numberOfPeople": 4,
  "quotedPrice": "159.60"
}
```

Guarda requestId. Consulta el calendario: ese ID no debe aparecer.

`POST {{baseUrl}}/reservations` → 201, CONFIRMED:

```json
{
  "customerId": "{{customerId}}",
  "commercialItemId": "{{itemId}}",
  "reservationAt": "{{reservationAt}}",
  "numberOfPeople": 4,
  "notes": "Reserva manual para demo"
}
```

Guarda reservationId. No envíes reservationRequestId: el endpoint manual no convierte solicitudes.

```http
GET {{baseUrl}}/reservations?dateFrom={{dateFrom}}&dateTo={{dateTo}}&customerId={{customerId}}
```

Debe contener reservationId, no requestId. Cancela la solicitud con `PATCH /reservation-requests/{{requestId}}/status`, body `{"status":"CANCELLED"}`. Sigue fuera del calendario.

REJECTED se prepara solo en los fixtures aislados automatizados; no inventes una API de rechazo ni cambies la BD real para la demo.

## 5. Responsable y observaciones

ADMIN obtiene operatorId de `GET /users`, eligiendo OPERATOR activo. `PATCH /reservations/{{reservationId}}/assignee` → 200:

```json
{ "assignedUserId": "{{operatorId}}" }
```

`POST /reservations/{{reservationId}}/notes` → 201:

```json
{ "content": "Cliente solicita mesa cerca de ventana" }
```

Repite con otra nota. `GET /reservations/{{reservationId}}` debe conservar ambas, con autor del JWT y orden estable. Enviar authorUserId en el body debe rechazarse (400).

## 6. Estados: usa una reserva independiente

No intentes completar, reprogramar y cancelar la misma reserva terminada.

Crea otra reserva con fecha unos minutos en el futuro. Espera a que llegue esa hora para `PATCH /reservations/:id/status`:

```json
{ "status": "IN_SERVICE" }
```

Luego `{"status":"COMPLETED"}` → 200. Antes de la hora, IN_SERVICE devuelve 409. Una transición desde COMPLETED hacia CANCELLED devuelve 409. Un estado inventado devuelve 400. No alteres el reloj ni las filas de la BD para forzarlo.

## 7. Reprogramar otra reserva

Usa reservationId del paso 4 si sigue CONFIRMED, o crea otra y guarda rescheduleId. `PATCH /reservations/{{rescheduleId}}/reschedule` → 200:

```json
{ "reservationAt": "{{newReservationAt}}", "reason": "Cliente solicita otro día" }
```

Comprueba RESCHEDULED y rescheduleHistory en el detalle. Ajusta el rango al nuevo día para encontrarla. Fecha pasada → 400.

## 8. Cancelación independiente

Crea otra reserva y guarda cancelId. `PATCH /reservations/{{cancelId}}/status` con `{"status":"CANCELLED"}` → 200.

```http
GET {{baseUrl}}/reservations/{{cancelId}}
GET {{baseUrl}}/reservations?customerId={{customerId}}&status=CANCELLED
GET {{baseUrl}}/reservations?customerId={{customerId}}&excludeCancelled=true
```

La fila sigue consultable y aparece por defecto, pero no con excludeCancelled=true. Los rangos de día/semana/mes son [inicio, fin), con zona explícita; recorre las páginas para ver todos los resultados.

## 9. Seguridad y regresiones

- Repite consultas con OWNER: 200; escrituras: 403.
- OPERATOR puede gestionar clientes/solicitudes y operar reservas; no crear reservas manuales ni editar catálogo: 403.
- SUPPORT: 403 en todos los endpoints Sprint 2. Sin token: 401.
- PATCH item con categoryId:null o displayOrder:null: 400. PATCH categoría displayOrder:null: 400. GET items?page=1e30: 400.
- GET /health: 200 con DB saludable. La caída 503 se prueba con mock, no apagando la BD compartida.
- Login/refresh/logout, usuarios y configuración: seguir flujos existentes. El logout invalida la sesión usada; emplea una sesión de prueba independiente.
- Recuperación real: usar un usuario y buzón de prueba bajo tu control. Un 200 de forgot-password es genérico y no acredita entrega; comprueba Resend y el buzón. No expongas la URL/token de reset en evidencias.

## Evidencia a guardar

Resultados de consola build/Prisma/tests; IDs creados; estados antes/después; 409 de duplicado; interés único; exclusión de Request; reserva en rango; notas y autoría; responsable; reprogramación y motivo; cancelada consultable; 401/403 por rol. Capturas de día/semana/mes corresponden a consultas API: no hay frontend de calendario en este alcance.

Guías complementarias: [clientes](customers-postman.md), [reservas](reservations-postman.md), [calendario](reservation-calendar-postman.md).
