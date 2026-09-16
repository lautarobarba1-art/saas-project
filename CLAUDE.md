# Canchaya API — contexto del proyecto

Backend de un SaaS multi-tenant de reservas de canchas deportivas
(fútbol 5, pádel) para clubes en Argentina. Los clientes finales
reservan un horario y pagan una seña obligatoria; los dueños/staff de
cada club administran sus propias canchas y horarios.

## Stack (decidido, no renegociar sin razón real)
- Node.js + TypeScript, framework NestJS
- PostgreSQL gestionado en Railway
- Acceso a datos: `pg` (node-postgres) directo, **sin ORM**. Prisma y
  TypeORM no manejan bien el exclusion constraint ni el patrón de
  `SET LOCAL` que usa este proyecto para aislar tenants — no proponer
  migrar a un ORM.
- Auth: JWT propio vía `@nestjs/jwt`, sin Passport. `bcrypt` para hash
  de contraseñas (12 rounds).
- Validación de input: `class-validator` + `class-transformer`,
  `ValidationPipe` global con `whitelist` y `forbidNonWhitelisted`.

## Arquitectura multi-tenant — la parte que no se puede romper

**Nunca se llega a la base para datos de un tenant sin pasar por
`TenantContextService.withTenant()`** (`src/database/tenant-context.service.ts`).
Ese helper es el único lugar que abre una transacción, hace
`SET LOCAL app.tenant_id` (vía `set_config` parametrizado) y recién ahí
corre queries. Las políticas RLS de `db/schema.sql` dependen de que esa
variable de sesión esté seteada — si un service nuevo usa el `Pool`
directo para tocar `resources`, `bookings`, `memberships`,
`availability_rules` o `payments`, las políticas RLS lo van a bloquear
(o peor, si en algún momento se sacan las políticas "para debuggear",
deja de haber aislamiento entre clubes). La única excepción legítima es
`users` (no tiene RLS por tenant) y la resolución pública de un tenant
por `slug` en `tenants.service.ts`.

**Patrón para cualquier endpoint nuevo que toque datos de un tenant:**
1. `JwtAuthGuard` — quién sos (si el endpoint requiere login).
2. `MembershipGuard` — a qué tenant pertenecés, valida contra
   `:tenantId` de la ruta.
3. El service usa `tenantContext.withTenant(tenantId, cb)`.

Ver `src/resources/` como ejemplo de referencia end-to-end de este
patrón — si el approach de un service nuevo no se parece a ese, algo
está mal.

**Prevención de doble reserva**: es un `EXCLUDE USING gist` constraint
en `bookings` (ver comentarios en `db/schema.sql`), no una validación
en JS. Cualquier lógica de disponibilidad en el código es solo para
mostrarle al usuario qué está libre — la garantía real está en la base.
El código maneja el error `23P01` (exclusion_violation) como un 409
esperado, no como una excepción rara.

**Reservas del cliente final son públicas (sin cuenta)**: pasan por
`public/tenants/:slug` → `public/tenants/:tenantId/resources/:id/bookings`,
sin `JwtAuthGuard`. Esto es intencional, no un agujero de seguridad
— el tenantId viene del slug público, y el `EXCLUDE` constraint +
validación de DTO son la defensa real ahí.

## Estado actual
- `auth`: registro/login con JWT. Funcionando.
- `resources`: CRUD de canchas, autenticado, scopeado por tenant.
- `tenants`: resolución pública por slug.
- `bookings`: cálculo de disponibilidad, creación en `pending_payment`
  con hold de 10 min, cron que expira holds vencidos cada minuto.
- Repo con `overrides` en `package.json` forzando `tar@^7.5.21` (fix de
  seguridad de una dependencia transitiva de `bcrypt`) — no quitarlo
  sin correr `npm audit` de nuevo.

## Lo que falta (a propósito, no un olvido)
- Endpoint para cargar `availability_rules` — sin esto ninguna cancha
  tiene horarios de apertura cargados.
- Integración de pagos (Mercado Pago probable). El webhook TIENE que
  verificar la firma del proveedor antes de mover un booking a
  `confirmed` — nunca confiar en el payload solo porque llegó a la URL
  correcta.
- Rate limiting en `/auth/login`, `/auth/register` y en el endpoint
  público de creación de reservas.
- Diferenciación real de roles `owner` vs `staff` — hoy
  `MembershipGuard` solo valida pertenencia al tenant, no el rol.

## Convenciones
- TypeScript estricto, sin `any` sin justificar.
- Cada módulo: `*.module.ts`, `*.service.ts`, `*.controller.ts`, DTOs
  en `dto/` con validación de `class-validator`.
- Queries SQL parametrizadas siempre — nunca interpolar strings en SQL,
  ni siquiera para valores que "parecen seguros" como un UUID.
- `npm run typecheck` antes de dar cualquier cambio por terminado.
