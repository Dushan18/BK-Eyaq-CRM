# CRM Inteligente EYAQ Systems — Backend

API backend para la gestión de usuarios, autenticación, sesiones y roles del CRM Inteligente de EYAQ Systems.

Actualmente el proyecto cubre el Sprint 1: usuarios, acceso y autorización basada en roles.

## Tecnologías

- NestJS
- TypeScript
- PostgreSQL
- Prisma ORM
- JWT y Passport
- bcrypt
- class-validator
- Jest

## Funcionalidades

### Autenticación

- Inicio de sesión.
- Access tokens JWT.
- Refresh tokens con rotación.
- Refresh tokens almacenados mediante hash SHA-256.
- Sesiones persistidas en PostgreSQL.
- Revocación de sesiones y cierre de sesión.
- Invalidación de access tokens asociados a sesiones revocadas.
- Validación de usuarios activos.

### Roles y autorización

Roles disponibles:

- `ADMIN`
- `OWNER`
- `OPERATOR`
- `SUPPORT`

La autorización se implementa mediante:

- `AccessTokenGuard`
- `RolesGuard`
- Decorador `@Roles(...)`
- Enum `RoleCode` generado por Prisma

### Gestión administrativa de usuarios

Los usuarios con rol `ADMIN` pueden:

- Crear usuarios.
- Listar y consultar usuarios.
- Editar información general.
- Activar o desactivar usuarios.
- Asignar o reemplazar roles.
- Revocar sesiones al desactivar un usuario.

La implementación también controla emails duplicados, evita exponer `passwordHash` y protege al último administrador activo.

## Requisitos

- Node.js
- npm
- PostgreSQL

## Configuración

Copia el archivo de ejemplo:

```bash
cp .env.example .env
```

En Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Variables necesarias:

```env
PORT=3000

DATABASE_URL="postgresql://usuario:password@localhost:5432/crm_eyaq"

JWT_SECRET="reemplazar-por-un-secreto-seguro"
JWT_EXPIRES_IN="15m"

JWT_REFRESH_SECRET="reemplazar-por-otro-secreto-seguro"
JWT_REFRESH_EXPIRES_IN="7d"

ADMIN_EMAIL="admin@eyaq.systems"
ADMIN_PASSWORD="reemplazar-por-una-password-segura"
```

Nunca subas el archivo `.env`, credenciales, tokens o cadenas de conexión reales al repositorio.

## Instalación

Instala las dependencias:

```bash
npm install
```

Genera Prisma Client:

```bash
npx prisma generate
```

Aplica las migraciones en desarrollo:

```bash
npx prisma migrate dev
```

Crea los roles y el administrador inicial:

```bash
npx prisma db seed
```

El seed utiliza operaciones idempotentes para evitar duplicar roles, usuarios o relaciones. Configura una contraseña administrativa segura antes de ejecutarlo.

## Ejecución

Desarrollo:

```bash
npm run start:dev
```

Build:

```bash
npm run build
```

La API utiliza por defecto:

```text
http://localhost:3000
```

## Endpoints

### Autenticación

| Método | Ruta            | Descripción                    |
| ------ | --------------- | ------------------------------ |
| POST   | `/auth/login`   | Iniciar sesión                 |
| POST   | `/auth/refresh` | Renovar tokens                 |
| GET    | `/auth/me`      | Obtener el usuario autenticado |
| POST   | `/auth/logout`  | Revocar la sesión actual       |

### Usuarios

Todos los endpoints requieren un access token válido y el rol `ADMIN`.

| Método | Ruta                | Descripción                  |
| ------ | ------------------- | ---------------------------- |
| POST   | `/users`            | Crear usuario                |
| GET    | `/users`            | Listar usuarios              |
| GET    | `/users/:id`        | Consultar usuario            |
| PATCH  | `/users/:id`        | Editar información general   |
| PATCH  | `/users/:id/status` | Activar o desactivar usuario |
| PATCH  | `/users/:id/roles`  | Reemplazar roles             |

## Ejemplo de autenticación

```http
POST /auth/login
Content-Type: application/json
```

```json
{
  "email": "admin@eyaq.systems",
  "password": "PASSWORD_CONFIGURADA"
}
```

Para consumir rutas protegidas:

```http
Authorization: Bearer ACCESS_TOKEN
```

## Ejemplo de creación de usuario

```http
POST /users
Authorization: Bearer ACCESS_TOKEN_ADMIN
Content-Type: application/json
```

```json
{
  "firstName": "Carlos",
  "lastName": "Quispe",
  "email": "carlos@restaurant.com",
  "password": "Password123!",
  "roles": ["OPERATOR"]
}
```

La respuesta no incluye la contraseña ni su hash.

## Seguridad

- Las contraseñas se almacenan con bcrypt y nunca en texto plano.
- Los refresh tokens se almacenan mediante SHA-256 y son de un solo uso.
- Las sesiones pueden revocarse.
- Los roles actuales se verifican desde PostgreSQL.
- Los DTO rechazan propiedades no declaradas.
- `passwordHash` nunca se incluye en respuestas administrativas.
- La autorización se aplica en el backend y no depende del frontend.
- No es posible desactivar o retirar el rol al último administrador activo.
- La desactivación de un usuario revoca sus sesiones activas.

## Pruebas

Pruebas focalizadas de roles, DTOs y usuarios:

```bash
npx jest src/auth/guards/roles.guard.spec.ts src/dto/create-user.dto.spec.ts src/users/users.service.spec.ts --runInBand
```

Estado actual:

```text
13 pruebas focalizadas aprobadas
```

La suite histórica completa contiene pruebas plantilla pendientes de actualizar y problemas de resolución entre Jest y el cliente Prisma generado.

## Estructura principal

```text
prisma/
├── migrations/
├── schema.prisma
└── seed.ts

src/
├── auth/
├── common/
├── config/
├── database/
├── dto/
├── roles/
├── strategies/
├── users/
├── app.module.ts
└── main.ts
```

## Estado del proyecto

Sprint 1:

- [x] Autenticación
- [x] Refresh tokens
- [x] Sesiones
- [x] Logout
- [x] Roles y autorización
- [x] Gestión administrativa de usuarios
- [ ] Auditoría administrativa
- [ ] Paginación y filtros de usuarios
- [ ] Recuperación y cambio de contraseña

## Antes de publicar o desplegar

- Verifica que `.env` esté ignorado por Git.
- Usa secretos diferentes para access y refresh tokens.
- Configura `ADMIN_PASSWORD` antes de ejecutar el seed.
- Elimina endpoints temporales de prueba.
- Corrige las pruebas históricas pendientes.
- Verifica que el script `start:prod` apunte al artefacto generado por el build.
- No expongas secretos, hashes ni credenciales mediante endpoints o logs.

## Licencia

Software propietario de EYAQ Systems.

No se permite su distribución, modificación o utilización sin autorización expresa.
