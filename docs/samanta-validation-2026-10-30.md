# Samanta v1 — verificación técnica (30/10/2026)

## Entrega

- Módulo de borradores con generación explícita, consulta, edición, rechazo y
  aprobación. No se añadió automatización al webhook ni al procesador entrante.
- Proveedor Responses con modelo configurable, JSON estricto, sin herramientas,
  timeout y respuesta acotada, sin reintentos de red y errores normalizados.
- Contexto limitado a la conversación y campos permitidos de restaurante/catálogo.
- Migración aditiva de borradores con relaciones, auditoría, uso e idempotencia.
- Aprobación y outbox en una sola transacción; revisión optimista, pausa,
  asignación, vigencia y cambios del contexto comprobados antes de aprobar.
- Límite global de intentos por día UTC y llamadas simultáneas; no es una cuota
  monetaria garantizada. Llamadas externas siempre fuera de transacciones reintentadas.

## Resultados

| Comprobación | Resultado |
| --- | --- |
| Unitarias | 444 aprobadas, 34 suites |
| Integración PostgreSQL/Redis | 201 aprobadas, 3 suites, ninguna omitida |
| `npm run lint:check` | Sin errores ni advertencias |
| `npm run build` | Correcto |
| `prisma validate` / `prisma generate` | Correctos, cliente 7.10.1 |

Total: **645 pruebas**. La integración aplica todas las migraciones a una base
temporal aleatoria y la elimina al terminar. Meta y OpenAI están simulados.
No se modificó `.env`, no se generaron claves ni se hizo una llamada pagada.
La migración de Samanta no se aplicó a la base del CRM durante este trabajo.

## Hallazgos durante la ejecución

La prueba de concurrencia detectó un `DriverAdapterError` de serialización al
confirmar una transacción, sin envoltorio `P2010`. Se amplió el reconocimiento
del conflicto real (`40001`, `40P01`, `TransactionWriteConflict`) y se añadieron
pruebas para reintentos acotados y errores no reintentables. También se introdujo
una espera breve con variación entre reintentos para reducir contención.

Una ejecución intermedia de recuperación de Redis agotó el plazo con un mensaje
simulado en SENDING; después de los ajustes, la integración completa pasó dos
veces consecutivas con Redis real aislado (201 pruebas en cada pasada).
No se interpreta una ejecución exitosa como garantía de ausencia de fallos bajo
cualquier carga. Mantener seguimiento de contención y estados UNKNOWN en operación.
El primer intento de iniciar el contenedor fue bloqueado por el sandbox; se
repitió con permisos para el contenedor temporal, sin tocar el Redis del CRM.

Se mantienen los avisos de VM Modules de Jest y consultas concurrentes de pg
documentados en el informe de calidad previo. Los logs 503 de las pruebas de
Samanta desactivada son respuestas esperadas, no fallos de la suite.

## Pendiente antes de uso real

1. Revisar/aplicar la migración en la base correcta, tras respaldo.
2. Configurar clave y facturación de OpenAI en el servidor y activar Samanta.
3. Evaluar calidad, latencia y coste con conversaciones reales autorizadas. Las
   pruebas simuladas validan el flujo técnico, no la calidad del modelo.
4. Hacer la prueba manual de generación, edición, aprobación y entrega en el
   WhatsApp de prueba. No activar respuestas automáticas.

Pasos y cuerpos de solicitud: [guía de Postman](samanta-postman.md).
