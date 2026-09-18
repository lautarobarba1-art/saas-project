-- =====================================================================
-- Schema núcleo: SaaS multi-tenant de reservas
-- Requiere Postgres con la extensión btree_gist (para el constraint
-- de exclusión que impide el doble booking).
-- =====================================================================

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- TENANTS: cada club/negocio que usa la plataforma
-- ---------------------------------------------------------------------
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- USERS: usuarios propios del backend (dueños/staff de clubes).
-- Los clientes finales que reservan NO necesitan fila acá — sus datos
-- de contacto viven directo en bookings (ver más abajo).
-- password_hash se completa con bcrypt/argon2 desde el backend, nunca
-- en texto plano ni con hashing hecho en el cliente.
-- ---------------------------------------------------------------------
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- MEMBERSHIPS: quién administra qué tenant (dueño/staff).
-- Un mismo usuario puede ser miembro de más de un tenant.
-- ---------------------------------------------------------------------
create table memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- ---------------------------------------------------------------------
-- RESOURCES: las canchas (u otro recurso reservable) de cada tenant
-- ---------------------------------------------------------------------
create table resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  type text not null,
  sena_amount integer not null check (sena_amount >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- AVAILABILITY_RULES: horario de apertura recurrente por recurso
-- ---------------------------------------------------------------------
create table availability_rules (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resources(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6), -- 0 = domingo
  start_time time not null,
  end_time time not null,
  check (end_time > start_time)
);

-- ---------------------------------------------------------------------
-- BOOKINGS: el corazón del sistema.
-- status: pending_payment -> confirmed | cancelled | expired
-- hold_expires_at: si pending_payment no se confirma antes de esta hora,
-- un job/cron la pasa a 'expired' y el horario vuelve a estar libre.
--
-- El EXCLUDE constraint es lo que impide el doble booking a nivel de
-- base de datos: ninguna inserción concurrente puede colar un rango de
-- tiempo que se solape con otra reserva activa del mismo recurso, sin
-- importar qué tan rápido lleguen las requests. Esto no se puede
-- garantizar solo con un "SELECT primero, INSERT después" en la app.
-- ---------------------------------------------------------------------
create table bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  resource_id uuid not null references resources(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'confirmed', 'cancelled', 'expired')),
  hold_expires_at timestamptz,
  client_name text not null,
  client_phone text not null,
  created_at timestamptz not null default now(),

  check (end_at > start_at),

  exclude using gist (
    resource_id with =,
    tstzrange(start_at, end_at) with &&
  ) where (status in ('pending_payment', 'confirmed'))
);

create index bookings_tenant_idx on bookings(tenant_id);
create index bookings_resource_start_idx on bookings(resource_id, start_at);

