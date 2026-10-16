# Sprint 3 — avance verificado al 13/10/2026

## Resultado

Fases 1 (mensajería central) y 2 (WhatsApp): flujo principal implementado y probado. Cierre operativo completo todavía pendiente. No se declara una puesta en producción ni la conexión del número real del restaurante.

## Evidencia funcional aportada por el usuario

- Redis local en Docker respondió PONG.
- Meta mostró la app publicada y la suscripción de la app CRM a la WABA.
- Un mensaje real enviado al número de prueba llegó al webhook con respuesta 200, creó una conversación con teléfono y se guardó como INBOUND/PROCESSED.
- Un nuevo mensaje enviado mediante POST /conversations/:id/messages pasó de QUEUED a DELIVERED; el historial mostró externalMessageId, sentAt y deliveredAt, sin errorCode.
- Un envío anterior quedó FAILED/WHATSAPP_SEND_REJECTED. Repetir su solicitud devolvió el mismo registro; no implicó un nuevo intento. No se obtuvo el error original de Meta, por lo que no se atribuye una causa definitiva.

Las capturas son evidencia manual compartida en el chat, no una nueva prueba ejecutada por el agente. No se copian teléfonos, tokens, secretos ni identificadores de mensajes a este informe.

## Validación automatizada ejecutada

| Comprobación | Resultado |
| --- | --- |
| npm run build | PASS |
| npm test -- --runInBand | 418 pruebas, 32 suites, todas aprobadas |
| npm run test:e2e -- --runInBand | 183 pruebas, 3 suites, todas aprobadas; sin omitidas; dos ejecuciones finales consecutivas |
| BullMQ/Redis real | INBOUND y OUTBOUND aprobadas con prefijos aislados y Meta simulado |
| Idempotencia | Solicitudes concurrentes, conflicto 409 y worker repetido/concurrente cubiertos |
| Fallos | 429/backoff, fallo definitivo, UNKNOWN, leases, ventana cerrada y recuperación del outbox con broker simulado cubiertos |
| Caída real de Redis aislado | SIGKILL/start, restauración AOF, recepción durante caída y reconexión de workers aprobados |
| Lint de las pruebas nuevas/modificadas | PASS: test/isolated-redis.ts y test/whatsapp.cases.ts |

La integración utilizó bases PostgreSQL temporales y prefijos Redis aleatorios. El harness elimina únicamente sus bases y colas de prueba, no datos del CRM ni colas normales. No se enviaron mensajes a Meta ni correos reales. No se modificó .env, schema, migraciones o código de negocio.

Advertencias no bloqueantes observadas: VM Modules experimental de Node y deprecación de consultas concurrentes sobre un mismo cliente pg. No se ejecutó una auditoría de dependencias ni lint global en esta revisión.

Para reproducir, en una terminal nueva de PowerShell, con PostgreSQL local y Redis disponibles:

```powershell
$env:MESSAGING_ENABLED = 'false'
$env:WHATSAPP_ENABLED = 'false'
$env:RESERVATIONS_INTEGRATION = '1'
$env:CUSTOMERS_INTEGRATION = '1'
$env:MESSAGING_REDIS_INTEGRATION = '1'
$env:MESSAGING_REDIS_RESTART_INTEGRATION = '1'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379/0'
# Si docker no está en PATH, indica su ejecutable instalado:
$env:TEST_DOCKER_BIN = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe"
npm run test:e2e -- --runInBand
```

El harness utiliza TEST_DATABASE_URL o DATABASE_URL y requiere permiso para crear bases temporales. No apuntar a producción. Cerrar la terminal de pruebas al terminar para no reutilizar estos overrides al iniciar el backend.

## Caída y reinicio reales: alcance de la prueba

La nueva prueba opt-in está en test/whatsapp.cases.ts y usa test/isolated-redis.ts. Requiere Docker iniciado y la imagen redis:7.4-alpine ya disponible; no descarga imágenes automáticamente. Crea un contenedor con nombre aleatorio, etiqueta de propiedad y puerto libre ligado a 127.0.0.1. No acepta el nombre del contenedor del CRM como objetivo. La etiqueta se verifica antes de detener, iniciar o eliminar el contenedor.

Escenarios comprobados:

1. Pausar ambas colas, publicar trabajos reales INBOUND/OUTBOUND y confirmar PUBLISHED en PostgreSQL.
2. Matar Redis con SIGKILL y arrancar el mismo contenedor. Comprobar que sobreviven las colas pausadas y sus trabajos, reanudarlas y verificar PROCESSED/SENT y outbox COMPLETED.
3. Volver a matar Redis, recibir un webhook firmado por HTTP y aceptar un mensaje saliente por HTTP, con Meta simulado. Comprobar que quedan persistidos, sin intentos de procesamiento consumidos y con outbox PENDING/QUEUE_UNAVAILABLE.
4. Arrancar Redis y verificar que el dispatcher publica, los workers existentes se reconectan y ambos mensajes se completan.
5. Reprocesar el trabajo OUTBOUND completado: no se duplica la llamada simulada al proveedor.

Límites: el contenedor de prueba usa appendfsync=always para hacer determinista la persistencia antes del SIGKILL. Esto no prueba ausencia de pérdida bajo todas las políticas de disco, una caída del host, pérdida del volumen, ni aceptación por Meta durante una interrupción. Los escenarios UNKNOWN continúan cubiertos por simulaciones específicas. La primera ejecución de regresión agotó la espera de recuperación de 20 s; se añadió diagnóstico seguro de estados y se amplió a 45 s. La causa exacta de esa espera no se aisló; las dos ejecuciones finales completas pasaron en unos 18 s cada una.

Los contenedores temporales y sus volúmenes anónimos fueron eliminados al terminar. Se verificó ausencia de contenedores crm-redis-recovery-* y que bk-crm-redis-1 seguía healthy y respondía PONG, sin reiniciarlo.

## Pendientes antes del cierre operativo

1. Aceptar el alcance de recuperación probado arriba y planificar, para producción, respaldo de PostgreSQL/Redis, persistencia y alertas. La prueba aislada no sustituye una prueba de recuperación de infraestructura completa.
2. Completar evidencia manual de no duplicación de entrega y recibos de lectura disponibles; DELIVERED ya está demostrado. La idempotencia automatizada no equivale a una garantía de entrega exactamente una vez de extremo a extremo.
3. Revisar operación: expiración/rotación de credenciales, manejo de UNKNOWN, alertas de outbox antiguo y retención de recibos huérfanos. Las credenciales expuestas en el chat deben revocarse o rotarse; no se verificó que se haya hecho.
4. Mejorar, en un trabajo separado, el diagnóstico seguro de rechazos de Meta: actualmente se devuelve un error genérico, sin detalle del proveedor.

## Próximas fases

- Revisar elegibilidad y flujo de coexistencia antes de conectar el número que ya usa WhatsApp Business en el celular. No eliminar la cuenta ni migrar a ciegas.
- Preparar credenciales operativas y endpoint HTTPS estable; el túnel actual es de desarrollo.
- Comparar APIs con el mockup: búsqueda, historial, asignación, pausa, datos del cliente y vínculo con solicitudes/reservas.
- Definir e integrar Messenger, Instagram y Web por separado. WhatsApp no habilita automáticamente esos canales.
- Samanta: el estado de pausa no implica que exista una integración de IA.

No se encontró un cronograma con fechas comprometidas. Este informe registra avance funcional, no adelanto/retraso ni un porcentaje global.
