# Messenger: activación y prueba controlada

Conector v1 para una página del restaurante. Usa el canal interno `FACEBOOK`.
No reemplaza WhatsApp ni configura Instagram. No envía respuestas automáticas de Samanta.

## 1. Preparar el backend

Esta versión agrega identidad de cliente por página + PSID e identificador de destinatario
en mensajes. No inventa teléfonos ni mezcla contactos entre páginas.
La guía de Prisma se utilizó para crear contacto, conversación, mensaje y outbox en una
transacción con deduplicación. Los envíos a Meta quedan fuera de esa transacción.

Detener el backend/watch antes de desplegar. Respaldar la base y comprobar que `DATABASE_URL`
apunta a la base correcta. Revisar las migraciones pendientes antes de aplicarlas:

```powershell
npx prisma migrate status
npx prisma migrate deploy
npx prisma generate
npm run build
```

La migración nueva es `20261102060000_messenger_transport`. `deploy` aplica **todas** las
migraciones pendientes; detenerse si aparecen otras no revisadas. No usar `migrate reset`.
Es necesaria antes de ejecutar el nuevo código, incluso si Messenger permanece apagado.
Las pruebas aisladas no migran la base real del restaurante.

Completar en `.env` local (no compartir tokens ni subir el archivo a Git):

```dotenv
MESSENGER_ENABLED=false
MESSENGER_PAGE_ID=101496379193760
MESSENGER_PAGE_ACCESS_TOKEN=REEMPLAZAR_EN_PRIVADO
MESSENGER_VERIFY_TOKEN=VALOR_ALEATORIO_PRIVADO
MESSENGER_API_VERSION=v26.0
```

Usar el token generado en la fila **Sabor Mágico Grill - Restaurant**, no el de otra página.
Mantener las credenciales de WhatsApp. `META_APP_SECRET` debe corresponder a la app
`2211731836078710` si se utiliza esa misma app para ambos canales. El verify token lo
defines tú, es distinto del Page access token; debe coincidir exactamente con Meta.
Puedes generar uno localmente con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Meta requiere un token de página y `pages_messaging`, con acceso a la tarea de mensajes
de la página. Consulta la [colección oficial de Messenger](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api).

Con Redis disponible y `MESSAGING_ENABLED=true`, cambiar `MESSENGER_ENABLED=true` y
reiniciar los procesos que cargan `.env`. La configuración incompleta impide arrancar
el conector habilitado. No iniciar dos backend/workers con configuraciones distintas.

## 2. Configurar Meta

En Messenger → Configuración de la API:

1. URL de devolución: `https://TU_DOMINIO_NGROK_ACTUAL/webhooks/messenger`.
2. Token de verificación: el mismo `MESSENGER_VERIFY_TOKEN` local.
3. Verificar y guardar. En ngrok debe aparecer `GET /webhooks/messenger` con 200
   y el challenge como respuesta. Abrir la URL sin parámetros no verifica el webhook.
4. En la fila de la página del restaurante, agregar las suscripciones `messages`
   y `message_deliveries`. El conector v1 no procesa `message_reads` ni postbacks.
5. No suscribir páginas ajenas al restaurante. Revisar los permisos otorgados a la app.

La publicación de la app no garantiza acceso avanzado a mensajes de cualquier cliente.
Comprobar `pages_messaging` y el estado de revisión en Meta. Para la prueba inicial usar
una persona con rol autorizado en la app, tal como indica el panel de Messenger.

## 3. Prueba de extremo a extremo

Desde una cuenta autorizada enviar un texto a la **página de Facebook**, no a WhatsApp:
`Prueba Messenger restaurante 001`.

En ngrok comprobar `POST /webhooks/messenger` 200. En Postman usar el **JWT del CRM**:

```http
GET http://localhost:3000/conversations?channel=FACEBOOK
Authorization: Bearer JWT_DEL_CRM
```

Copiar el `id` de la conversación nueva; no reutilizar el ID de la conversación WhatsApp.
La persona puede no tener teléfono/email/nombre; su identidad se guarda como PSID por página.
Puedes editar su nombre desde Clientes sin inventar un teléfono.

```http
GET http://localhost:3000/conversations/ID_CONVERSACION/messages
Authorization: Bearer JWT_DEL_CRM
```

Debe aparecer el texto entrante como `INBOUND`, canal `FACEBOOK`, luego `PROCESSED`.
Responder desde el CRM:

```http
POST http://localhost:3000/conversations/ID_CONVERSACION/messages
Authorization: Bearer JWT_DEL_CRM
Content-Type: application/json
Idempotency-Key: prueba-messenger-restaurante-001
```

```json
{"type":"TEXT","content":"Hola, recibimos tu mensaje en Sabor Mágico Grill."}
```

El 202/`QUEUED` solo confirma que se guardó. Consultar de nuevo mensajes para comprobar
`SENT`, `externalMessageId` y, al recibir el webhook, `DELIVERED`. Verificar también la
recepción en Messenger. Repetir el mismo POST con la misma clave y cuerpo debe devolver
el mismo mensaje, no reenviarlo. Para un mensaje distinto usar una clave nueva.

Las respuestas normales requieren un mensaje del cliente en las últimas 24 horas;
esta versión no implementa excepciones a esa ventana. Véase la
[documentación oficial de envío](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api).

## Alcance y diagnóstico

- Una página configurada por despliegue; texto saliente limitado a 2000 caracteres.
- Adjuntos entrantes se registran como `OTHER` con aviso; no se descargan ni se envían adjuntos.
- No hay estado `READ` de Messenger en v1, ni sincronización de historial previo.
- Firma `X-Hub-Signature-256` validada contra los bytes originales con `META_APP_SECRET`.
- Ecos, otras páginas y eventos ajenos no crean clientes ni abren ventanas de respuesta.
- 429: reintento con demora. Timeout/red/5xx: `UNKNOWN`, sin reenvío automático para evitar duplicados.
- `FAILED`: revisar el log `MESSENGER_SEND_HTTP_ERROR` (solo códigos numéricos, sin tokens).
- GET 403: verify token/modo incorrectos; POST 403: firma o App Secret incorrectos.
- POST 200 pero no aparece texto: confirmar Page ID, suscripciones, permisos, payload y canal consultado.

## Pruebas locales sin enviar a Meta

```powershell
npm test -- --runInBand
```

Integración con PostgreSQL temporal, JWT/HTTP reales y envío Meta simulado:

```powershell
$env:RESERVATIONS_INTEGRATION='1'
$env:MESSAGING_ENABLED='false'
npm run test:e2e -- --runInBand reservations.integration -t Messenger
```

Ejecutar en una terminal de pruebas, no en la del servidor. Requiere PostgreSQL y permisos
para crear/borrar la base temporal. La base temporal se elimina al terminar; no contiene
datos del restaurante. No usar los resultados simulados como confirmación de permisos de Meta.
