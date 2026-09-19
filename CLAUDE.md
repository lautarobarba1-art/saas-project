
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
  `PATCH /tenants/:tenantId/resources/:resourceId` permite editar
  nombre/tipo/seña y activar/desactivar (`active`) sin borrar la
  cancha — todos los campos son opcionales, se actualizan con
  `coalesce` para no pisar lo que no vino en el body.
- `availability-rules`: CRUD de horarios de apertura por cancha,
  autenticado. `PATCH .../availability-rules/:id` es un reemplazo
  completo de día/desde/hasta (no un merge parcial), mismo DTO que el
  `POST`.
- `bookings`: cálculo de disponibilidad, creación pública en
  `pending_payment` con hold de 10 min, cron que expira holds vencidos
  cada minuto (itera tenants y usa `withTenant` por cada uno — no hay
  rol con bypass de RLS para hacerlo en una sola query cross-tenant).
  El lado admin (`GET`/`POST /tenants/:tenantId/bookings`,
  `AdminBookingsController`) es aparte del público: hasta que se
  agregó, el club no tenía NINGUNA forma de ver sus propias reservas
  ni pagos salvo mirando la base a mano. `GET` trae un día a la vez
  (`?date=YYYY-MM-DD`, más `resourceId`/`status` opcionales) con el
  último estado de pago vía `LEFT JOIN LATERAL` a `payments` — corre
  dentro del mismo `withTenant`, así que la RLS de `payments` lo
  scopea igual que cualquier otro query, sin policy nueva. `POST` es
  la carga manual del staff (teléfono/mostrador): mismas validaciones
  mínimas que el flujo público (cancha activa, horario futuro), pero
  entra directo como `confirmed` — sin pasar por Mercado Pago, sin
  hold de 10 minutos — y dispara la misma confirmación de WhatsApp que
  un pago aprobado (fire-and-forget, mismo criterio que en
  `payments.service.ts`).
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

  **Pago tardío sobre una reserva ya expirada**: si el webhook llega
  después de que el cron ya liberó el hold de 10 minutos (no debería
  pasar en uso normal — MP notifica en segundos), el código igual
  intenta confirmar la reserva `expired`. Si nadie ocupó ese horario
  mientras tanto, pasa a `confirmed` igual que siempre. Si alguien sí
  lo tomó, el `EXCLUDE` constraint lo bloquea (23P01) y queda logueado
  como error para revisión manual — plata cobrada por un horario que
  ahora es de otra reserva no es algo para resolver solo en el código.
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
`DELETE /tenants/:tenantId/memberships/:userId` también es `owner`
(mismo criterio que sumar) y bloquea sacar al último owner del club
(`tenants.service.ts#removeMember` cuenta owners restantes antes de
borrar, `ConflictException` si quedaría en cero) — un club nunca puede
quedar sin nadie que pueda administrarlo.

## Notificaciones por WhatsApp
`src/notifications/whatsapp.service.ts` — WhatsApp Cloud API de Meta
directo (sin Twilio/BSP). Se dispara desde `PaymentsService` apenas un
pago aprobado confirma una reserva, `fire-and-forget` (nunca se espera
ni se deja que rompa el webhook si falla).

- El mensaje tiene que salir de un **template pre-aprobado por Meta**
  (`canchaya_reserva_confirmada`, `es_AR`, categoría UTILITY) — no se
  puede mandar texto libre como primer mensaje del negocio. Si hay que
  cambiar el contenido, hay que crear un template nuevo (con otro
  nombre) y esperar aprobación de nuevo, no se edita uno ya aprobado.
- **El WhatsApp Business Account (WABA) está compartido con otro
  negocio existente del usuario (Menesteres)** — mismo número, misma
  cuenta. Ya había un template llamado `reserva_confirmada` de ese otro
  negocio (con variables de "Clase"/"Cupos" que no aplican acá), por
  eso el nombre de este es `canchaya_reserva_confirmada`. Si algún día
  hace falta separar esto en un número de WhatsApp Business propio de
  Canchaya, es una migración de infraestructura en Meta, no un cambio
  de código.
