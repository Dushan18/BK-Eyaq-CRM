# Calendario operativo — responsable, observaciones y reprogramación

Esta ampliación usa los módulos existentes. No agrega CalendarModule ni consulta ReservationRequest para construir el calendario. Para crear reservas y obtener JWT, sigue primero [la guía de reservas](reservations-postman.md).

## Preparación

- Reinicia `npm run start:dev` después de generar Prisma Client.
- Configura baseUrl (`http://localhost:3000`), accessToken, reservationId y operatorId con valores reales.
- Authorization → Bearer Token → `{{accessToken}}`. POST/PATCH con Body → raw → JSON; GET sin body.
- ADMIN obtiene operatorId de `GET /users`; OPERATOR obtiene su propio ID de `GET /auth/me`.
- En otra instalación aplica las migraciones pendientes por el flujo normal del proyecto. La nueva migración es `20260922052135_extend_reservation_calendar`; nunca uses `migrate reset` para actualizar.

## 1. Consultar calendario y detalle

```http
GET {{baseUrl}}/reservations?dateFrom={{dateFrom}}&dateTo={{dateTo}}
GET {{baseUrl}}/reservations?assignedUserId={{operatorId}}&excludeCancelled=true
GET {{baseUrl}}/reservations?commercialItemId={{itemId}}&status=CONFIRMED
GET {{baseUrl}}/reservations?search=Carlos&page=1&limit=20
GET {{baseUrl}}/reservations/{{reservationId}}
```

Esperado: 200. Todos los filtros son combinables; search busca código, nombre, apellido y teléfono. Las canceladas se mantienen por defecto. `excludeCancelled=true` las excluye; combinarlo con `status=CANCELLED` devuelve 400. `excludeCancelled=false` no las oculta.

El calendario conserva paginación (máximo 100 por página), orden reservationAt ASC/id ASC y rango `dateFrom <= reservationAt < dateTo`. Ambos límites iguales o invertidos devuelven 400. Día, semana, mes y lista usan el mismo endpoint. Para ver todo un período recorre todas las páginas. ISO exige segundos y zona explícita; el frontend presenta UTC en la zona del restaurante.

El detalle añade:

```json
{
  "notes": "Texto general anterior",
  "assignedUserId": null,
  "assignedUser": null,
  "noteHistory": [],
  "rescheduleHistory": []
}
```

Con responsable, assignedUser incluye id, firstName, lastName, isActive e isEligible. isEligible indica si actualmente está activo y tiene ADMIN u OPERATOR. No se devuelven hashes, sesiones, teléfonos normalizados ni roles internos del responsable. El listado no carga noteHistory/rescheduleHistory; solo el detalle. Los historiales se ordenan por createdAt ASC/id ASC; en esta versión no se paginan individualmente.

## 2. Asignar responsable

```http
PATCH {{baseUrl}}/reservations/{{reservationId}}/assignee
```

```json
{ "assignedUserId": "{{operatorId}}" }
```

Esperado: 200. El responsable debe existir, estar activo y tener OPERATOR o ADMIN. Inexistente: 404; inactivo o rol no válido: 400. Un body vacío no desasigna: devuelve 400.

Para desasignar:

```json
{ "assignedUserId": null }
```

Permisos:

- ADMIN asigna/reemplaza/desasigna cualquier responsable válido.
- OPERATOR puede tomar una reserva libre, conservar su propia asignación y desasignarse.
- OPERATOR no puede asignar a otro usuario ni quitar/reemplazar a otro responsable: 403.
- Si el usuario tiene ambos roles, prevalece ADMIN.
- No se modifica asignación de COMPLETED, CANCELLED o NO_SHOW: 409. Sí se permite en IN_SERVICE.
- La asignación no limita otras acciones a ese responsable; ADMIN y OPERATOR siguen pudiendo operar las reservas.

Desactivar al responsable o quitarle el rol conserva la relación histórica, pero el detalle indicará isEligible=false. ADMIN puede reemplazarlo si la reserva no terminó. Eliminar físicamente un usuario sin historial de autoría deja la asignación en null; los autores de notas/reprogramaciones están protegidos con Restrict. No se agregan endpoints de eliminación.

## 3. Añadir observación con autor

```http
POST {{baseUrl}}/reservations/{{reservationId}}/notes
```

```json
{ "content": "Cliente solicita mesa cerca de ventana" }
```

Esperado: 201. La respuesta contiene id, reservationId, authorUserId, content, createdAt y author (id/nombres). El autor se obtiene del JWT y la sesión vigentes. Enviar authorUserId en el body devuelve 400.

Contenido obligatorio, trim y máximo 5000 caracteres; vacío/null no válido. Repetir POST crea otra observación: no es una operación idempotente. Se pueden añadir notas a reservas finalizadas. No hay edición ni borrado de observaciones.

