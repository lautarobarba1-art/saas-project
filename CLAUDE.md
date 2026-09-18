
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
- `payments`: integración con Mercado Pago usando la **Orders API**
  (`POST /v1/orders`, no la vieja `/checkout/preferences` — el panel de
  MP empuja a integraciones nuevas hacia esta). `POST .../payment-preference`
  crea la order y devuelve `checkout_url`; `POST /payments/webhook/mercadopago`
  recibe la notificación, valida `x-signature` con
  `WebhookSignatureValidator` del **SDK oficial** (`mercadopago` en
  npm) — no reimplementar el HMAC a mano, la doc pública de MP ya no
  publica el formato exacto del manifest y el SDK es la fuente de
  verdad — y solo ahí vuelve a pedirle la order a la API de MP
  (`GET /v1/orders/:id`) para actualizar `payments`/`bookings`.
  `external_reference` va como `tenantId+bookingId` (32 hex chars cada
  uno, sin separador — el límite de MP es 64 caracteres, con `:` como
  separador se pasa).
  **Probado de punta a punta contra la base real y funcionando**: pago
  con tarjeta de prueba → MP lo acredita → webhook llega, la firma
  valida, se inserta la fila en `payments` con el monto y estado
  correctos. La app en el panel de MP tiene que tener tildado el
  evento **"Order (Mercado Pago)"** (no alcanza con "Órdenes
  comerciales"/merchant_order, que es un recurso distinto y se ignora
  a propósito si llega). Variables en Railway: `MERCADOPAGO_ACCESS_TOKEN`,
  `MERCADOPAGO_WEBHOOK_SECRET` (`MERCADOPAGO_WEBHOOK_URL` es solo
  documentación, la Orders API no la lee en runtime).

  **Ojo con la clave secreta**: Mercado Pago la regenera cada vez que
  se guarda la pantalla "Configurar notificaciones" del webhook, aunque
  no se cambien ni la URL ni los eventos tildados. Si el webhook
  vuelve a devolver 403 después de tocar esa pantalla, sospechar
  primero de un secret desactualizado en Railway antes que del código
  — así se perdió gran parte de una sesión completa de debugging.
  `PaymentsService.handleWebhook` loguea el motivo exacto del rechazo
  (`InvalidWebhookSignatureError.reason`) para diagnosticar esto rápido.

  **Gap conocido, no arreglado todavía**: si el webhook tarda en llegar
  más que el hold de 10 minutos de la reserva (no debería pasar en uso
  normal — MP notifica en segundos), el pago se registra en `payments`
  como `approved` pero la reserva queda `expired` en vez de pasar a
  `confirmed`, porque el código solo confirma si el estado todavía era
  `pending_payment`. No maneja el caso de "revivir" una reserva vencida
  con un pago aprobado tardío.
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

## Roles: owner vs staff
`RolesGuard` + `@Roles('owner')` (`src/common/roles.guard.ts`), mismo
patrón de provider no registrado explícitamente que `MembershipGuard`
— corre después de él porque lee `req.membership.role`. Sin
`@Roles()` en la ruta, cualquier miembro (owner o staff) pasa, que es
el comportamiento por default de siempre.
`GET/POST /tenants/:tenantId/memberships` (`owner` para el POST) —
antes de esto no había NINGUNA forma de sumar un `staff` a un club, la
única membership que existía era la del owner creada junto con el
tenant. `resources`/`availability-rules` siguen abiertos a ambos roles
a propósito — es el trabajo del día a día del staff.

## Lo que falta (a propósito, no un olvido)
- Manejar un pago aprobado que llega después de que la reserva ya
  expiró (ver "Gap conocido" en la sección de `payments` arriba).
- No hay frontend. Todo lo de arriba es solo API — probarlo requiere
  Postman/curl/Insomnia, no un navegador.

## Convenciones
- TypeScript estricto, sin `any` sin justificar.
- Cada módulo: `*.module.ts`, `*.service.ts`, `*.controller.ts`, DTOs
  en `dto/` con validación de `class-validator`.
- Queries SQL parametrizadas siempre — nunca interpolar strings en SQL,
  ni siquiera para valores que "parecen seguros" como un UUID.
- `npm run typecheck` antes de dar cualquier cambio por terminado.