- Variables en Railway: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`
  (**token permanente**, generado desde un usuario del sistema
  `canchaya-api` en Business Settings de Meta con expiración "Nunca" —
  el temporal de 24hs que se usó al principio ya expiró una vez en
  producción, por eso se migró), `WHATSAPP_BUSINESS_ACCOUNT_ID`.
- El número de `WHATSAPP_PHONE_NUMBER_ID` hoy es el **número de prueba
  gratuito** que da Meta (no un número real del negocio) — a
  propósito, no un olvido. Un número de prueba solo puede mandarle
  WhatsApp a destinatarios cargados a mano en una lista de permitidos
  en el panel de Meta, nunca a un cliente real cualquiera. Migrar a un
  número real de producción (Meta for Developers > Cancha ya > Casos
  de uso > Conectar con los clientes a través de WhatsApp > Paso 2.
  Configuración de producción) queda pendiente hasta que haya un
  cliente real interesado — se evaluó usar el número personal del
  dueño, pero registrar un número para la API de WhatsApp Business lo
  desconecta de la app de WhatsApp normal en el celular, así que no se
  hizo con el número de uso diario. Cuando haga falta, definir si se
  dedica un número nuevo o se acepta ese trade-off con uno existente.
- El teléfono se normaliza sacando todo lo que no sea dígito
  (`booking.client_phone.replace(/[^0-9]/g, '')`) y se manda tal cual a
  la API — no se intenta adivinar ni insertar el prefijo `54`/`9` de
  Argentina. Si el cliente cargó el teléfono en un formato raro, el
  envío falla silenciosamente (queda logueado, no rompe nada), no hay
  reintento ni aviso al club todavía.

## Bot de WhatsApp (consultas entrantes)
`src/whatsapp-bot/` — a diferencia de `notifications/whatsapp.service.ts`
(que solo manda, nunca recibe), este módulo atiende mensajes que los
clientes le escriben al número de WhatsApp del negocio y responde
preguntas de disponibilidad general, horarios y precio.

- `POST /whatsapp/webhook` recibe los mensajes entrantes; `GET` en la
  misma ruta es el handshake de verificación que hace Meta una sola
  vez al registrar la URL en el panel. Público a propósito (lo llama
  Meta, no un usuario), la defensa es la firma `X-Hub-Signature-256`
  (HMAC-SHA256 con `WHATSAPP_APP_SECRET` sobre el body crudo del
  request — por eso `main.ts` desactiva el body-parser default de Nest
  y usa uno propio que guarda los bytes originales en `req.rawBody`
  antes de parsear a JSON, si no esos bytes se pierden y no se puede
  recalcular el HMAC).
- **Identificación del club**: el número de WhatsApp es UNO SOLO,
  compartido entre todos los tenants de Canchaya (y con Menesteres) —
  no hay forma de saber de qué club se trata solo por el número. La
  página pública de cada club (`/slug` en canchaya-web) tiene un link
  "Consultanos por WhatsApp" que precarga el mensaje con
  `(ref:<slug>)` al final — el bot lo lee de ahí, es un dato exacto,
  no depende de que la persona escriba bien el nombre. Si alguien
  escribe sin pasar por ese link, el bot intenta interpretar el
  mensaje mismo como el slug del club; si no reconoce nada, pregunta
  directamente en vez de adivinar. Una vez identificado, se guarda en
  `ConversationStateService` (en memoria, por teléfono, 2hs de
  inactividad — misma limitación de una sola instancia que
  `RateLimitGuard`, documentada ahí).
- **Cómo responde**: nunca inventa datos. Junta las canchas activas del
  club + sus horarios semanales (`resources`/`availability_rules`, vía
  `withTenant` como cualquier otro query) y se los pasa como contexto a
  Claude (`claude-haiku-4-5-20251001`, vía `ANTHROPIC_API_KEY`) junto
  con la pregunta — el modelo solo puede responder con esos datos, y si
  la pregunta requiere disponibilidad exacta de un día puntual (con
  reservas ya tomadas descontadas), lo dice y manda el link de reservas
  (`WEB_APP_URL/slug`) en vez de intentar calcularlo — esa lógica ya
  existe en `BookingsService.getAvailability` y no se duplicó acá.
- Las respuestas son texto libre (`WhatsAppService.sendFreeText`), no
  template — válido porque es una respuesta dentro de la ventana de
  24hs desde que el cliente escribió primero, no un mensaje que inicia
  el negocio (eso sigue yendo por template, ver la sección de
  notificaciones arriba).
- Variables nuevas en Railway: `WHATSAPP_APP_SECRET` (Meta for
  Developers > la app > Configuración básica), `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
  (lo elegimos nosotros, se pega también en el panel de webhooks de
  Meta), `ANTHROPIC_API_KEY`, `WEB_APP_URL`.
