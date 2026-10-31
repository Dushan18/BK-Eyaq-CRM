# Samanta v1 — borradores revisados por un operador

Implementación del 30/10/2026. Esta etapa es de **backend**, con WhatsApp de prueba.
No activa respuestas automáticas, no crea/modifica reservas y no incluye todavía
Messenger, Instagram ni la interfaz del mockup.

## Qué hace

Un ADMIN u OPERATOR solicita un borrador para el último mensaje entrante de texto.
Samanta usa un máximo de 10 mensajes de esa conversación, configuración pública
del restaurante y hasta 30 elementos activos/aprobados de categorías activas.
Variantes y FAQ están limitadas a 10 por elemento. El catálogo se identifica como
parcial y no representa disponibilidad de mesas. No se incluyen el perfil del
cliente, teléfonos de contacto, notas internas ni datos de otras conversaciones.
El texto libre del historial **puede contener datos personales escritos por el
cliente**: revisar la política de privacidad antes de activar la API.

El resultado queda guardado con modelo, versión del prompt, texto original,
texto editable, intención, campos faltantes y uso de tokens cuando está disponible.
El operador puede editar, rechazar o aprobar. **Solo aprobar encola un mensaje**
en el flujo WhatsApp existente. `APPROVED` no significa `DELIVERED`: consultar el
mensaje `outboundMessageId` para ver el estado de entrega.

La integración usa Responses con salida JSON estricta, `store:false`, sin
herramientas y sin reintentos de red automáticos. La salida estructurada no
garantiza exactitud comercial: la revisión humana sigue siendo obligatoria.
`store:false` no debe interpretarse como garantía de retención cero de todos los
datos por el proveedor.

## Activación pendiente, no realizada automáticamente

1. Revisar y respaldar la base de datos. La migración aditiva
   `20261030000000_samanta_drafts` se probó sobre una base temporal; **no se aplicó
   a la base del CRM durante la implementación**. Con la conexión correcta y tras
   revisar las demás migraciones pendientes, aplicar:

   ```powershell
   npx prisma migrate status
   npx prisma migrate deploy
   npx prisma generate
   ```

2. Configurar exclusivamente en el servidor (no en Postman/frontend ni en Git):

   ```dotenv
   SAMANTA_ENABLED=true
   OPENAI_API_KEY=tu_clave_privada
   SAMANTA_MODEL=gpt-6-luna
   SAMANTA_DAILY_LIMIT=100
   SAMANTA_CONCURRENT_LIMIT=2
   SAMANTA_TIMEOUT_MS=20000
   SAMANTA_MAX_OUTPUT_TOKENS=1024
   ```

   La clave y facturación de API son independientes del JWT del CRM. No compartir
   la clave en capturas o chats. El modelo es configurable: confirmar acceso en
   la cuenta antes de probar. Al cambiarlo, verificar compatibilidad con Responses,
   JSON estricto y `reasoning.effort=low`. Reiniciar el backend tras cambiar variables.

3. Para **enviar** una aprobación deben seguir activos WhatsApp, Redis y los
   workers de mensajería. Generar un borrador no necesita enviar a Meta.
   Con `SAMANTA_ENABLED=false` se bloquean generación, edición y aprobación;
   consultar/rechazar borradores existentes sigue disponible una vez migrada la BD.

## Postman

Todas las rutas usan `Authorization: Bearer <JWT_DEL_CRM>`, no el token de Meta
ni la clave de OpenAI. Bodies JSON con `Content-Type: application/json`.
Usar el ID real de una conversación WhatsApp y el de su último mensaje entrante.

### 1. Generar — POST

```text
http://localhost:3000/conversations/{{conversationId}}/assistant-drafts
Idempotency-Key: samanta-prueba-0001
```

```json
{ "sourceMessageId": "UUID_DEL_ULTIMO_MENSAJE_ENTRANTE" }
```

Respuesta 201 con `id`, `status`, `revision`, `content`, `requiresHuman`, etc.
No hay envío. Repetir **la misma clave y datos** devuelve el mismo borrador,
incluso si falló, sin otra llamada a la IA. Otra clave representa una nueva
generación y puede consumir API. Un reintento concurrente puede ver `GENERATING`.

