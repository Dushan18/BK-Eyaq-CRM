# WhatsApp Cloud API — Fase 2

Actualización 13/10/2026: build, 418 pruebas unitarias y 183 de integración aprobadas, incluidas las colas con Redis real y la recuperación tras SIGKILL/start de un broker aislado, con Meta simulado. El usuario confirmó mediante capturas una entrada PROCESSED y una salida DELIVERED con el número de prueba. Consultar [evidencias, comandos y límites de recuperación](sprint-3-progress.md); los resultados del 28/09 indicados abajo son históricos. El cierre operativo completo sigue pendiente.

Implementación: recepción firmada, texto/media entrante, envío TEXT desde CRM,
outbox/BullMQ saliente y conciliación durable de estados. No incluye IA, plantillas,
automatización de reservas, descarga de archivos ni frontend.

**Estado:** pruebas con PostgreSQL y Meta simulado aprobadas. No declarar la fase
operativamente cerrada hasta probar Redis real y el circuito con Meta/WhatsApp real.

## 1. Preparación

Las migraciones aditivas `20260927000100_whatsapp_transport` y
`20260927000200_whatsapp_delivery` agregan estados, campos e índices, recibos del
proveedor y cuarentena sin contenido. La separación permite que PostgreSQL confirme
los valores nuevos del enum antes de utilizarlos en restricciones. No eliminan datos.
Ya se aplicaron a la base local durante la implementación; en otro entorno:

```powershell
npx prisma migrate status
npx prisma migrate deploy
npx prisma generate
npm run build
```

No usar `migrate reset`. Respaldar la base antes de desplegar migraciones en producción.

Configurar `.env` localmente, sin compartirlo ni incluirlo en Git:

```dotenv
MESSAGING_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379/0
MESSAGING_QUEUE_PREFIX=eyaq-messaging
WHATSAPP_ENABLED=true
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_API_VERSION=
META_APP_SECRET=
```

Completar las seis últimas variables con la configuración de tu app de Meta.
`WHATSAPP_API_VERSION` debe ser una versión soportada por tu aplicación, con formato
`vNN.N`; no hay versión predeterminada en código. Los ejemplos de tests usan una
versión ficticia/configurada y no certifican su disponibilidad en tu cuenta.

- `WHATSAPP_ACCESS_TOKEN`: autorización para enviar mensajes; no es el JWT del CRM.
- `WHATSAPP_VERIFY_TOKEN`: secreto que eliges para verificar el GET del webhook.
- `META_APP_SECRET`: secreto de la aplicación para verificar la firma del POST.
- `PHONE_NUMBER_ID`: ID del número en Meta, no el teléfono escrito con `+51`.
- `BUSINESS_ACCOUNT_ID`: ID de WhatsApp Business Account (WABA).

El token debe tener los permisos de mensajería requeridos por Meta para el número.
Los tokens temporales de pruebas caducan. No pegarlos en capturas, logs o mensajes.
Con WhatsApp deshabilitado, sus endpoints responden 503 y no se exige tener esos
secretos. Los módulos anteriores siguen funcionando. Activarlo exige habilitar
mensajería y configurar Redis. No se instaló Docker ni Redis automáticamente.

## 2. Exponer y registrar el webhook

1. Iniciar NestJS con `npm run start:dev` y comprobar `GET /health`.
2. Usar un despliegue HTTPS o una herramienta de túnel de tu elección que reenvíe
   hacia `http://localhost:3000`. Meta no puede llamar a tu `localhost` directamente.
3. Configurar en Meta, dentro de la aplicación y la configuración de WhatsApp/Webhooks:
   - Callback URL: `https://TU-DOMINIO/webhooks/whatsapp`.
   - Verify token: exactamente el valor local de `WHATSAPP_VERIFY_TOKEN`.
4. Verificar y guardar. Suscribirse al campo `messages` del objeto
   `whatsapp_business_account` y comprobar que la app esté suscrita a la WABA usada.
   Este campo transporta mensajes y estados; no crear otro webhook para estados.
5. Confirmar que WABA y `phone_number_id` de los eventos coinciden con el entorno.
   Eventos de otra cuenta/número se ignoran aunque la firma sea válida.
6. Si usas el número de prueba de Meta, registrar/verificar el destinatario de prueba
   en la cuenta antes de enviar. Revisar permisos, vigencia del token y restricciones
   de la modalidad de la app antes de pasar a producción.