- Pendiente de probar de punta a punta contra un mensaje real de
  WhatsApp — construido y deployado, pero la primera prueba real
  requiere completar la configuración del webhook en el panel de Meta
  con la URL + verify token.

## Lo que falta (a propósito, no un olvido)
- Migrar `WHATSAPP_PHONE_NUMBER_ID` de número de prueba a uno real de
  producción — ver la nota en la sección de WhatsApp arriba. Bloqueado
  a propósito hasta que haya un cliente real, no técnicamente.
- Frontend público (`canchaya-web`, repo aparte) ya cubre reservas y
  panel de administración — lo que falta ahí es propio de ese repo, no
  de esta API.

## Tests
`vitest`, no `jest` — se probó jest primero y no arrancó: `@nestjs/common`
en esta versión es un paquete 100% ESM (`"type": "module"`, sin build
CJS), y el motor de módulos propio de Jest no sabe cargar eso aunque
Node 25 sí soporte `require()` nativo de ESM (por eso la app compilada
corre bien con `node dist/main.js` pero jest tiraba "Must use import to
load ES Module"). Vitest lo resuelve sin config especial.

`test/rls.spec.ts` son tests de integración contra una base de test
real — no mocks de `pg`, a propósito: los tres bugs de seguridad reales
de este proyecto (guard con pool directo, RLS sin forzar, string vacío
en conexión reciclada) solo aparecían con Postgres de verdad, un mock
los hubiera dejado pasar igual. `test/helpers.ts` arma fixtures con un
pool "admin" (rol `postgres`, bypassea RLS) y los tests ejercitan un
pool "app" (rol `app_user`, el mismo que corre en producción).

Variables necesarias para correr `npm test` local: `TEST_ADMIN_DATABASE_URL`
(rol con permisos para crear el schema) y `TEST_DATABASE_URL` (rol
`app_user`, sin ownership de las tablas — si se usa el rol admin acá,
los tests de RLS pasan igual sin probar nada real). CI
(`.github/workflows/ci.yml`) levanta un Postgres descartable por job y
arma ambos roles desde cero en cada corrida, no depende de Railway.

Cobertura actual (41 tests, 4 archivos):
- `test/rls.spec.ts` — aislamiento multi-tenant y el EXCLUDE constraint
  de bookings (contra Postgres real, ver arriba), incluye el join a
  `payments` del panel de reservas admin.
- `test/bookings-availability.spec.ts`, `test/payments-logic.spec.ts`
  — funciones puras sin DB (`subtractBusy`, `mapOrderStatus`,
  `encodeReference`/`decodeReference`, `formatWhenLabel` — exportadas
  desde sus services solo para poder testearlas sueltas).
- `test/http.e2e.spec.ts` — capa HTTP completa vía
  `Test.createTestingModule({imports: [AppModule]})` + `supertest`,
  el `AppModule` real (no uno recortado), así que guards no
  registrados explícitamente como provider (`MembershipGuard`,
  `RolesGuard`, `RateLimitGuard`) se resuelven exactamente igual que en
  producción. Cubre auth, `JwtAuthGuard`, `MembershipGuard`,
  `RolesGuard` (incluyendo el panel admin: reservas, `PATCH` de
  resources, `DELETE` de memberships y el resguardo del último owner),
  y que el rate limit de `/auth/login` corte de verdad.

Lo que todavía no tiene test: el webhook de Mercado Pago de punta a
punta (createPreference/handleWebhook con la Orders API real — hoy
solo están testeadas las funciones puras que usan), disponibilidad de
`availability-rules` vía HTTP, y WhatsApp (no tiene ningún test, ni
siquiera del payload que arma).

## Convenciones
- TypeScript estricto, sin `any` sin justificar.
- Cada módulo: `*.module.ts`, `*.service.ts`, `*.controller.ts`, DTOs
  en `dto/` con validación de `class-validator`.
- Queries SQL parametrizadas siempre — nunca interpolar strings en SQL,
  ni siquiera para valores que "parecen seguros" como un UUID.
- `npm run typecheck` y `npm test` antes de dar cualquier cambio por
  terminado.
