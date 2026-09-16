
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
Deployado en Railway (proyecto `carefree-heart`, servicio `saas-project`
+ `Postgres`), probado end-to-end contra la base real, no solo local.

- `auth`: registro/login con JWT. Funcionando.
- `tenants`: resolución pública por slug (`GET /public/tenants/:slug`)
  y alta de club (`POST /tenants`, autenticado, crea el tenant + la
  membership `owner` en una transacción).
- `resources`: CRUD de canchas, autenticado, scopeado por tenant.
- `availability-rules`: CRUD de horarios de apertura por cancha,
  autenticado.
- `bookings`: cálculo de disponibilidad, creación pública en
  `pending_payment` con hold de 10 min, cron que expira holds vencidos
  cada minuto (itera tenants y usa `withTenant` por cada uno — no hay
  rol con bypass de RLS para hacerlo en una sola query cross-tenant).
- `payments`: integración con Mercado Pago (`POST .../payment-preference`
  crea el checkout, `POST /payments/webhook/mercadopago` recibe la
  notificación, verifica la firma `x-signature` con HMAC-SHA256 antes
  de confiar en nada, y solo ahí vuelve a pedirle el pago a la API de
  MP para actualizar `payments`/`bookings`). Escrito, compila y el
  server lo mapea — **todavía no probado con credenciales reales de
  Mercado Pago** (falta `MERCADOPAGO_ACCESS_TOKEN`,
  `MERCADOPAGO_WEBHOOK_URL` y `MERCADOPAGO_WEBHOOK_SECRET` en Railway).
- Rate limiting propio (sin `@nestjs/throttler`, que todavía no declara
  soporte de peer-dependency para Nest 12) en `/auth/login` (10/min),
  `/auth/register` (5/min) y el endpoint público de reservas
  (30/min disponibilidad, 10/min creación). Ver `src/common/rate-limit.guard.ts`.
  Es en memoria — si el servicio escala a más de una réplica hay que
  moverlo a algo compartido (Redis).
- `main.ts` tiene `app.set('trust proxy', true)`: Railway antepone un
  hop propio y variable en `X-Forwarded-For` antes del cliente real —
  sin esto cualquier rate limiting o lógica por IP queda rota.
- El `DATABASE_URL` de producción usa un rol `app_user` sin ownership
  de tablas (creado a mano, no en `db/schema.sql`) — **no el rol
  `postgres`/dueño de las tablas**, porque Postgres exime al dueño de
  sus propias políticas RLS salvo `FORCE ROW LEVEL SECURITY`. Ver el
  comentario en la sección de RLS de `db/schema.sql` para replicarlo en
  otro ambiente.
- Repo con `overrides` en `package.json` forzando `tar@^7.5.21` (fix de
  seguridad de una dependencia transitiva de `bcrypt`) — no quitarlo
  sin correr `npm audit` de nuevo.

## Lo que falta (a propósito, no un olvido)
- Probar la integración de Mercado Pago de punta a punta con
  credenciales reales (sandbox o cuenta de prueba).
- Diferenciación real de roles `owner` vs `staff` — hoy
  `MembershipGuard` solo valida pertenencia al tenant, no el rol.
- No hay frontend. Todo lo de arriba es solo API — probarlo requiere
  Postman/curl/Insomnia, no un navegador.

## Convenciones
- TypeScript estricto, sin `any` sin justificar.
- Cada módulo: `*.module.ts`, `*.service.ts`, `*.controller.ts`, DTOs
  en `dto/` con validación de `class-validator`.
- Queries SQL parametrizadas siempre — nunca interpolar strings en SQL,
  ni siquiera para valores que "parecen seguros" como un UUID.
- `npm run typecheck` antes de dar cualquier cambio por terminado.
