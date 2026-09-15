# canchaya-api

Backend del SaaS de reservas. NestJS + pg (sin ORM) + Postgres en Railway.

## Setup
1. `npm install`
2. Crear un servicio de Postgres en Railway, copiar la connection string
   a `.env` (`DATABASE_URL`).
3. Correr `db/schema.sql` contra esa base (psql, o el editor SQL de Railway).
4. `openssl rand -base64 48` para generar `JWT_SECRET` en `.env`.
5. `npm run start:dev`

## Qué hay armado
- Conexión a Postgres + `TenantContextService`: el único punto por donde
  se accede a datos multi-tenant, aplicando `SET LOCAL app.tenant_id`
  antes de cada query (ver comentarios en el archivo).
- Auth con JWT propio (sin passport): `POST /auth/register`,
  `POST /auth/login`.
- `MembershipGuard`: verifica que el usuario logueado pertenezca al
  tenant que aparece en la URL antes de dejarlo pasar.
- Módulo `resources` completo como ejemplo del patrón end-to-end
  (DTO validado -> guard de auth -> guard de membership -> service
  scopeado por tenant -> RLS en la base como última línea de defensa).

## Lo que falta — a propósito, para no revisar todo junto
- **`bookings`**: cálculo de disponibilidad cruzando `availability_rules`
  con reservas activas, creación en estado `pending_payment` con
  `hold_expires_at`, y un job que expire las que no se pagaron a tiempo.
- **`payments`**: integración con el proveedor de pagos (webhook con
  verificación de firma — nunca confiar en un webhook sin validar que
  viene realmente del proveedor).
- **Rate limiting**: no hay nada todavía en `/auth/login` ni en el
  endpoint público de reservas — ambos son blanco fácil de fuerza bruta
  / spam sin esto. Hay que sumarlo antes de producción, no después.
- **Roles**: `MembershipGuard` valida pertenencia al tenant pero no
  diferencia `owner` de `staff` en los permisos — hoy cualquier
  miembro puede todo. Simplificación consciente para el MVP, no un
  olvido.
- **Endpoint público de tenant**: falta el que resuelve un tenant por
  `slug` para el flujo de reserva sin login (el cliente final nunca
  tiene cuenta, como definimos en el modelo de datos).
