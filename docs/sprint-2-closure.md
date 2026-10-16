# Cierre técnico y funcional — Sprint 2

Fecha de ejecución: 22 de septiembre de 2026. Alcance: backend local, sin Sprint 3.

## 1. Estado general

**Listo para revisión técnica, no aprobado automáticamente.** La validación automatizada pasa tras corregir cuatro errores reproducidos de entradas inválidas del catálogo. La demo manual y las observaciones de deuda requieren revisión del equipo.

Se preservaron las modificaciones de calendario que ya estaban en el árbol de trabajo al comenzar. No se atribuyen a este cierre los modelos/historiales de calendario, su migración, sus endpoints ni las pruebas que ya existían.

No se ejecutó migrate reset, no se aplicaron migraciones nuevas ni se modificaron datos del restaurante. Las suites de integración crean y eliminan únicamente sus bases temporales con nombres validados. El correo de recuperación se simuló en integración: no se envió correo real.

## 2. Build

PASS — `npm run build`, antes y después de las correcciones. Sin any, ts-ignore ni desactivación de reglas añadidos para ocultar errores.

## 3. Prisma

| Comprobación | Resultado |
| --- | --- |
| prisma validate inicial/final | PASS |
| prisma format | PASS; hash del schema idéntico antes/después |
| prisma migrate status | PASS; 7 migraciones aplicadas |
| migrate diff base configurada → schema | PASS; sin diferencias |
| Migración nueva para este cierre | NOT APPLICABLE |
| Auditoría exhaustiva de datos de producción | PENDING; no se ejecutó sobre producción |

El proceso nativo de Prisma fue bloqueado con EPERM en una comprobación final; se repitió con autorización y terminó correctamente. No era un error del esquema.

Revisión de diseño:

- Dinero: CommercialItem.basePrice, CommercialItemVariant.price y ReservationRequest.quotedPrice usan Decimal(10,2), PostgreSQL NUMERIC, respuestas con dos decimales como strings. No se usan Float para estos importes.
- CommercialItem tiene índices de type, categoryId/displayOrder, isActive, approvalStatus/isActive, createdAt y normalizedName.
- Customer tiene unicidad de normalizedPhone/normalizedEmail e índices status, sourceChannel, lastContactAt/id y createdAt.
- Request tiene code único e índices status/createdAt, customerId, commercialItemId, sourceChannel y reservationAt.
- Reservation tiene code y reservationRequestId únicos, índices reservationAt/id, status/reservationAt, customerId, commercialItemId y assignedUserId/reservationAt.
- CustomerInterest es único por cliente/ítem; los horarios por ítem/día; variantes por ítem/nombre normalizado; imágenes por ítem/URL y una sola principal.
- Restrict conserva clientes, ítems e historiales referenciados. SetNull en asignación permite retirar un usuario sin autoría histórica; autores de notas/reprogramaciones permanecen protegidos.
- Las secuencias PostgreSQL generan los códigos; no se usa count()+1. P2002 se traduce a 409 y P2034 se reintenta hasta tres veces. Las secuencias pueden dejar huecos, lo cual no viola unicidad.
- Las pruebas de integración aplican el SQL de todas las migraciones y ejercitan restricciones/concurrencia. migrate diff por sí solo no demuestra el estado de cada CHECK, secuencia ni fila de la base local.

## 4. Tests

| Suite | Inicial | Final | Fallos finales |
| --- | ---: | ---: | ---: |
| Unitarias/HTTP con mocks, 30 suites | 334 | 339 | 0 |
| E2E/integración, 3 suites habilitadas | 89 | 139 | 0 |
| Total | 423 | 478 | 0 |

Se añadieron 5 casos unitarios y 50 casos de integración. También se extendió el caso existente de exclusión del calendario para incluir Request CANCELLED.

Primera ejecución de los nuevos casos de cierre: 39 pasaron y 4 fallaron con HTTP 500. Después de corregir los DTOs, todos pasan. Un fallo posterior del nuevo test de clientes se debió a usar sourceChannel como query: se corrigió el test a channel, sin cambiar la API.

Ejecución reproducible en PowerShell:

```powershell
npx prisma validate
npm run build
npm test -- --runInBand
$env:CUSTOMERS_INTEGRATION = '1'
$env:RESERVATIONS_INTEGRATION = '1'
npm run test:e2e -- --runInBand
```

Las suites de integración requieren PostgreSQL y permiso para crear bases temporales. Revisar TEST_DATABASE_URL/DATABASE_URL y configuración de autenticación antes de ejecutarlas. No apuntar estos comandos a producción. Sin las dos variables, las suites correspondientes se omiten: ese resultado no prueba el cierre.

Cobertura medida al inicio, solo suite unitaria: statements 57.31%, branches 47.85%, functions 54.72%, lines 57.72%. No es cobertura integral de e2e ni una medición posterior a los tests añadidos. Los antiguos tests de auth/session de “should be defined” no prueban comportamiento; la regresión real se sustenta en HTTP/JWT de integración.

Evidencias abreviadas para el checklist:

- **C**: test/sprint2-closure.cases.ts, registrado dentro de la suite PostgreSQL de reservas. Catálogo CRUD/relaciones/validación, consulta interna, clientes JWT y regresiones Sprint 1.
- **M**: misma ruta, describe “Cierre Sprint 2: matriz HTTP completa”: 31 endpoints, sin token y los cuatro roles reales.
- **U**: test/customers.integration.e2e-spec.ts. Prisma real; guard de autenticación sustituido. M/C complementan la evidencia JWT real.
- **R**: test/reservations.integration.e2e-spec.ts. AppModule, guards, JWT y PostgreSQL reales; incluye concurrencia, restricciones y rangos.
- **DTO**: src/dto/*.spec.ts; validación de entradas. **Reglas reserva**: src/reservations/reservation-rules.spec.ts.

## 5. Módulo 4

PASS en las pruebas críticas: categorías, cinco tipos de CommercialItem, variantes, imágenes, FAQs, horarios, estados, aprobación, filtros y precios.

Modelos: CommercialCategory, CommercialItem, CommercialItemVariant, CommercialItemImage, CommercialItemFaq, CommercialItemSchedule, CommercialPromotionDetail y CommercialEventDetail. Enums reales: CommercialItemType (DISH, BEVERAGE, SERVICE, PROMOTION, EVENT), CommercialApprovalStatus (DRAFT, APPROVED, REJECTED), DayOfWeek.

DISH/BEVERAGE requieren precio base o variantes activas, no ambos. Crear deja DRAFT; aprobar exige nombre español. Editar contenido aprobado vuelve a DRAFT. Los arrays presentes en PATCH se reemplazan; los omitidos se conservan. Las categorías inactivas no habilitan nuevos ítems.

El método interno findAvailableForAssistant exige ítem activo/aprobado y categoría activa; no expone internalNotes. No se añadió Samanta ni un endpoint para asistentes.

GET /commercial-items admite page, limit, type, categoryId, approvalStatus, isActive, search, sort y order. page admite 1..1 000 000; limit 1..100. sort: category/name/createdAt; order: asc/desc. Las categorías se listan sin paginación.

## 6. Módulo 5

PASS en CRUD, normalización, deduplicación concurrente, estados e intereses. La prueba JWT comprueba resultados por nombre, email y teléfono con/sin formato, no solo el status HTTP.

Customer guarda contacto original y campos normalizados privados. Debe conservar al menos un contacto utilizable. CustomerInterest registra primera/última fecha y no duplica la pareja cliente/ítem. Eliminar interés no elimina las entidades.

Estados: NEW, INTERESTED, IN_CONVERSATION, REQUESTED_RESERVATION, CONFIRMED, REJECTED, LOST, RECURRENT. Su cambio manual no crea reservas.

Canales: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER. Body: sourceChannel; query: channel. Otros filtros: search, status, commercialItemId, page y limit. Ver [guía de clientes](customers-postman.md).

## 7. Reservation Request

PASS — solicitud distinta de reserva operativa. Fecha/personas determinan INCOMPLETE_DATA o READY_TO_SEND. PATCH /status permite cancelar; no aprueba ni envía al propietario.

El enum contiene estados futuros (SENT_TO_OWNER, WAITING_RESPONSE, ACCEPTED, REJECTED, MODIFICATION_REQUESTED, RENEGOTIATING), pero esto no habilita sus flujos HTTP. El caso REJECTED de calendario se prepara en la base aislada de pruebas.

Código RES-año-secuencia. Filtros: search, status, customerId, commercialItemId, channel, dateFrom/dateTo y paginación. Ver [guía de reservas](reservations-postman.md).

## 8. Reservation

PASS — creación manual solo ADMIN, código R-año-secuencia. La relación opcional 1:0..1 con Request existe en BD y está probada con restricciones, pero POST manual no acepta vincular/aprobar una solicitud.

Estados reales: CONFIRMED, UPCOMING, IN_SERVICE, COMPLETED, RESCHEDULED, CANCELLED, NO_SHOW.

Transiciones:

| Desde | Hacia |
| --- | --- |
| CONFIRMED | UPCOMING, IN_SERVICE, CANCELLED, NO_SHOW |
| UPCOMING | IN_SERVICE, CANCELLED, NO_SHOW |
| RESCHEDULED | CONFIRMED, UPCOMING, IN_SERVICE, CANCELLED, NO_SHOW |
| IN_SERVICE | COMPLETED |

Repetir el mismo estado permitido es idempotente. IN_SERVICE y NO_SHOW requieren que haya llegado la hora. Conflictos de transición devuelven 409, no 400; valores de estado no habilitados/DTO inválido devuelven 400. Se preservó el contrato existente.

## 9. Calendario

PASS — se consulta exclusivamente Reservation mediante GET /reservations. Las solicitudes READY_TO_SEND, REJECTED y CANCELLED quedan fuera; una Reservation CONFIRMED sí aparece.

Rango semiabierto: dateFrom <= reservationAt < dateTo, orden reservationAt ASC/id ASC. Se probaron rangos de 1 día, 7 días y enero completo (31 días). No existe endpoint de vista ni frontend: día/semana/mes/lista son formas de consumir la misma consulta paginada.

Filtros: search (código, nombres, apellido, teléfono), status, customerId, commercialItemId, assignedUserId, excludeCancelled, dateFrom/dateTo, page/limit. Canceladas incluidas por defecto; excludeCancelled=true las oculta. Combinarlo con status=CANCELLED devuelve 400.

Responsable válido: ADMIN/OPERATOR activo. OPERATOR solo toma reservas libres o libera su propia asignación. Notas append-only con autor JWT; historial de reprogramación con motivo/autor. El detalle conserva notes y añade noteHistory/rescheduleHistory. No cambia el estado de Customer automáticamente.

Ver [guía operativa del calendario](reservation-calendar-postman.md).

## 10. RBAC

PASS — matriz de la sección 16 contrastada con controllers reales y 31 pruebas parametrizadas HTTP/JWT.

Cada caso comprueba 401 sin token, 403 para cada rol excluido y admisión al pipeline para roles permitidos. Las peticiones permitidas con ID inexistente/body vacío pueden devolver 400/404: no se confunden con una operación de negocio exitosa. Las pruebas de flujos válidos complementan esta matriz.

## 11. Regresiones Sprint 1

| Área | Estado y evidencia |
| --- | --- |
| Login/access/refresh rotación/logout | PASS, R con JWT/sesión reales y rechazo de token antiguo |
| Desactivar usuario revoca sesión/access/refresh | PASS, C |
| Crear/editar/reactivar/cambiar rol | PASS, C; bcrypt y campos seguros en unitarias |
| Listar usuarios y consultar APIs previas | PASS, R/C |
| Forgot/reset | PASS, C con correo simulado; token de un uso y contraseña anterior rechazada |
| Entrega real Resend | PENDING demo externa; no se envió correo |
| RestaurantConfig GET/PUT/idiomas/7 horarios/OWNER responsable | PASS, C + unitarias del servicio |
| Health 200 y 503 DB simulada | PASS, health.controller/service.spec.ts y app.e2e |
| Errores conocidos/500 sanitizado | PASS, global-exception.filter.spec.ts |

Los tests no equivalen a una auditoría de seguridad completa.

## 12. Errores encontrados y corregidos

| Entrada | Antes, reproducido | Después |
| --- | --- | --- |
| PATCH item categoryId:null | 500 PrismaClientValidationError | 400 DTO |
| PATCH item displayOrder:null | 500 PrismaClientValidationError | 400 DTO |
| PATCH categoría displayOrder:null | 500 PrismaClientValidationError | 400 DTO |
| GET items page=1e30 | 500 PrismaClientValidationError | 400 DTO |

Cambios de producción limitados a commercial-category.dto.ts y commercial-item.dto.ts. ValidateIf permite omitir campos no anulables, pero no enviar null; page se limita igual que Customer. Los campos realmente anulables mantienen su comportamiento. No se cambiaron servicios, rutas ni guards para estas correcciones.

schedules:[null] ya devolvía 400: se conservó ese comportamiento y quedó probado.

## 13. Fallos preexistentes

FAIL — lint global: 430 errores iniciales y 430 finales. Los archivos de este cierre pasan lint específico. La mayoría son formato; también existen advertencias convertidas en error de tipado inseguro en código previo. No se ejecutó npm run lint porque incorpora --fix y modificaría archivos fuera de esta corrección.

Warnings no bloqueantes en integración: VM Modules experimental y deprecación pg por consultas simultáneas en un cliente. No se actualizaron dependencias dentro de este cierre.

No hubo fallos iniciales de build, unitarias ni e2e habilitadas.

## 14. Deuda técnica

- PENDING: resolución del lint global, demo manual y entrega Resend.
- Customer/CustomerInterest y fechas del catálogo usan DateTime sin Timestamptz explícito; Request/Reservation/historiales usan Timestamptz(3). Las reservas exigen ISO con zona y serializan UTC; promociones/eventos admiten entradas menos estrictas. No se migraron fechas ni se cambió esa convención durante el cierre.
- No se midió rendimiento con volumen real ni EXPLAIN. No se observó un bucle de consultas por cada fila en los tres listados revisados; eso no garantiza un número SQL constante con toda estrategia de Prisma.
- Catálogo carga recursos hijos en listado; notas/reprogramaciones e intereses de detalle no tienen paginación propia. Evaluar tamaño antes de optimizar.
- Hay lógica semejante de transacciones/reintentos en varios servicios y un enum Role legado sin referencias encontradas; la API usa RoleCode. No se eliminó código por estética.
- La disponibilidad de nombres de categoría se comprueba entre ambos idiomas en el servicio, mientras los índices únicos son por columna. Revisar carrera entre idiomas si se exige unicidad transversal bajo concurrencia; no se afirma que esa carrera se haya reproducido.
- TODO de auditoría funcional en catálogo/clientes/configuración/reservas; no existe implementación completa. Se conserva como pendiente, sin añadir un sistema nuevo.
- Secuencias permiten huecos y no se reinician por año. No se promete numeración consecutiva.
- No se hizo carga/penetración, despliegue, auditoría de datos de producción ni frontend. Esas actividades no se declaran aprobadas.

Logging revisado: filtro registra contexto técnico controlado, no body/Authorization/stack; health y password reset usan mensajes fijos. El filtro conserva HttpException; los mensajes futuros de excepciones también deben mantenerse libres de secretos.

## 15. Evidencias para demo

PENDING — ejecutar [secuencia de Postman de cierre](sprint-2-demo.md). No se fabricaron capturas ni se creó una colección masiva.

Guardar evidencia de build/validate/tests, creación y aprobación del catálogo, deduplicación, interés, solicitud vs reserva, rango calendario, autor JWT, responsable, transición, reprogramación/cancelación y 401/403. Ocultar tokens, contraseñas y datos personales en capturas.

## 16. Endpoints finales

Sí = rol admitido; sujeto a validación/reglas de negocio. Todas las rutas exigen JWT. No hay endpoint separado /calendar.

| Método | Endpoint | ADMIN | OWNER | OPERATOR | SUPPORT | Descripción |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /commercial-categories | Sí | Sí | Sí | No | Listar Categorías |
| GET | /commercial-categories/:id | Sí | Sí | Sí | No | Detalle Categorías |
| POST | /commercial-categories | Sí | No | No | No | Crear Categorías |
| PATCH | /commercial-categories/:id | Sí | No | No | No | Editar Categorías |
| PATCH | /commercial-categories/:id/status | Sí | No | No | No | Estado Categorías |
| GET | /commercial-items | Sí | Sí | Sí | No | Listar Catálogo |
| GET | /commercial-items/:id | Sí | Sí | Sí | No | Detalle Catálogo |
| POST | /commercial-items | Sí | No | No | No | Crear Catálogo |
| PATCH | /commercial-items/:id | Sí | No | No | No | Editar Catálogo |
| PATCH | /commercial-items/:id/status | Sí | No | No | No | Estado Catálogo |
| GET | /customers | Sí | Sí | Sí | No | Listar Clientes |
| GET | /customers/:id | Sí | Sí | Sí | No | Detalle Clientes |
| POST | /customers | Sí | No | Sí | No | Crear Clientes |
| PATCH | /customers/:id | Sí | No | Sí | No | Editar Clientes |
| PATCH | /customers/:id/status | Sí | No | Sí | No | Estado Clientes |
| GET | /reservation-requests | Sí | Sí | Sí | No | Listar Solicitudes |
| GET | /reservation-requests/:id | Sí | Sí | Sí | No | Detalle Solicitudes |
| POST | /reservation-requests | Sí | No | Sí | No | Crear Solicitudes |
| PATCH | /reservation-requests/:id | Sí | No | Sí | No | Editar Solicitudes |
| PATCH | /reservation-requests/:id/status | Sí | No | Sí | No | Estado Solicitudes |
| GET | /reservations | Sí | Sí | Sí | No | Listar Reservas/calendario |
| GET | /reservations/:id | Sí | Sí | Sí | No | Detalle Reservas/calendario |
| POST | /reservations | Sí | No | No | No | Crear Reservas/calendario |
| PATCH | /reservations/:id | Sí | No | Sí | No | Editar Reservas/calendario |
| PATCH | /reservations/:id/status | Sí | No | Sí | No | Estado Reservas/calendario |
| PATCH | /commercial-items/:id/approval | Sí | No | No | No | Aprobación |
| POST | /customers/:id/interests | Sí | No | Sí | No | Registrar/reiterar interés (200) |
| DELETE | /customers/:id/interests/:commercialItemId | Sí | No | Sí | No | Retirar interés (204) |
| PATCH | /reservations/:id/assignee | Sí | No | Sí | No | Asignar responsable; OPERATOR solo sí mismo |
| POST | /reservations/:id/notes | Sí | No | Sí | No | Añadir nota (201), autor JWT |
| PATCH | /reservations/:id/reschedule | Sí | No | Sí | No | Reprogramar e historizar |

GET/PATCH exitosos devuelven 200. POST de creación devuelve 201 salvo intereses (200). DELETE interés devuelve 204. No existe eliminación física de categorías, ítems, clientes, solicitudes o reservas en estos controllers.

## 17. Resultado del Sprint

**Cierre automatizado completado; revisión funcional pendiente.** No se declara aprobado el Sprint por haber pasado tests. El equipo debe revisar deuda, aceptar la semántica HTTP existente y completar demo antes de firmar el cierre.

| Criterio transversal | Estado |
| --- | --- |
| Build, Prisma y suites críticas | PASS |
| Cuatro errores reproducidos | PASS, corregidos |
| RBAC backend integral Sprint 2 | PASS |
| Calendario no consulta Request | PASS |
| Regresiones Sprint 1 ejercitadas | PASS con límites indicados |
| Lint global | FAIL preexistente |
| Demo Postman y Resend real | PENDING |
| Auditoría exhaustiva de BD de producción/rendimiento | PENDING |
| Sprint 3, frontend y automatización propietaria | NOT APPLICABLE |

### Checklist numerado del prompt

PASS significa evidencia automatizada o comprobación explícita indicada, no garantía absoluta. Se conserva una discrepancia compatible: requisito 113 usa 409 en el contrato real, aunque el ejemplo del prompt decía 400.

| N.º | Requisito | Estado | Evidencia / alcance |
| --- | --- | --- | --- |
| 1 | Crear categoría ADMIN | PASS | C |
| 2 | Editar categoría ADMIN | PASS | C |
| 3 | Activar/desactivar categoría | PASS | C |
| 4 | OWNER consulta categorías | PASS | M |
| 5 | OPERATOR consulta categorías | PASS | M |
| 6 | SUPPORT rechazado | PASS | M |
| 7 | Crear DISH | PASS | C |
| 8 | Crear BEVERAGE | PASS | C |
| 9 | Crear SERVICE | PASS | C |
| 10 | Crear PROMOTION | PASS | C |
| 11 | Crear EVENT | PASS | C |
| 12 | Precio Decimal, respuesta string | PASS | C; schema Decimal(10,2) |
| 13 | Variantes | PASS | C |
| 14 | Imágenes URL | PASS | C; DTO comercial |
| 15 | FAQs | PASS | C |
| 16 | Horarios | PASS | C; DTO comercial |
| 17 | Activo/inactivo | PASS | C |
| 18 | DRAFT | PASS | C |
| 19 | APPROVED | PASS | C |
| 20 | REJECTED | PASS | C |
| 21 | Búsqueda catálogo | PASS | C |
| 22 | Filtros combinados catálogo | PASS | C |
| 23 | Paginación catálogo | PASS | C |
| 24 | Categoría inexistente rechazada | PASS | C: 400 |
| 25 | Item inexistente | PASS | C: 404 |
| 26 | Consulta interna solo activos/aprobados y categoría activa | PASS | C: consulta interna |
| 27 | ADMIN crea Customer | PASS | U |
| 28 | OPERATOR crea Customer | PASS | C: clientes JWT |
| 29 | OWNER solo lectura Customer | PASS | M |
| 30 | SUPPORT rechazado Customer | PASS | M |
| 31 | Normalización email | PASS | U; C |
| 32 | Normalización teléfono | PASS | U; contact-normalization.spec |
| 33 | No exponer normalizedEmail | PASS | U; C |
| 34 | No exponer normalizedPhone | PASS | U; C |
| 35 | Teléfono duplicado | PASS | U: duplicados |
| 36 | Email duplicado | PASS | U; C |
| 37 | P2002 controlado | PASS | U: duplicados/concurrencia |
| 38 | Creación concurrente sin duplicados | PASS | U: dos creaciones concurrentes |
| 39 | NEW | PASS | C: clientes JWT |
| 40 | INTERESTED | PASS | C: clientes JWT |
| 41 | IN_CONVERSATION | PASS | C: clientes JWT |
| 42 | Cambio de estado Customer | PASS | U; C |
| 43 | Crear interés | PASS | U; C |
| 44 | Interés repetido no duplica | PASS | U: intereses repetidos/concurrentes |
| 45 | lastInterestedAt se actualiza | PASS | U: intereses repetidos/concurrentes |
| 46 | Item inexistente en interés | PASS | U: 404 |
| 47 | Eliminar interés conserva Customer | PASS | C: clientes JWT |
| 48 | Eliminar interés conserva Item | PASS | C: clientes JWT |
| 49 | Buscar Customer por nombre | PASS | U: filtros combinados |
| 50 | Buscar Customer por teléfono | PASS | C: clientes JWT, aserción de ID y total con/sin formato |
| 51 | Buscar Customer por email | PASS | U; C |
| 52 | Filtro Customer status | PASS | U |
| 53 | Filtro Customer channel | PASS | U; C (query channel, no sourceChannel) |
| 54 | Filtro Customer commercialItemId | PASS | U; C |
| 55 | Paginación Customer | PASS | U; C |
| 56 | ADMIN crea Request | PASS | R |
| 57 | OPERATOR crea Request | PASS | R |
| 58 | OWNER no crea Request | PASS | M |
| 59 | SUPPORT no accede Request | PASS | M |
| 60 | Customer inexistente Request | PASS | R: 404 |
| 61 | Item inexistente Request | PASS | R: 404 |
| 62 | numberOfPeople menor que 1 | PASS | DTO reserva |
| 63 | Fecha inválida Request | PASS | DTO reserva |
| 64 | Código Request único | PASS | R: concurrencia y restricción SQL |
| 65 | INCOMPLETE_DATA | PASS | R: completa y vuelve a incompleta |
| 66 | READY_TO_SEND | PASS | R: completa y vuelve a incompleta |
| 67 | CANCELLED Request | PASS | R: cancela idempotentemente |
| 68 | Filtro Request status | PASS | R: filtros combinables |
| 69 | Filtro Request customer | PASS | R: filtros combinables |
| 70 | Filtro Request commercialItem | PASS | R: filtros combinables |
| 71 | Filtro Request channel | PASS | R: filtros combinables |
| 72 | Filtro Request rango | PASS | R: filtros combinables |
| 73 | Paginación Request | PASS | R: filtros combinables |
| 74 | Detalle Request | PASS | R |
| 75 | PATCH Request | PASS | R |
| 76 | Creación manual Reservation ADMIN | PASS | R |
| 77 | Código Reservation único | PASS | R: concurrencia y SQL |
| 78 | Customer válido Reservation | PASS | R |
| 79 | Item válido Reservation | PASS | R |
| 80 | Relación opcional con Request | PASS | R: SQL; POST manual no acepta reservationRequestId |
| 81 | Una reserva por Request | PASS | R: concurrencia constraint 1:0..1 |
| 82 | Filtro Reservation status | PASS | R |
| 83 | Filtro Reservation customer | PASS | R |
| 84 | Filtro Reservation assignedUser | PASS | R: filtros combinables calendario |
| 85 | Rango Reservation | PASS | R: rango semiabierto |
| 86 | Orden reservationAt | PASS | R: rango semiabierto |
| 87 | Detalle Reservation | PASS | R |
| 88 | Calendario día | PASS | R: cierre rango 1 día; API, no UI |
| 89 | Calendario semana | PASS | R: cierre rango 7 días; API, no UI |
| 90 | Calendario mes | PASS | R: cierre rango 31 días en enero; API, no UI |
| 91 | Calendario lista | PASS | R: GET /reservations |
| 92 | dateFrom/dateTo | PASS | R |
| 93 | Rango invertido | PASS | R: 400 |
| 94 | Buscar reserva por code | PASS | R: filtros combinables calendario |
| 95 | Buscar reserva por Customer | PASS | R: filtros combinables calendario |
| 96 | Buscar reserva por teléfono | PASS | R: filtros combinables calendario |
| 97 | ADMIN asigna OPERATOR | PASS | R: asigna OPERATOR/ADMIN |
| 98 | OPERATOR se asigna | PASS | R: toma reservas libres |
| 99 | Responsable inexistente | PASS | R: 404 |
| 100 | Responsable inactivo | PASS | R: 400 |
| 101 | SUPPORT no puede asignarse | PASS | R; M |
| 102 | OWNER no opera | PASS | M |
| 103 | assignedUser en detalle | PASS | R |
| 104 | ADMIN agrega nota | PASS | R |
| 105 | OPERATOR agrega nota | PASS | R |
| 106 | OWNER no agrega nota | PASS | M |
| 107 | SUPPORT no agrega nota | PASS | M |
| 108 | Autor de nota del JWT | PASS | R: notas con autor JWT |
| 109 | Orden notas | PASS | R |
| 110 | Notas no se sobrescriben | PASS | R |
| 111 | Historial conservado | PASS | R: Restrict SQL |
| 112 | Transición válida | PASS | R; reglas reserva |
| 113 | Transición inválida | PASS | PASS: 409 por contrato existente; 400 para valor de estado inválido. No se cambió a 400 |
| 114 | IN_SERVICE | PASS | R: flujo operativo |
| 115 | COMPLETED | PASS | R: flujo operativo |
| 116 | NO_SHOW | PASS | R: flujo operativo |
| 117 | CANCELLED | PASS | R |
| 118 | ADMIN reprograma | PASS | R |
| 119 | OPERATOR reprograma | PASS | R |
| 120 | Nueva fecha válida | PASS | R |
| 121 | Fecha pasada rechazada | PASS | R; DTO |
| 122 | reservationAt actualizada | PASS | R |
| 123 | Estado RESCHEDULED | PASS | R |
| 124 | Historial reprogramación | PASS | R: concurrencia/cadena |
| 125 | Motivo conservado | PASS | R |
| 126 | Cancelar conserva fila | PASS | R |
| 127 | status CANCELLED | PASS | R |
| 128 | Cancelada consultable | PASS | R |
| 129 | Canceladas incluidas por defecto/exclusión explícita | PASS | R: filtros combinables calendario |