El proxy debe conservar el cuerpo original y `X-Hub-Signature-256`, no aplicar JWT al
webhook y no registrar cuerpos, Authorization ni query strings con verify tokens.
Se mantiene el límite predeterminado del parser JSON de Express (100 KB); una carga
mayor se rechaza con 413. Evaluar ese límite con los lotes reales antes de producción.

Referencias para revisar la configuración/versiones en tu cuenta:
[Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/),
[Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks),
[raw body en NestJS](https://docs.nestjs.com/faq/raw-body).
La documentación de Meta no pudo consultarse desde este entorno por una respuesta
429; verificar los nombres vigentes del panel y la versión admitida antes del alta real.

## 3. Verificación GET en Postman

```http
GET {{baseUrl}}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token={{verifyToken}}&hub.challenge=12345
```

Sin Authorization. Resultado: `200`, texto `12345` sin comillas. Token/modo inválido:
`403`. Usar una variable local sensible para `verifyToken`, no exportar su valor.

## 4. Recepción real

Desde un WhatsApp de prueba autorizado, enviar **Hola** al número conectado a Meta.
No simular la firma con `WHATSAPP_ACCESS_TOKEN`: Meta firma usando el App Secret.

Con JWT de ADMIN, OPERATOR u OWNER:

```http
GET {{baseUrl}}/conversations?channel=WHATSAPP
Authorization: Bearer {{accessToken}}
```

Guardar el `id` de la conversación como `conversationId`:

```http
GET {{baseUrl}}/conversations/{{conversationId}}/messages
Authorization: Bearer {{accessToken}}
```

Debe aparecer `INBOUND`, `TEXT`, `Hola` y el `externalMessageId` de Meta.
El estado pasa de `RECEIVED` a `PROCESSED` cuando Redis/worker funcionan.
Un duplicado no aumenta la secuencia ni los no leídos. IMAGE/FILE conservan metadata
y caption; AUDIO/VIDEO/STICKER se muestran como OTHER con un texto de aviso.

El webhook confirma 200 después de persistir los eventos reconocidos; si PostgreSQL
falla no los confirma como aceptados. Redis puede estar caído: el outbox conserva el
trabajo. Un lote parcialmente guardado se puede repetir sin duplicar sus mensajes.
Eventos malformados autenticados se registran como fingerprints en
`messaging_webhook_rejections`, sin cuerpo ni datos personales, y no bloquean el lote.

## 5. Responder desde el CRM

Usar JWT de ADMIN u OPERATOR. Generar **una clave UUID por mensaje intencional** y
guardarla como variable `idempotencyKey`; conservarla si repites esa misma petición.
No usar una variable aleatoria que cambie automáticamente en cada reintento.

```http
POST {{baseUrl}}/conversations/{{conversationId}}/messages
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{idempotencyKey}}
Content-Type: application/json
```

```json
{
  "type": "TEXT",
  "content": "Hola, somos Sabor Mágico Grill. ¿En qué podemos ayudarte?"
}
```

Respuesta `202 Accepted`: mensaje persistido en cola, **no confirmación de entrega**.
El backend calcula autor, destinatario y estado; no aceptar `to`, `status`,
`externalMessageId`, `authorUserId` o `sentAt` en el body. Máximo 4096 caracteres.

Comprobar:

- Repetir con misma clave, autor y body: mismo `id`, sin otro envío.
- Misma clave con distinto body/autor: `409`.
- Clave ausente/inválida o campos prohibidos: `400`.
- Sin JWT: `401`; OWNER/SUPPORT: `403`.
- Conversación inexistente: `404`.
- Conversación sin teléfono o de otro canal: `400`.
- Sin entrada reciente de WhatsApp para ese teléfono/cuenta: `409`.

La ventana se calcula con la fecha del último mensaje entrante de WhatsApp para el
teléfono y cuenta correctos, no con `Customer.lastContactAt`. Se verifica otra vez
en el worker. Un mensaje antiguo repetido no abre ventana; editar el teléfono no
cambia el destino de un envío ya encolado. Fuera de la ventana de 24 horas, hace
falta un flujo de plantilla aprobada, que esta fase no implementa.

## 6. Historial y estados

Volver a consultar el historial. Flujo normal:

```text
QUEUED → SENDING → SENT → DELIVERED → READ
```

- `SENT`: Meta aceptó el mensaje y se guardó su identificador.
- `DELIVERED` y `READ`: únicamente cuando llegan los respectivos recibos de Meta.
- `readAt`: lectura interna del equipo de un mensaje entrante; permanece nulo en salientes.
- `deliveredAt` y `providerReadAt`: entrega y lectura informadas por WhatsApp.
- Una confirmación READ no se degrada a DELIVERED/SENT/FAILED.
- FAILED no cambia a SENT por un evento retrasado. Evidencia DELIVERED/READ sí
  prevalece sobre un fallo previo. Los timestamps se conservan idempotentemente.
- Los recibos tempranos quedan en `message_status_events` y se concilian en segundo
  plano. Si aún no hay coincidencia, se revisan nuevamente después de 60 segundos.

El cliente puede no emitir confirmaciones de lectura. No interpretar la ausencia de
READ como fallo ni exigir que todos los mensajes lleguen a ese estado.

## 7. Fallos y envíos inciertos

Un rechazo HTTP 429 permite reintento con backoff, jitter y Retry-After numérico
(acotado a una hora), hasta cinco intentos de envío persistidos. Otros 4xx definitivos
producen FAILED. HTTP 408, 5xx, error de red, timeout o respuesta exitosa sin ID
producen UNKNOWN. No se guardan respuestas de error de Meta ni excepciones crudas.

Si un proceso muere en SENDING, al caducar su lease no se repite el POST: queda
UNKNOWN. Esto favorece no duplicar por encima de reenviar automáticamente.

**UNKNOWN no significa que el cliente no recibió el mensaje.** No reenviarlo con una
clave nueva sin comprobarlo. Si no se recibió/guardó el `wamid`, no se puede asociar
automáticamente el recibo a un mensaje basándose en teléfono, texto o fecha. Esos
casos requieren revisión operativa; no se añadió un endpoint que fuerce reenvíos ni
se promete entrega exactamente una vez. La conciliación automática funciona cuando
el identificador externo está disponible, incluso si el recibo llegó primero.

Las colas `messaging-inbound` y `messaging-outbound` contienen solo `messageId`.
El mismo outbox existente publica ambas direcciones. El único destino externo es
Graph API con versión/número configurados; no se siguen redirecciones.

## 8. Pruebas automatizadas

```powershell
npx prisma format
npx prisma validate
npm run build
npm test -- --runInBand
$env:MESSAGING_ENABLED = 'false'
$env:WHATSAPP_ENABLED = 'false'
$env:RESERVATIONS_INTEGRATION = '1'
$env:CUSTOMERS_INTEGRATION = '1'
npm run test:e2e -- --runInBand
```

Las suites de integración crean bases PostgreSQL temporales con nombres aleatorios,
aplican todas las migraciones y eliminan solo esas bases al terminar. Requieren
`TEST_DATABASE_URL` o la conexión local y permiso de creación de bases. Las pruebas
WhatsApp están registradas dentro de la suite de reservas/mensajería para reutilizar
su infraestructura aislada, JWT y usuarios de prueba; Meta siempre se simula.

Para probar también BullMQ, configurar un Redis de pruebas y activar
`MESSAGING_REDIS_INTEGRATION=1` junto con `TEST_REDIS_URL` (Redis compatible, no REST).
Mantener MESSAGING_ENABLED=false para no iniciar workers normales de la aplicación.
Las pruebas Redis usan prefijos propios y no ejecutan FLUSHALL.

Validación local del 28/09/2026: build, Prisma validate y lint de mensajería/WhatsApp
correctos; 418 pruebas unitarias y 180 de integración aprobadas. Se omiten dos
pruebas Redis (INBOUND/OUTBOUND) por falta de una instancia de pruebas configurada.
Las dos migraciones están aplicadas a PostgreSQL local y Prisma no detecta
diferencias entre esa base y el esquema.

## 9. Criterio de cierre operativo

- Redis real procesa ambas colas y se prueba recuperación tras caída/reinicio.
- Verificación GET y firma POST funcionan desde Meta sobre HTTPS.
- WhatsApp real → cliente/conversación/mensaje en CRM.
- ADMIN/OPERATOR responde → el teléfono de prueba recibe un solo mensaje.
- Historial refleja los recibos disponibles, con lectura interna independiente.
- Revisar ventana, expiración de tokens, UNKNOWN y alertas de outbox antiguo.
- Definir retención/observabilidad de recibos huérfanos y fingerprints antes de
  producción; esta fase conserva esos registros, sin borrado automático.

La arquitectura actual es de una sola WABA/número configurado. No cambiarlo para
atender varias cuentas simultáneamente: eso requiere un diseño multicuenta.
