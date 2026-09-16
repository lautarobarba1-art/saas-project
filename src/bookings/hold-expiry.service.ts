import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { TenantContextService } from '../database/tenant-context.service';

@Injectable()
export class HoldExpiryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireHolds() {
    // tenants tiene policy de lectura pública, así que este select no
    // necesita tenant-context. La actualización de bookings sí es por
    // tenant: bookings tiene RLS y no existe (a propósito) un rol con
    // bypass para tocar todos los tenants en una sola query — ver nota
    // de roles en db/schema.sql. Si el número de tenants crece mucho,
    // esto es lo primero que hay que resolver con un rol de "sistema"
    // dedicado, no antes.
    const { rows: tenants } = await this.pool.query('select id from tenants');
    for (const tenant of tenants) {
      await this.tenantContext.withTenant(tenant.id, (client) =>
        client.query(
          `update bookings
           set status = 'expired'
           where status = 'pending_payment' and hold_expires_at < now()`,
        ),
      );
    }
  }
}
