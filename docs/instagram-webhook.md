# Instagram: webhook de recepción

Implementa `GET /webhooks/instagram` (challenge en texto plano) y `POST /webhooks/instagram`
(firma `X-Hub-Signature-256` sobre el cuerpo original). Unified Login usa el
`META_APP_SECRET` de la app propietaria del webhook, no el token de acceso.

## Activación

1. Revisar las migraciones pendientes con `npx prisma migrate status`.
2. Respaldar la base y aplicar las migraciones revisadas con `npx prisma migrate deploy`.
   La migración `20261104000000_instagram_inbound` admite contactos Instagram sin teléfono/email.
   El comando aplica **todas** las migraciones pendientes, no solo esta.
3. En `.env`, configurar `INSTAGRAM_ENABLED=true`, `INSTAGRAM_ACCOUNT_ID`,
   `INSTAGRAM_VERIFY_TOKEN` y `META_APP_SECRET`. Requiere `MESSAGING_ENABLED=true` y `REDIS_URL`.
   Para el nombre automático de los clientes, configurar también `INSTAGRAM_ACCESS_TOKEN`
   (token con `instagram_manage_messages`) e `INSTAGRAM_API_VERSION` (p. ej. `v26.0`).
4. Reiniciar el backend; mantener Redis y ngrok activos.
5. En Meta, registrar `https://<dominio-ngrok-actual>/webhooks/instagram` y el mismo
   `INSTAGRAM_VERIFY_TOKEN`. Verificar y guardar. Suscribir el campo `messages` y activar la
   suscripción de la cuenta Instagram del restaurante. Si el GET verifica pero nunca llega un
   POST, casi siempre falta el campo `messages`: la verificación funciona sin él.
6. Enviar un DM desde una cuenta autorizada para las pruebas. Revisar el POST en ngrok
   y consultar `GET /conversations?channel=INSTAGRAM` con el JWT del CRM; consultar después
   `GET /conversations/<id>/messages` para comprobar el contenido.

## Alcance y diagnóstico

- Solo procesa `object: instagram`, `entry[].messaging[]` de `INSTAGRAM_ACCOUNT_ID`.
- Texto se almacena como TEXT. Adjuntos quedan como OTHER con un marcador: no se descargan.
- Echoes, eliminaciones, eventos no compatibles y recibos no crean conversaciones.
- Las identidades se separan por canal/cuenta/usuario; se reutiliza la deduplicación y outbox del CRM.
- Nombre automático: cuando llega un mensaje de un cliente sin `firstName` ni `lastName`, se
  consulta `GET /{IGSID}?fields=name,username` en graph.facebook.com y se guarda en `firstName` el
  nombre del perfil o, si no tiene, `@usuario`. Nunca reemplaza un nombre puesto en el CRM. Si
  falla, el cliente queda sin nombre, el webhook responde 200 igual y se reintenta con el
  siguiente mensaje. El log registra `INSTAGRAM_NAME_LOOKUP_FAILED` sin el IGSID ni el nombre.
  Sin `INSTAGRAM_ACCESS_TOKEN` no se consulta nada.
- Un 200 de una muestra sintética de Meta **no prueba** persistencia: puede llevar IDs ficticios
  o un formato distinto. La prueba funcional debe ser un DM real.
- 403 en GET: token/modo/challenge incorrectos. 403 en POST: firma o App Secret incorrectos.
- 503: Instagram desactivado. 500: revisar persistencia/migraciones; Meta puede reintentar.
- Todavía **no implementa envío**, descarga de adjuntos ni respuestas automáticas de Samanta.
  `INSTAGRAM_ACCESS_TOKEN` e `INSTAGRAM_API_VERSION` se usan hoy solo para el nombre del perfil.
  No reemplazar credenciales de WhatsApp ni Messenger.
- No publicar tokens, App Secret ni cuerpos de mensajes en capturas o logs.

## Pruebas locales

`npm test -- --runInBand instagram`

Incluyen handshake HTTP, firma del cuerpo crudo, filtrado de cuenta, eventos inválidos,
adjuntos, echoes, propagación de fallos transitorios y el nombre automático (perfil, `@usuario`,
remitente distinto, errores de Meta). No llaman a Meta ni envían mensajes.