### 2. Consultar — GET

```text
/conversations/{{conversationId}}/assistant-drafts
/conversations/{{conversationId}}/assistant-drafts/{{draftId}}
```

La lista devuelve los últimos 50, más recientes primero. OWNER puede consultar,
pero no generar, editar ni aprobar. Un OPERATOR no puede modificar los borradores
de una conversación asignada a otro usuario; ADMIN puede hacerlo.

### 3. Editar — PATCH

```text
/conversations/{{conversationId}}/assistant-drafts/{{draftId}}
```

```json
{ "revision": 1, "content": "Hola, ¿para qué fecha y cuántas personas deseas reservar?" }
```

La respuesta incrementa `revision`. Revisar el texto completo antes de aprobar.
`requiresHuman` e `intent` reflejan el análisis original, no una nueva evaluación
de la edición. El contenido generado se conserva en `originalContent`.

### 4. Aprobar — POST

```text
/conversations/{{conversationId}}/assistant-drafts/{{draftId}}/approve
```

```json
{ "revision": 2 }
```

Usar la revisión **actual**. Respuesta 202, estado `APPROVED`, `outboundMessageId`.
Esta acción sí autoriza el envío al cliente. Aprobación y creación del mensaje/
outbox son atómicas; repetir la aprobación por el mismo operador no duplica el
mensaje. Si el worker falla, revisar el mensaje; no reenviar a ciegas.

### 5. Rechazar — POST

```text
/conversations/{{conversationId}}/assistant-drafts/{{draftId}}/reject
```

```json
{ "revision": 1 }
```

Devuelve 200 con `REJECTED`; no envía nada.

## Protecciones y errores esperados

- 400: UUID, body, clave o contenido inválidos. Contenido máximo 4096 caracteres.
- 401/403: falta sesión, rol o permiso sobre la asignación.
- 409: pausa, revisión antigua, fuente no vigente, ventana WhatsApp cerrada,
  contexto demasiado grande o borrador no revisable.
- 429: límite diario o de llamadas simultáneas alcanzado.
- 503: Samanta desactivada.
- `FAILED` en un borrador: error normalizado del proveedor (`AI_TIMEOUT`,
  `AI_RATE_LIMITED`, `AI_REQUEST_REJECTED`, etc.); no se exponen cuerpos de error
  del proveedor. Puede devolverse con HTTP 201 porque el borrador sí fue creado.
- `STALE`: otro mensaje entrante/saliente, pausa, vencimiento o cambio de
  información comercial detectado. Generar y revisar uno nuevo. Los borradores
  duran 15 minutos; la vigencia de catálogo/políticas se comprueba al terminar
  la generación y al editar/aprobar. Consultar no verifica cambios de catálogo.
- Una generación abandonada expira al consultarla/reintentar; no se repite
  automáticamente porque la llamada anterior pudo haber consumido tokens.

El límite diario cuenta **intentos persistidos globales por día UTC**, incluidos
fallos. No es un límite monetario garantizado ni cuota por operador. El contexto
se limita a 48 KB UTF-8 (32 KB de conocimiento comercial) y la salida a los tokens
configurados. Configurar alertas/límites de gasto en la cuenta del proveedor.
En errores o respuestas incompletas el consumo puede no estar disponible.

## Verificación y límites del alcance

Las pruebas usan proveedor de IA simulado; no consumen OpenAI ni mandan WhatsApp
reales. Cubren JSON inválido, rechazo, timeout, límites, pausa, borradores antiguos,
roles, edición, atomicidad e idempotencia. La migración se ejecuta únicamente en
una base temporal de integración.

Antes de habilitarla para clientes: evaluar al menos 50 conversaciones representativas
del restaurante (precios, fechas, cambios, alergias, intentos de manipular instrucciones),
medir exactitud/latencia/consumo y ajustar el prompt. Esas evaluaciones con el
modelo real **están pendientes**. No se garantiza ausencia de alucinaciones.

Referencias utilizadas: [Responses y ejemplos](https://developers.openai.com/api/docs/quickstart),
[salidas estructuradas](https://developers.openai.com/api/docs/guides/structured-outputs),
[modelo configurable inicial](https://developers.openai.com/api/docs/models/gpt-6-luna).
