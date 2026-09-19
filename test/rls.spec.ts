import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { TenantContextService } from '../src/database/tenant-context.service';
import {
  adminPool,
  appPool,
  cleanupFixtures,
  createBooking,
  createMembership,
  createPayment,
  createResource,
  createTenant,
  createUser,
} from './helpers';

// Esta suite existe porque las tres veces que el aislamiento
// multi-tenant se rompió en este proyecto (MembershipGuard usando el
// pool directo, RLS sin forzar porque el rol de la app era el dueño de
// las tablas, y el string vacío que dejaba una conexión reciclada) se
// encontraron probando a mano en producción, no acá. Si alguno de los
// tres vuelve a pasar, esta suite tiene que fallar.
describe('Aislamiento multi-tenant (RLS)', () => {
  let admin: Pool;
  let app: Pool;
  let ctx: TenantContextService;

  beforeAll(() => {
    admin = adminPool();
    app = appPool();
    ctx = new TenantContextService(app);
  });

  afterAll(async () => {
    await cleanupFixtures(admin);
    await admin.end();
    await app.end();
  });

  // bookings, no resources: resources tiene una policy de lectura
  // pública para filas activas (la necesita la página pública de
  // reservas — ver "public read active" en db/schema.sql), así que un
  // resource activo es visible SIN tenant context a propósito. bookings
  // no tiene ninguna excepción así, es el caso puro de aislamiento.
  it('sin SET LOCAL app.tenant_id, no se ve ninguna fila de bookings', async () => {
    const tenantId = await createTenant(admin, 'no-context');
    const resourceId = await createResource(admin, tenantId, 'Cancha');
    await createBooking(admin, tenantId, resourceId, new Date(Date.now() + 86_400_000));

    const client = await app.connect();
    try {
      const { rows } = await client.query(
        'select * from bookings where tenant_id = $1',
        [tenantId],
      );
      expect(rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it('withTenant(A) nunca devuelve bookings de otro tenant B', async () => {
    const tenantA = await createTenant(admin, 'isolation-a');
    const tenantB = await createTenant(admin, 'isolation-b');
    const resourceA = await createResource(admin, tenantA, 'Cancha A');
    const resourceB = await createResource(admin, tenantB, 'Cancha B');
    const when = new Date(Date.now() + 86_400_000);
    await createBooking(admin, tenantA, resourceA, when);
    await createBooking(admin, tenantB, resourceB, when);

    const seenFromA = await ctx.withTenant(tenantA, (client) =>
      client
        .query('select tenant_id from bookings where tenant_id in ($1, $2)', [
          tenantA,
          tenantB,
        ])
        .then((r) => r.rows.map((row) => row.tenant_id)),
    );
    expect(seenFromA).toEqual([tenantA]);

    const seenFromB = await ctx.withTenant(tenantB, (client) =>
      client
        .query('select tenant_id from bookings where tenant_id in ($1, $2)', [
          tenantA,
          tenantB,
        ])
        .then((r) => r.rows.map((row) => row.tenant_id)),
    );
    expect(seenFromB).toEqual([tenantB]);
  });

  // Documenta la excepción a propósito, no un bug: un resource activo
  // tiene que poder leerse sin estar logueado ni tener tenant context
  // (es lo que arma la página pública /:slug del club). Si esto alguna
  // vez deja de pasar, la página pública de reservas se rompe.
  it('un resource activo SÍ es visible sin tenant context (excepción pública a propósito)', async () => {
    const tenantId = await createTenant(admin, 'public-resource');
    await createResource(admin, tenantId, 'Cancha pública');

    const client = await app.connect();
    try {
      const { rows } = await client.query(
        'select name from resources where tenant_id = $1',
        [tenantId],
      );
      expect(rows).toHaveLength(1);
    } finally {
      client.release();
    }
  });

  // Primera vez que el lado admin lee payments (vista de reservas del
  // panel, ver bookings.service.ts#listForTenant) — valida que el join
  // lateral a payments quede scopeado igual que bookings, sin agregar
  // ninguna policy nueva: corre dentro del mismo withTenant, así que la
  // policy existente de payments (que valida vía join a bookings.tenant_id)
  // ya alcanza.
  it('el join a payments del panel de reservas nunca cruza tenants', async () => {
    const tenantA = await createTenant(admin, 'payments-join-a');
    const tenantB = await createTenant(admin, 'payments-join-b');
    const resourceA = await createResource(admin, tenantA, 'Cancha A');
    const resourceB = await createResource(admin, tenantB, 'Cancha B');
    const when = new Date(Date.now() + 86_400_000);
    const bookingA = await createBooking(admin, tenantA, resourceA, when);
    const bookingB = await createBooking(admin, tenantB, resourceB, when);
    await createPayment(admin, bookingA, 'approved', 1000);
    await createPayment(admin, bookingB, 'approved', 2000);

    const rowsFromA = await ctx.withTenant(tenantA, (client) =>
      client
        .query(
          `select b.id, p.amount as payment_amount
           from bookings b
           left join lateral (
             select amount from payments
             where booking_id = b.id order by created_at desc limit 1
           ) p on true
           where b.tenant_id = $1`,
          [tenantA],
        )
        .then((r) => r.rows),
    );
    expect(rowsFromA).toHaveLength(1);
    expect(rowsFromA[0].id).toBe(bookingA);
    expect(rowsFromA[0].payment_amount).toBe(1000);
  });

  it('withUser(A) solo ve las membresías de A, nunca las de B', async () => {
    const tenantId = await createTenant(admin, 'own-memberships');
    const userA = await createUser(admin, 'user-a');
    const userB = await createUser(admin, 'user-b');
    await createMembership(admin, tenantId, userA, 'owner');
    await createMembership(admin, tenantId, userB, 'staff');

    const rows = await ctx.withUser(userA, (client) =>
      client
        .query('select user_id from memberships where tenant_id = $1', [
          tenantId,
        ])
        .then((r) => r.rows),
    );
    expect(rows.map((r) => r.user_id)).toEqual([userA]);
  });

  it('app_user no es dueño de las tablas ni tiene bypassrls', async () => {
    const { rows } = await admin.query(
      "select rolbypassrls from pg_roles where rolname = 'app_user'",
    );
    expect(rows[0]?.rolbypassrls).toBe(false);

    const { rows: owner } = await admin.query(
      "select tableowner from pg_tables where tablename = 'resources'",
    );
    expect(owner[0]?.tableowner).not.toBe('app_user');
  });

  // Regresión directa del bug real: una conexión reciclada del pool
  // que ya pasó por withTenant() dejaba current_setting('app.tenant_id')
  // en '' (no NULL) para la transacción siguiente. Con max:1 forzamos
  // que sea literalmente la misma conexión física la que atienda las
  // dos llamadas, igual que pasa bajo carga real con el pool completo.
  it('una conexión reciclada de withTenant no rompe un withUser posterior', async () => {
    const singleConnPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
    });
    const singleCtx = new TenantContextService(singleConnPool);

    try {
      const tenantId = await createTenant(admin, 'reused-connection');
      const userId = await createUser(admin, 'reused-connection');
      await createMembership(admin, tenantId, userId, 'owner');

      await singleCtx.withTenant(tenantId, (client) => client.query('select 1'));

      const rows = await singleCtx.withUser(userId, (client) =>
        client
          .query(
            `select t.id from memberships m
             join tenants t on t.id = m.tenant_id
             where m.user_id = $1`,
            [userId],
          )
          .then((r) => r.rows),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(tenantId);
    } finally {
      await singleConnPool.end();
    }
  });
});

describe('Prevención de doble reserva (EXCLUDE constraint)', () => {
  let admin: Pool;
  let app: Pool;
  let ctx: TenantContextService;

  beforeAll(() => {
    admin = adminPool();
    app = appPool();
    ctx = new TenantContextService(app);
  });

  afterAll(async () => {
    await cleanupFixtures(admin);
    await admin.end();
    await app.end();
  });

  it('rechaza una reserva que se solapa con otra activa (23P01)', async () => {
    const tenantId = await createTenant(admin, 'double-booking');
    const resourceId = await createResource(admin, tenantId, 'Cancha solapada');

    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    await ctx.withTenant(tenantId, (client) =>
      client.query(
        `insert into bookings (tenant_id, resource_id, start_at, end_at, client_name, client_phone)
         values ($1, $2, $3, $4, 'Cliente 1', '111')`,
        [tenantId, resourceId, start, end],
      ),
    );

    await expect(
      ctx.withTenant(tenantId, (client) =>
        client.query(
          `insert into bookings (tenant_id, resource_id, start_at, end_at, client_name, client_phone)
           values ($1, $2, $3, $4, 'Cliente 2', '222')`,
          [tenantId, resourceId, start, end],
        ),
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('permite reservas del mismo recurso en horarios distintos', async () => {
    const tenantId = await createTenant(admin, 'no-overlap');
    const resourceId = await createResource(admin, tenantId, 'Cancha libre');

    const start1 = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const end1 = new Date(start1.getTime() + 60 * 60 * 1000);
    const start2 = end1;
    const end2 = new Date(start2.getTime() + 60 * 60 * 1000);

    await ctx.withTenant(tenantId, (client) =>
      client.query(
        `insert into bookings (tenant_id, resource_id, start_at, end_at, client_name, client_phone)
         values ($1, $2, $3, $4, 'Cliente 1', '111')`,
        [tenantId, resourceId, start1, end1],
      ),
    );

    await expect(
      ctx.withTenant(tenantId, (client) =>
        client.query(
          `insert into bookings (tenant_id, resource_id, start_at, end_at, client_name, client_phone)
           values ($1, $2, $3, $4, 'Cliente 2', '222')`,
          [tenantId, resourceId, start2, end2],
        ),
      ),
    ).resolves.toBeDefined();
  });
});
