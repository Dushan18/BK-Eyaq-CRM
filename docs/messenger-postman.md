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

Si `.env` ya tiene estas claves, cambiar sus valores en lugar de volver a pegar el bloque:
con claves repetidas gana la última aparición y la copia de arriba solo confunde.

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

El botón **Probar** del panel envía un evento ficticio (`entry.id` `"0"`, formato `changes`).
El backend comprueba la firma, responde 200 y lo descarta: no crea conversaciones. Sirve
para comprobar conectividad y App Secret; la prueba real es la sección 3.

Antes de la prueba real, comprobar en Meta:

- **Usuarios sin rol en la app.** Comprobado el 2026-11-02 con esta app y la página del
  restaurante: los mensajes de cuentas sin rol llegan al webhook y las respuestas se
  entregan, sin App Review (Meta lo permite para la página propia). La documentación de
  Meta se contradice en esto; si un cliente no aparece en el CRM, probar con una cuenta
  con rol (Administrador, Desarrollador o Tester) para aislar el problema.
- **Suscripción de la página** (paso 4). El token del backend no puede consultarla
  (`subscribed_apps` requiere `pages_manage_metadata`): comprobarla en el panel.
- **"Requerir secreto de la app" desactivado** (Configuración → Avanzada → Seguridad).
  El backend no envía `appsecret_proof`; con esa opción activa las respuestas fallan.
- **Enrutamiento de conversaciones.** En la página → Mensajería avanzada → Apps conectadas
  (o Business Suite → Enrutamiento), ninguna otra app predeterminada ni Business AI debe
  controlar las conversaciones. Si no, llegan eventos `standby`, que el backend ignora.
- **Publicación de la app**, solo si con lo anterior un mensaje real no llega a ngrok.
  La documentación de Meta se contradice: la guía actual de Messenger la exige y hay
  reportes de que una app sin publicar solo recibe los webhooks de **Probar**. Requiere
  URL de política de privacidad, URL de eliminación de datos e ícono; no da acceso avanzado.

Si Meta no logra entregar webhooks durante 1 hora (backend o ngrok caídos, errores 5xx),
desactiva la suscripción de la página: revisar el paso 4 después de cualquier caída.
Si ngrok cambia de dominio, actualizar la URL de devolución y volver a verificar.

## 3. Prueba de extremo a extremo

Desde un perfil personal de Facebook (no actuando como la página ni desde la bandeja de
Business Suite) enviar un texto nuevo a la **página de Facebook**, no a WhatsApp:
`Prueba Messenger restaurante 001`. Cada cuenta distinta crea su propio cliente y
conversación; si el texto entra en una conversación existente, es la misma cuenta.

En ngrok comprobar `POST /webhooks/messenger` 200 con `"messaging"` en el cuerpo y
`entry.id` igual a `MESSENGER_PAGE_ID`. Si no llega ningún POST, revisar la lista de la
sección 2: no es un problema del backend. En Postman usar el **JWT del CRM**:

```http
GET http://localhost:3000/conversations?channel=FACEBOOK
Authorization: Bearer JWT_DEL_CRM
```

Copiar el `id` de la conversación nueva; no reutilizar el ID de la conversación WhatsApp.
La persona puede no tener teléfono ni email; su identidad se guarda como PSID por página.
Al recibir sus mensajes, el backend pide a Meta el nombre del remitente y lo guarda en
`firstName` si el cliente aún no tiene nombre (nunca sobrescribe uno puesto en el CRM).
Si Meta no lo entrega (cuando la consulta falla, el log muestra
`MESSENGER_NAME_LOOKUP_FAILED`), puedes ponerlo desde Clientes sin inventar un teléfono.

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
- `sentAt` es la hora en que Meta respondió al envío; `deliveredAt`, la hora del evento de
  entrega (el `watermark` solo si el evento no trae una hora válida).
- Meta envía una confirmación por dispositivo, a veces sin `mids`. Su `watermark` marca
  `DELIVERED` las respuestas `SENT` a ese cliente con `sentAt` hasta esa hora más 2 s (latencia
  de la respuesta y diferencia de relojes): una respuesta aceptada dentro de ese margen puede
  confirmarse junto con la anterior, y una cuya respuesta tardó más espera otra confirmación.
  El `watermark` se evalúa al llegar y no se guarda: si la respuesta aún no estaba en `SENT`,
  depende de una confirmación posterior. De varias confirmaciones, `deliveredAt` conserva la
  más temprana. Esa búsqueda no tiene índice; con mucho volumen, añadir uno parcial.
- Firma `X-Hub-Signature-256` validada contra los bytes originales con `META_APP_SECRET`.
- Ecos, otras páginas y eventos ajenos no crean clientes ni abren ventanas de respuesta.
- 429: reintento con demora. Timeout/red/5xx: `UNKNOWN`, sin reenvío automático para evitar duplicados.
  Meta suele indicar límites con códigos (4, 17, 32, 613, 80006) en un 4xx: hoy quedan `FAILED`.
- `FAILED`: revisar el log `MESSENGER_SEND_HTTP_ERROR` (solo códigos numéricos, sin tokens):
  - `metaCode` 200, `metaSubcode` 2018028: el destinatario no tiene rol en la app.
  - 10 con 2018278 o 2534022: pasaron más de 24 h desde el último mensaje del cliente.
  - 100 con 2018001: PSID inválido. 551: la persona no está recibiendo mensajes.
  - 190: token de página inválido o revocado.
- GET 403: verify token/modo incorrectos; POST 403: firma o App Secret incorrectos.
- POST 200 pero no aparece texto: si era el botón **Probar**, es lo esperado; si no, confirmar
  Page ID, suscripciones, permisos, payload y canal consultado.

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
