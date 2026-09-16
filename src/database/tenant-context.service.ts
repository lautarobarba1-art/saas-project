import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from './pg-pool.token';

/**
 * TenantContextService es el ÚNICO lugar del código donde se abre una
 * transacción contra el tenant de un negocio. Ningún service debería
 * llamar a pool.query(...) directamente para datos multi-tenant — todo
 * pasa por acá, así el patrón de seguridad no depende de que cada
 * desarrollador (o cada sesión de IA) se acuerde de replicarlo.
 *
 * Qué hace en cada llamada:
 *  1. Pide una conexión dedicada del pool.
 *  2. Abre una transacción.
 *  3. Setea app.tenant_id con SET LOCAL (vía set_config parametrizado,
 *     nunca interpolando el uuid directo en el SQL — eso sería una
 *     inyección SQL esperando pasar).
 *  4. Corre el callback con esa conexión ya "scopeada".
 *  5. Hace COMMIT si todo salió bien, ROLLBACK si algo lanzó una excepción.
 *  6. Libera la conexión siempre, pase lo que pase.
 *
 * Las políticas RLS del schema hacen el resto: si por algún bug se
 * llega a este punto con un tenantId equivocado o vacío, la base
 * simplemente no devuelve filas de otro tenant — no hace falta confiar
 * en que el código de arriba filtró bien.
 */
@Injectable()
export class TenantContextService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async withTenant<T>(
    tenantId: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true)",
        [tenantId],
      );
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
