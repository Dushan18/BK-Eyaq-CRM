# Mensajería central — Fase 1

Esta guía describe el núcleo y API de Fase 1; WhatsApp se añade en Fase 2 y no hay respuestas de IA. Actualización 13/10/2026: INBOUND/OUTBOUND y recuperación tras caída abrupta/reinicio de Redis aislado pasan integración, con Meta simulado. Ver [avance actual y límites](sprint-3-progress.md). Los resultados fechados en septiembre son históricos.

## Qué se implementó

- Conversation única por Customer+ContactChannel, bajo el supuesto de una cuenta receptora por canal.
- Message, MessageAttachment (metadata) y MessagingOutbox. Migración aditiva: `20260923060201_add_messaging_core`.
- Ingestión **interna** con validación en runtime, normalización existente y transacción compartida con CustomersService.
- Unicidad de mensaje por channel/externalMessageId en BD. Repetirlo devuelve el mismo ID; no vuelve a actualizar contacto/unread. Identidad incompatible: 409.
- INBOUND: RECEIVED → PROCESSING → PROCESSED; fallos definitivos/agotar intentos → FAILED. OUTBOUND está modelado, no hay envío ni proveedor configurado.
- Outbox persistente, dispatcher periódico, publicación con ID determinístico, worker con lease/token y contador durable de máximo cinco intentos.
- Recuperación de pendientes/PUBLISHED y leases vencidos; el outbox no se completa hasta que el mensaje se procesa. No se prometen ejecuciones únicas de jobs: sí efectos persistidos idempotentes.
- API de bandeja, historial, pausa, lectura compartida y asignación.

El diseño y las decisiones previas están en [messaging-core-design.md](messaging-core-design.md). Los modelos están aplicados; la aprobación del módulo completo sigue fuera de alcance.

## Configuración

En `.env`, no en código ni Git:

```dotenv
MESSAGING_ENABLED=false
REDIS_URL="redis://127.0.0.1:6379/0"
MESSAGING_QUEUE_PREFIX="eyaq-messaging"
```

`MESSAGING_ENABLED=false` es el valor predeterminado: API e ingestión conservan mensajes/outbox, pero **no ejecutan el procesamiento en background**. Usa `true` solo después de configurar Redis. No se instaló Redis, Docker ni WSL en tu equipo.

La conexión admite redis/rediss, usuario, contraseña y número de DB. No compartas la URL si contiene credenciales. Debe ser una conexión Redis compatible con BullMQ, no una API REST de Redis. Para producción se debe revisar persistencia/evicción, acceso de red y límites con el proveedor elegido.

Con workers habilitados, una caída de Redis no impide guardar la ingestión en PostgreSQL: la publicación se reintenta con espera acotada. Hay advertencias técnicas de mensajes pendientes antiguos. El procesamiento tiene cinco intentos; FAILED no se reactiva automáticamente. No hay endpoint público de reintento.

La pausa del asistente **no detiene la persistencia ni el procesamiento básico del mensaje**. Es un estado preparado para la futura integración de IA.

## Preparar datos de demo local sin webhook público

La ingestión no tiene endpoint HTTP de testing. Usa el script solo en PostgreSQL local de desarrollo:

```powershell
$env:ALLOW_MESSAGING_DEMO = 'true'
npx tsx scripts/seed-messaging-demo.ts
Remove-Item Env:ALLOW_MESSAGING_DEMO
npm run start:dev
```

El script crea/reutiliza un cliente ficticio con email `messaging.demo@example.com`, una conversación WHATSAPP y dos mensajes. No envía WhatsApp ni correos. No borra datos. Imprime solo IDs y si eran duplicados; conserva esos IDs. Repetirlo no duplica registros ni vuelve a marcarlos no leídos. El script rechaza producción/bases remotas y apaga sus workers mientras prepara la demo.

El script **no se ejecutó automáticamente contra tus datos**. No introduzcas contactos reales para esta prueba.