-- ---------------------------------------------------------------------
-- PAYMENTS: separado de bookings porque un pago tiene su propio ciclo
-- de vida (pendiente/aprobado/rechazado) que llega vía webhook async
-- del proveedor, no como parte de la misma transacción de la reserva.
--
-- El índice único parcial sobre provider_payment_id evita procesar el
-- mismo webhook dos veces si el proveedor lo reenvía (idempotencia).
-- ---------------------------------------------------------------------
create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  provider text not null,
  provider_payment_id text,
  amount integer not null check (amount >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create unique index payments_provider_payment_id_uidx
  on payments(provider_payment_id)
  where provider_payment_id is not null;

-- =====================================================================
-- ROW LEVEL SECURITY
--
-- Sin Supabase Auth no hay auth.uid() nativo. El patrón acá es:
-- el backend valida el JWT en su propia capa de aplicación, y al abrir
-- CADA transacción que toca estas tablas, hace:
--
--   SET LOCAL app.tenant_id = '<uuid del tenant ya autorizado>';
--
-- Esto tiene que salir de un único helper central (ej. un middleware
-- o un wrapper de transacción), nunca copiado a mano en cada endpoint
-- — si un endpoint nuevo se olvida de setearlo, current_setting()
-- devuelve null y las políticas de abajo bloquean todo (fallan cerrado,
-- que es el comportamiento correcto), pero el bug hay que detectarlo
-- ahí y no en producción.
--
-- La conexión del pool que ejecuta estas queries NO debe ser la misma
-- que corre migraciones o tareas administrativas con permisos amplios;
-- usá un rol de base de datos separado y con menos privilegios para
-- el tráfico normal de la app.
--
-- Esto no es opcional: Postgres exime al DUEÑO de una tabla de sus
-- propias políticas RLS a menos que se use FORCE ROW LEVEL SECURITY.
-- Si el DATABASE_URL de la app usa el mismo rol que corrió este
-- schema (ej. el "postgres" que da Railway por default), todas las
-- políticas de abajo quedan sin efecto para la app — no hay error,
-- simplemente no aíslan nada. El rol de la app tiene que ser uno
-- nuevo, sin ownership de ninguna tabla:
--
--   create role app_user with login password '<generar uno fuerte>';
--   grant usage on schema public to app_user;
--   grant select, insert, update, delete
--     on all tables in schema public to app_user;
--   alter default privileges in schema public
--     grant select, insert, update, delete on tables to app_user;
--
-- Y el DATABASE_URL de la app apunta a app_user, no al rol admin.
-- =====================================================================

-- Gotcha real de Postgres con conexiones recicladas (pool): una vez que
-- una variable de sesión custom como app.tenant_id se SETEÓ (aunque sea
-- con SET LOCAL, transaccional) una vez en la vida de la conexión,
-- current_setting(..., true) deja de devolver NULL cuando "no está
-- seteada" — devuelve '' (string vacío). Un ::uuid directo sobre eso
-- explota con "invalid input syntax for type uuid". Pasa completamente
-- inadvertido mientras todo el código pase por withTenant() (que
-- siempre pisa su propio valor antes de que se evalúe cualquier
-- policy) — pero en cuanto aparece un patrón que NO setea
-- app.tenant_id (como withUser(), para operaciones cross-tenant) en
-- una conexión reciclada que sí lo tuvo seteado antes, rompe. nullif
-- convierte ese '' a NULL antes del cast, así current_setting sigue
-- comportándose como "no seteada" sin importar el historial de la
-- conexión.
create or replace function app_tenant_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function app_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

alter table tenants enable row level security;
alter table memberships enable row level security;
alter table resources enable row level security;
alter table availability_rules enable row level security;
alter table bookings enable row level security;
alter table payments enable row level security;

-- tenants no se filtra por tenant_id (es la tabla raíz), pero igual
-- lleva RLS activado por consistencia con el resto del schema — sin
-- esta policy, "fail closed" bloquearía incluso la lectura pública.
-- Nombre y slug son públicos por naturaleza (son la landing del club);
-- insert/update/delete quedan sin policy, así que siguen bloqueados
-- para el rol de la app.
create policy "public read"
  on tenants for select
  using (true);

-- Alta de club: cualquier usuario autenticado puede crear un tenant
-- (no hay todavía un tenant_id que validar en ese momento — es el
-- mismo caso borde que la lectura pública). La app exige JwtAuthGuard
-- antes de llegar acá; RLS no puede saber quién está logueado, así que
-- la autorización real de "quién puede crear un club" vive en la capa
-- de aplicación, no en esta policy.
create policy "authenticated create"
  on tenants for insert
  with check (true);

create policy "scoped to current tenant"
  on resources for all
  using (tenant_id = app_tenant_id());

-- Lectura pública de canchas activas, sin tenant context: la página
-- pública de un club (resuelta por slug) necesita listar sus canchas
-- sin que el visitante esté logueado. Postgres combina esta policy con
-- la de arriba por OR (son permisivas): esto solo agrega SELECT sobre
-- filas activas, insert/update/delete siguen exigiendo el tenant_id
-- correcto vía la policy "scoped to current tenant".
create policy "public read active"
  on resources for select
  using (active);

create policy "scoped to current tenant"
  on bookings for all
  using (tenant_id = app_tenant_id());

create policy "scoped to current tenant"
  on memberships for all
  using (tenant_id = app_tenant_id());

-- Un usuario logueado necesita poder ver sus propias memberships
-- across tenants (ej. "a qué clubes pertenezco") sin conocer de
-- antemano ningún tenant_id — withUser() en vez de withTenant() setea
-- app.user_id para este caso puntual. Solo SELECT y solo las propias:
-- insert/update/delete siguen exigiendo el tenant_id correcto vía la
-- policy de arriba.
create policy "own memberships"
  on memberships for select
  using (user_id = app_user_id());

create policy "scoped to current tenant"
  on availability_rules for all
  using (
    exists (
      select 1 from resources r
      where r.id = availability_rules.resource_id
        and r.tenant_id = app_tenant_id()
    )
  );

create policy "scoped to current tenant"
  on payments for all
  using (
    exists (
      select 1 from bookings b
      where b.id = payments.booking_id
        and b.tenant_id = app_tenant_id()
    )
  );

-- NOTA IMPORTANTE: la creación de una reserva por parte de un cliente
-- final (sin cuenta) tiene que pasar por un endpoint server-side que
-- valide disponibilidad, cree el registro y dispare la integración de
-- pago. Ese endpoint público opera "como" el tenant del club que está
-- siendo reservado (lo sabés por la URL/slug, no por un login), así
-- que igual necesita setear app.tenant_id antes de insertar — la
-- diferencia con los endpoints de administración es que ahí no hay
-- usuario logueado que autorizar, solo el tenant de destino.