Consulta el detalle y verifica noteHistory. El campo notes antiguo continúa siendo texto general editable mediante el PATCH existente cuando el estado lo permite. No se transforma automáticamente en historial ni se inventa su autor.

## 4. Reprogramar con motivo

Prepara una fecha futura en Postman, por ejemplo en Scripts → Pre-request:

```javascript
pm.environment.set('newReservationAt', new Date(Date.now() + 14 * 86400000).toISOString());
```

Ejecuta ese script una vez y desactívalo si quieres repetir exactamente la misma fecha para probar idempotencia.

```http
PATCH {{baseUrl}}/reservations/{{reservationId}}/reschedule
```

```json
{
  "reservationAt": "{{newReservationAt}}",
  "reason": "Cliente solicitó cambio de horario"
}
```

Esperado: 200, mismo código, nueva fecha y estado RESCHEDULED. Se permite desde CONFIRMED, UPCOMING y RESCHEDULED; otros estados devuelven 409. Fecha pasada/sin zona devuelve 400.

El detalle contiene rescheduleHistory con fecha anterior, nueva, motivo, changedByUserId, createdAt y changedBy (id/nombres). reason es opcional o null, trim y máximo 5000 caracteres; texto vacío se rechaza. El actor no se acepta en el body.

Cambio de fecha, estado e historial se confirman juntos. Repetir el mismo instante futuro no agrega historial ni modifica updatedAt mediante este endpoint. Un offset distinto que representa el mismo instante tampoco agrega historial.

El PATCH anterior `/reservations/:id` sigue aceptando reservationAt, pero utiliza la misma lógica y registra historia con motivo null. Esto cambia explícitamente su comportamiento anterior: una fecha distinta ahora produce RESCHEDULED. Omitir la fecha al editar otros datos mantiene el estado. Si reenvías el mismo instante en un PATCH general no se agrega historial, aunque la edición general puede actualizar updatedAt.

## 5. Estados operativos

```http
PATCH {{baseUrl}}/reservations/{{reservationId}}/status
```

Body según la acción:

```json
{ "status": "UPCOMING" }
```

```json
{ "status": "IN_SERVICE" }
```

```json
{ "status": "COMPLETED" }
```

```json
{ "status": "NO_SHOW" }
```

```json
{ "status": "CANCELLED" }
```

No envíes todos estos ejemplos seguidos a una única reserva. Crea reservas separadas para probar cancelación y ausencia.

| Estado actual | Destinos de /status |
|---|---|
| CONFIRMED | UPCOMING, IN_SERVICE, CANCELLED, NO_SHOW |
| UPCOMING | IN_SERVICE, CANCELLED, NO_SHOW |
| RESCHEDULED | CONFIRMED, UPCOMING, IN_SERVICE, CANCELLED, NO_SHOW |
| IN_SERVICE | COMPLETED |
| COMPLETED, CANCELLED, NO_SHOW | Ninguno |

IN_SERVICE/NO_SHOW requieren que haya llegado la hora reservada; si no, 409. No se inventa un tiempo de tolerancia. UPCOMING es manual, sin cron ni ventana temporal. RESCHEDULED no se acepta como destino de /status (400): lo genera una reprogramación real. Repetir un estado permitido ya vigente es idempotente. Transición incompatible: 409; enum inválido: 400. Cancelar conserva la reserva; filtra `status=CANCELLED` para verla.

## 6. Permisos, concurrencia y límites

ADMIN/OPERATOR ejecutan las nuevas acciones. OWNER solo consulta. SUPPORT no accede. Sin token válido: 401; rol incorrecto: 403. La creación manual original continúa siendo ADMIN-only.

Las escrituras reutilizan transacciones serializables y reintentos limitados. En una carrera de autoasignación solo un operador puede tomar la reserva. Dos reprogramaciones válidas pueden sucederse: se conservan ambas en el historial y la última prevalece. No hay control de versión enviado por el frontend: esto no detecta una pantalla antigua. Si se agotan los reintentos se devuelve 409.

No se reconstruyen cambios previos a esta migración ni se implementa auditoría general de estados/asignaciones. Quedan TODO para eventos de auditoría. No incluye disponibilidad, mesas, frontend, WhatsApp, cron, recordatorios, Google Calendar ni cambios en ReservationRequest.

## 7. Pruebas

Ejecuta las unitarias con `npm test -- --runInBand` y el build con `npm run build`. La integración real de calendario se incorpora a `test/reservations.integration.e2e-spec.ts`, reutilizando la base temporal, login y JWT reales. Comando y precauciones en [la guía original](reservations-postman.md#pruebas-automatizadas).

Casos manuales recomendados: asignar/desasignar; intentar reemplazar otro responsable como OPERATOR; falsificar autor; añadir nota a cancelada; reprogramar desde ambos endpoints; repetir fecha; verificar historia y notes original; filtros combinados; OWNER/SUPPORT; cancelar sin borrar; comprobar que una solicitud READY_TO_SEND no aparece en calendario.