## Postman

Variables: baseUrl=`http://localhost:3000`, accessToken, conversationId, messageId, operatorId.

Inicia sesión mediante `POST /auth/login` con un usuario real. Guarda accessToken. Authorization → Bearer Token → `{{accessToken}}`. GET sin body; PATCH raw → JSON. Usa los IDs impresos por la demo o devueltos por la API.

### 1. Listar conversaciones

```http
GET {{baseUrl}}/conversations
GET {{baseUrl}}/conversations?channel=WHATSAPP&unreadOnly=true&page=1&limit=20
GET {{baseUrl}}/conversations?search=Demo&isAssistantPaused=false
GET {{baseUrl}}/conversations?assignedUserId={{operatorId}}
```

Esperado 200: `{ data: [...], pagination: { page, limit, total, totalPages } }`.

Filtros combinables: channel, customerId, assignedUserId, unreadOnly, isAssistantPaused y search. search consulta nombres/teléfono/email del cliente, no todo el texto del historial. unreadOnly=false no restringe por lectura. Default limit=50, máximo 100; page máximo 1 000 000.

Orden: lastMessageAt descendente, null al final, id descendente para desempatar. Las fechas representan recepción del servidor; occurredAt conserva fecha del proveedor sin alterar ese orden.

### 2. Detalle e historial

```http
GET {{baseUrl}}/conversations/{{conversationId}}
GET {{baseUrl}}/conversations/{{conversationId}}/messages?page=1&limit=50
```

Esperado 200. Detalle: cliente, responsable seguro, pausa, fecha y unreadCount; nunca historial ilimitado. Mensajes: paginados, sequence descendente. Cada mensaje contiene readAt y metadata de adjuntos, sin tokens internos de procesamiento.

No se marcan mensajes leídos por consultar GET. Conversación inexistente: 404. UUID inválido: 400.

### 3. Marcar leído hasta un mensaje visto

`PATCH {{baseUrl}}/conversations/{{conversationId}}/read`

```json
{ "throughMessageId": "{{messageId}}" }
```

Usa el mensaje de mayor sequence que realmente mostraste al operador. Esperado 200 con updated y throughMessageId. Solo afecta INBOUND no leídos hasta ese corte. Repetir devuelve updated=0; un mensaje posterior sigue no leído. Mensaje de otra conversación: 404. Body vacío: 400.

La lectura es compartida entre todo el equipo, **no por usuario** y no representa el READ de WhatsApp. OUTBOUND nunca cuenta como no leído.

### 4. Pausar/reanudar asistente

`PATCH {{baseUrl}}/conversations/{{conversationId}}/assistant`

```json
{ "paused": true }
```

Esperado 200; repite con false para reanudar. No dispara IA. No cambia assignedUserId. Un string `"false"` no es un boolean válido en el body.

### 5. Asignar/desasignar

ADMIN obtiene operatorId de `GET /users`. Debe ser ADMIN/OPERATOR activo.

`PATCH {{baseUrl}}/conversations/{{conversationId}}/assignee`

```json
{ "assignedUserId": "{{operatorId}}" }
```

Esperado 200. Para desasignar envía `{"assignedUserId":null}`. Omitir el campo no desasigna: 400.

- ADMIN puede asignar/reemplazar/desasignar.
- OPERATOR solo puede tomar una conversación libre con su propio ID, conservarla o desasignarse. No puede transferir a otros ni quitar al responsable ajeno: 403.
- Usuario inexistente: 404. Inactivo, OWNER o SUPPORT como responsable: 400.
- Desactivar posteriormente al responsable conserva la relación y muestra isEligible=false.
- Asignar no cambia la pausa del asistente ni limita la lectura/operación exclusivamente al asignado.

## Matriz RBAC

