# Clientes e intereses comerciales

## Preparación

Ejecuta `npm run start:dev`. En Postman configura `baseUrl = http://localhost:3000`, inicia sesión mediante el login existente y guarda el access token en `accessToken`. En cada petición selecciona Authorization → Bearer Token → `{{accessToken}}`. Para cuerpos usa raw → JSON.

ADMIN y OPERATOR pueden escribir y consultar. OWNER solo puede consultar. SUPPORT recibe 403. Sin token válido se devuelve 401; si caduca, renueva el token o inicia sesión nuevamente.

## 1. Crear un cliente

`POST {{baseUrl}}/customers`

```json
{
  "firstName": "Carlos",
  "lastName": "Quispe",
  "phone": "+51 987 654 321",
  "email": "carlos.prueba@example.com",
  "sourceChannel": "WHATSAPP",
  "notes": "Consulta por platos de trucha"
}
```

Esperado: 201, estado NEW y fechas iniciales iguales. Guarda el `id` real como variable `customerId`. Los campos internos `normalizedPhone` y `normalizedEmail` no se exponen.

También puedes enviar un número nacional con `"phone": "987654321", "phoneCountry": "PE"`. No se asume Perú automáticamente. Un teléfono ambiguo sin país solo se conserva si existe un email válido; no se usa como identidad canónica. Se exige al menos un teléfono normalizable o un email válido. Los teléfonos originales conservan su formato, quitando espacios exteriores.

Canales: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER.

## 2. Listar, buscar y consultar

```http
GET {{baseUrl}}/customers?page=1&limit=20
GET {{baseUrl}}/customers?search=Carlos
GET {{baseUrl}}/customers?status=NEW&channel=WHATSAPP
GET {{baseUrl}}/customers?commercialItemId={{itemId}}
GET {{baseUrl}}/customers/{{customerId}}
```

Esperado: 200. El listado contiene `data` y `pagination` (page, limit, total, totalPages). Máximo 100 por página; orden por último contacto descendente y luego id. Puedes combinar filtros. El detalle incluye intereses y el estado actual de cada elemento comercial.

## 3. Editar datos

`PATCH {{baseUrl}}/customers/{{customerId}}`

```json
{
  "firstName": "Carlos Alberto",
  "notes": "Prefiere atención por correo"
}
```

Esperado: 200. Omitir un campo lo conserva; `null` borra un campo opcional; cadenas vacías se rechazan. No puedes borrar el último contacto válido. Al reemplazar un teléfono nacional, envía también su país: el país anterior no se hereda para un número nuevo. Borrar el teléfono borra su país.

La edición general no cambia firstContactAt/lastContactAt. No acepta status, fechas ni campos normalizados. Un cuerpo vacío devuelve 400.

## 4. Cambiar estado

`PATCH {{baseUrl}}/customers/{{customerId}}/status`

```json
{ "status": "INTERESTED" }
```

Esperado: 200. Estados: NEW, INTERESTED, IN_CONVERSATION, REQUESTED_RESERVATION, CONFIRMED, REJECTED, LOST, RECURRENT. Cambiar el estado no crea una reserva ni modifica las fechas de contacto.

## 5. Registrar o reiterar interés

Obtén un UUID real del catálogo comercial y guárdalo como `itemId`; no envíes un texto como `UUID_DEL_PLATO`.

`POST {{baseUrl}}/customers/{{customerId}}/interests`

```json
{
  "commercialItemId": "{{itemId}}",
  "notes": "Consultó disponibilidad y precio"
}
```

Esperado: 200 tanto al crear como al reiterar. Repite la petición: conserva el mismo interés y firstInterestedAt, y actualiza lastInterestedAt y el último contacto del cliente. Omitir notes conserva la nota anterior; null la borra.

Se permite registrar interés en elementos inactivos o pendientes de aprobación. Esto no los publica ni aprueba. Desactivar un elemento comercial no elimina el interés histórico. El detalle expone isActive y approvalStatus del elemento.

## 6. Quitar interés

`DELETE {{baseUrl}}/customers/{{customerId}}/interests/{{itemId}}`

Esperado: 204 sin cuerpo. Repetir devuelve 404. Solo borra la relación: conserva cliente y elemento comercial. No existe eliminación de clientes en este módulo.

## 7. Casos negativos

- Repite creación con el mismo email en mayúsculas o el mismo teléfono con otro formato: 409.
- Crea sin teléfono/email, con email inválido o país inexistente: 400.
- Intenta borrar ambos contactos mediante PATCH: 400.
- Envía UUID mal formado: 400; UUID válido inexistente: 404.
- Envía estado/canal inventado o campos internos: 400.
- Usa OWNER: GET funciona; POST/PATCH/DELETE devuelven 403.
- Usa SUPPORT: todos devuelven 403.
- Retira Authorization: 401.

## Integración interna y pruebas automatizadas

`CustomersService.findOrCreateByContact` y `touchLastContact` son métodos internos, no endpoints públicos. El primero reutiliza identidad canónica, no fusiona perfiles y devuelve conflicto si los contactos identifican clientes distintos. El segundo no retrocede fechas ni admite fechas futuras. Ninguno conecta todavía WhatsApp, conversaciones o reservas.

```powershell
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand
```

Las pruebas PostgreSQL se habilitan explícitamente. Usan TEST_DATABASE_URL o, si no está definida, DATABASE_URL como conexión administrativa. Requieren permiso para crear bases. Crean una base aleatoria `crm_customers_test_*`, aplican las migraciones, ejecutan pruebas y eliminan exclusivamente esa base. No insertan pruebas en las tablas de tu base habitual. Usa un servidor local/de pruebas, no producción.

```powershell
$env:CUSTOMERS_INTEGRATION = '1'
try {
  npm run test:e2e -- --runInBand --runTestsByPath test/customers.integration.e2e-spec.ts
} finally {
  Remove-Item Env:CUSTOMERS_INTEGRATION -ErrorAction SilentlyContinue
}
```

Estas pruebas cubren validación, permisos del controlador con autenticación simulada, restricciones SQL y concurrencia real. Las pruebas de autenticación existentes se ejecutan por separado; verifica también los permisos en Postman con JWT reales.

La migración `20260915053758_add_customers_and_interests` agrega clientes, intereses, enums, índices únicos, claves foráneas y restricciones de contacto/fechas. No elimina datos existentes. Auditoría funcional y conexión con conversaciones/reservas quedan pendientes.
