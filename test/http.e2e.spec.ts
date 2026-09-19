import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import {
  adminPool,
  cleanupFixtures,
  createMembership,
  createTenant,
  createUser,
  FIXTURE_PREFIX,
} from './helpers';

// Nest lee DATABASE_URL/JWT_SECRET recién cuando arma el módulo —
// tienen que estar seteadas antes de Test.createTestingModule(), no
// alcanza con ponerlas en beforeAll si ese código corre después del
// import de AppModule más abajo.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-not-for-production';

const { AppModule } = await import('../src/app.module');

describe('HTTP end-to-end', () => {
  let app: INestApplication;
  let admin: Pool;

  const email = `${FIXTURE_PREFIX}-http-${randomUUID()}@test.local`;
  const password = 'testpassword123';
  let accessToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mismo pipe global que main.ts — si no lo replico acá, los tests
    // de validación de DTOs estarían probando un comportamiento que la
    // app real no tiene.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    admin = adminPool();
  });

  afterAll(async () => {
    await cleanupFixtures(admin);
    await admin.end();
    await app.close();
  });

  it('POST /auth/register crea un usuario', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it('POST /auth/register con un email repetido devuelve 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login con contraseña incorrecta devuelve 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login con credenciales correctas devuelve un JWT', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    expect(res.status).toBe(201);
    expect(typeof res.body.accessToken).toBe('string');
    accessToken = res.body.accessToken;
  });

  it('una ruta protegida sin token devuelve 401 (JwtAuthGuard)', async () => {
    const res = await request(app.getHttpServer()).get('/tenants/mine');
    expect(res.status).toBe(401);
  });

  it('un token con Bearer inválido también devuelve 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/tenants/mine')
      .set('Authorization', 'Bearer esto-no-es-un-jwt-real');
    expect(res.status).toBe(401);
  });

  it('MembershipGuard rechaza a un usuario logueado que no pertenece al tenant', async () => {
    const tenantId = await createTenant(admin, 'http-membership-no');
    const res = await request(app.getHttpServer())
      .get(`/tenants/${tenantId}/resources`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('MembershipGuard deja pasar a un miembro real del tenant', async () => {
    const tenantId = await createTenant(admin, 'http-membership-ok');
    const {
      rows: [user],
    } = await admin.query('select id from users where email = $1', [email]);
    await createMembership(admin, tenantId, user.id, 'staff');

    const res = await request(app.getHttpServer())
      .get(`/tenants/${tenantId}/resources`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('RolesGuard: un staff no puede sumar miembros al equipo', async () => {
    const tenantId = await createTenant(admin, 'http-roles-staff');
    const {
      rows: [user],
    } = await admin.query('select id from users where email = $1', [email]);
    await createMembership(admin, tenantId, user.id, 'staff');

    const res = await request(app.getHttpServer())
      .post(`/tenants/${tenantId}/memberships`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'nadie@test.local' });
    expect(res.status).toBe(403);
  });

  it('RolesGuard: un owner sí puede sumar miembros al equipo', async () => {
    const tenantId = await createTenant(admin, 'http-roles-owner');
    const {
      rows: [user],
    } = await admin.query('select id from users where email = $1', [email]);
    await createMembership(admin, tenantId, user.id, 'owner');

    const inviteeEmail = `${FIXTURE_PREFIX}-invitee-${randomUUID()}@test.local`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: inviteeEmail, password: 'testpassword123' });

    const res = await request(app.getHttpServer())
      .post(`/tenants/${tenantId}/memberships`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: inviteeEmail });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('staff');
  });

  it('MembershipGuard: GET /tenants/:id/bookings rechaza a quien no pertenece al tenant', async () => {
    const tenantId = await createTenant(admin, 'http-bookings-no');
    const res = await request(app.getHttpServer())
      .get(`/tenants/${tenantId}/bookings`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('un miembro real puede listar y cargar una reserva manual', async () => {
    // Más round-trips a la DB que el resto de la suite (insert de
    // fixture + 2 requests HTTP, cada uno con su propia transacción) —
    // bajo el túnel SSH local a Railway eso puede superar el timeout
    // default de 5s; en CI, contra el Postgres local del job, no hace
    // falta.
    const tenantId = await createTenant(admin, 'http-bookings-ok');
    const {
      rows: [user],
    } = await admin.query('select id from users where email = $1', [email]);
    await createMembership(admin, tenantId, user.id, 'staff');

    const {
      rows: [resource],
    } = await admin.query(
      `insert into resources (tenant_id, name, type, sena_amount)
       values ($1, 'Cancha HTTP', 'futbol5', 1000) returning id`,
      [tenantId],
    );

    const startAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);

    const createRes = await request(app.getHttpServer())
      .post(`/tenants/${tenantId}/bookings`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        resourceId: resource.id,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        clientName: 'Cliente HTTP',
        clientPhone: '+5491100000000',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe('confirmed');

    const listRes = await request(app.getHttpServer())
      .get(`/tenants/${tenantId}/bookings`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].client_name).toBe('Cliente HTTP');
  }, 15_000);

  it('MembershipGuard: PATCH /tenants/:id/resources/:id rechaza a quien no pertenece al tenant', async () => {
    const tenantId = await createTenant(admin, 'http-resource-patch-no');
    const {
      rows: [resource],
    } = await admin.query(
      `insert into resources (tenant_id, name, type, sena_amount)
       values ($1, 'Cancha patch', 'futbol5', 1000) returning id`,
      [tenantId],
    );
    const res = await request(app.getHttpServer())
      .patch(`/tenants/${tenantId}/resources/${resource.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ active: false });
    expect(res.status).toBe(403);
  });

  it('un miembro real puede editar y desactivar una cancha', async () => {
    const tenantId = await createTenant(admin, 'http-resource-patch-ok');
    const {
      rows: [user],
    } = await admin.query('select id from users where email = $1', [email]);
    await createMembership(admin, tenantId, user.id, 'staff');
    const {
      rows: [resource],
    } = await admin.query(
      `insert into resources (tenant_id, name, type, sena_amount)
       values ($1, 'Cancha patch ok', 'futbol5', 1000) returning id`,
      [tenantId],
    );

    const res = await request(app.getHttpServer())
      .patch(`/tenants/${tenantId}/resources/${resource.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Cancha renombrada', active: false });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Cancha renombrada');
    expect(res.body.active).toBe(false);
  });

  it('RolesGuard: un staff no puede sacar miembros del equipo', async () => {
    const tenantId = await createTenant(admin, 'http-remove-staff');
    const {
      rows: [user],
    } = await admin.query('select id from users where email = $1', [email]);
    await createMembership(admin, tenantId, user.id, 'staff');

    const res = await request(app.getHttpServer())
      .delete(`/tenants/${tenantId}/memberships/${user.id}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('un owner puede sacar a un staff del equipo', async () => {
    const tenantId = await createTenant(admin, 'http-remove-owner');
    const {
      rows: [owner],
    } = await admin.query('select id from users where email = $1', [email]);
    await createMembership(admin, tenantId, owner.id, 'owner');
    const staffId = await createUser(admin, 'to-remove');
    await createMembership(admin, tenantId, staffId, 'staff');

    const res = await request(app.getHttpServer())
      .delete(`/tenants/${tenantId}/memberships/${staffId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);

    const { rows } = await admin.query(
      'select 1 from memberships where tenant_id = $1 and user_id = $2',
      [tenantId, staffId],
    );
    expect(rows).toHaveLength(0);
  });

  it('no se puede eliminar al único dueño del club', async () => {
    const tenantId = await createTenant(admin, 'http-remove-last-owner');
    const {
      rows: [owner],
    } = await admin.query('select id from users where email = $1', [email]);
    await createMembership(admin, tenantId, owner.id, 'owner');

    const res = await request(app.getHttpServer())
      .delete(`/tenants/${tenantId}/memberships/${owner.id}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(409);
  });

  it('el rate limit de /auth/login corta después de 10 intentos por minuto', async () => {
    // Al llegar acá ya se gastaron algunos intentos de login más
    // arriba en el mismo archivo (el guard es un contador en memoria
    // por proceso) — 12 intentos más alcanza de sobra para pasar el
    // límite de 10, sin depender de contar exacto cuántos se gastaron
    // antes.
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nadie-rate-limit@test.local', password: 'whatever1' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
