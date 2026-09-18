import { Pool } from 'pg';
import { randomUUID } from 'crypto';

// Dos pools a propósito: uno admin (postgres, dueño de las tablas,
// bypassea RLS) para armar/limpiar datos de fixture sin pelearse con
// las políticas, y uno "app" (rol app_user, sujeto a RLS) que es el
// que los tests realmente ejercitan — el mismo rol que usa la app en
// producción, no un atajo de test.
export function adminPool(): Pool {
  const url = process.env.TEST_ADMIN_DATABASE_URL;
  if (!url) {
    throw new Error('Falta TEST_ADMIN_DATABASE_URL para correr los tests');
  }
  return new Pool({ connectionString: url, max: 5 });
}

export function appPool(): Pool {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('Falta TEST_DATABASE_URL para correr los tests');
  }
  return new Pool({ connectionString: url, max: 5 });
}

// Todos los nombres/emails de fixture llevan este prefijo — la
// limpieza al final de la suite borra por este patrón en vez de
// trackear ids a mano en cada test.
export const FIXTURE_PREFIX = 'test-fixture';

export async function createTenant(admin: Pool, label: string): Promise<string> {
  const id = randomUUID();
  const slug = `${FIXTURE_PREFIX}-${label}-${id.slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  await admin.query('insert into tenants (id, name, slug) values ($1, $2, $3)', [
    id,
    `${FIXTURE_PREFIX} ${label}`,
    slug,
  ]);
  return id;
}

export async function createUser(admin: Pool, label: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    "insert into users (id, email, password_hash) values ($1, $2, 'x')",
    [id, `${FIXTURE_PREFIX}-${label}-${id.slice(0, 8)}@test.local`],
  );
  return id;
}

export async function createMembership(
  admin: Pool,
  tenantId: string,
  userId: string,
  role: 'owner' | 'staff',
): Promise<void> {
  await admin.query(
    'insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)',
    [tenantId, userId, role],
  );
}

export async function createResource(
  admin: Pool,
  tenantId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into resources (id, tenant_id, name, type, sena_amount)
     values ($1, $2, $3, 'futbol5', 1000)`,
    [id, tenantId, name],
  );
  return id;
}

export async function createBooking(
  admin: Pool,
  tenantId: string,
  resourceId: string,
  startAt: Date,
): Promise<string> {
  const id = randomUUID();
  const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
  await admin.query(
    `insert into bookings (id, tenant_id, resource_id, start_at, end_at, client_name, client_phone)
     values ($1, $2, $3, $4, $5, 'Fixture', '000000000')`,
    [id, tenantId, resourceId, startAt, endAt],
  );
  return id;
}

// Cascada desde tenants (ON DELETE CASCADE en memberships/resources/
// bookings/availability_rules) hace la mayor parte del trabajo — solo
// hace falta borrar tenants y, aparte, los users de prueba (users no
// cuelga de tenants).
export async function cleanupFixtures(admin: Pool): Promise<void> {
  await admin.query('delete from tenants where slug like $1', [
    `${FIXTURE_PREFIX}-%`,
  ]);
  await admin.query('delete from users where email like $1', [
    `${FIXTURE_PREFIX}-%`,
  ]);
}
