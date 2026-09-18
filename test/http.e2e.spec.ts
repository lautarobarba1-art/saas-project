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