| Rutas | ADMIN | OWNER | OPERATOR | SUPPORT |
| --- | --- | --- | --- | --- |
| GET /conversations, /:id, /:id/messages | Sí | Sí | Sí | No |
| PATCH /:id/read, /:id/assistant | Sí | No | Sí | No |
| PATCH /:id/assignee | Sí | No | Solo regla propia | No |

Sin JWT válido: 401. Rol excluido: 403. Todos los permisos se comprueban en backend con los guards actuales. No hay DELETE físico, envío, webhook público ni endpoint de IA.

## Pruebas automatizadas

```powershell
npx prisma validate
npm run build
npm test -- --runInBand
$env:MESSAGING_ENABLED = 'false'
$env:CUSTOMERS_INTEGRATION = '1'
$env:RESERVATIONS_INTEGRATION = '1'
npm run test:e2e -- --runInBand
```

Los casos de mensajería reutilizan la base temporal y JWT reales de la suite de reservas. Se eliminan únicamente las bases temporales de las suites al terminar. No usar producción.

Prueba Redis real, ejecutada satisfactoriamente el 13/10/2026 (ver informe de avance):

```powershell
$env:MESSAGING_ENABLED = 'false'
$env:RESERVATIONS_INTEGRATION = '1'
$env:MESSAGING_REDIS_INTEGRATION = '1'
# Configura TEST_REDIS_URL de forma privada antes de ejecutar.
npm run test:e2e -- --runInBand --testPathPatterns=reservations.integration --testNamePattern="Mensajería"
```

El caso real crea su worker explícitamente con un prefijo aleatorio propio, comprueba el procesamiento y el payload, y elimina exclusivamente su cola. No usa FLUSHALL. Mantener MESSAGING_ENABLED=false evita iniciar además los workers normales de la aplicación durante las pruebas.

Cobertura actual: validación, diez ingestiones concurrentes, rollback, contactos/fechas, adjuntos, RBAC, filtros, lectura concurrente, worker repetido, leases/fencing, error terminal, cinco intentos persistidos, outbox ante caída simulada, dispatcher reiniciado y restricciones SQL. Las pruebas con Redis real y caída/reinicio de un broker aislado pasaron el 13/10/2026. Activar MESSAGING_REDIS_RESTART_INTEGRATION=1 para la prueba Docker adicional; ver sus requisitos y límites en el informe de avance.

## Registro histórico de entrega (23/09/2026)

Los pendientes y cifras siguientes corresponden a esa fecha; para el estado vigente consultar [avance al 13/10/2026](sprint-3-progress.md).

Validación ejecutada el 23/09/2026: build y prisma validate correctos; **373 pruebas unitarias** (31 suites) y **161 de integración** (3 suites) aprobadas. Hay **1 prueba omitida**, la de Redis real, por infraestructura no disponible. De integración, 22 casos nuevos son de mensajería con PostgreSQL/JWT y broker simulado donde corresponde. El lint de los archivos nuevos/cambiados de mensajería pasa.

- Persistencia y API implementadas; BullMQ/dispatcher implementados pero Redis real no verificado aquí.
- Ocho migraciones aplicadas, incluida add_messaging_core; no se ejecutó reset.
- No se actualizó Prisma ni se modificaron contratos HTTP de módulos anteriores.
- Auditoría funcional: TODOs; solo logs técnicos seguros. No se guardan errores crudos ni payloads completos en fallos.
- BullMQ 5.81.5 fijado en package.json. npm audit informó 14 vulnerabilidades en el árbol completo (12 altas, 2 moderadas, ninguna crítica); BullMQ no apareció en la lista de paquetes afectados. Entre los paquetes directos afectados figuran NestJS y Prisma. No se ejecutó audit fix: su actualización requiere un trabajo de compatibilidad separado.
- El lint previo del proyecto sigue siendo deuda separada; los archivos nuevos se validan sin desactivar reglas.
- Fase 1 **no cerrada** hasta configurar/verificar Redis real y completar la evidencia de recuperación. Módulo 6 completo y WhatsApp son fases posteriores.
