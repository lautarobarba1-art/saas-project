import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { TenantContextService } from '../database/tenant-context.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class HoldExpiryService {
  private readonly logger = new Logger(HoldExpiryService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tenantContext: TenantContextService,
    private readonly payments: PaymentsService,
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
      const { rows: expiring } = await this.tenantContext.withTenant(
        tenant.id,
        (client) =>
          client.query(
            `select id from bookings
             where status = 'pending_payment' and hold_expires_at < now()`,
          ),
      );

      for (const booking of expiring) {
        // Antes de liberar el horario, un último chequeo directo contra
        // Mercado Pago por si el webhook nunca llegó a confirmar un pago
        // que en realidad sí se acreditó — ver el comentario en
        // PaymentsService#reconcilePendingBooking. Si esto falla (MP
        // caído, lo que sea), se prefiere seguir con la expiración normal
        // antes que dejar el horario bloqueado para siempre.
        let reconciled = false;
        try {
          reconciled = await this.payments.reconcilePendingBooking(
            tenant.id,
            booking.id,
          );
        } catch (err) {
          this.logger.error(
            `Falló la reconciliación de booking ${booking.id}: ${err instanceof Error ? err.message : err}`,
          );
        }

        if (!reconciled) {
          await this.tenantContext.withTenant(tenant.id, (client) =>
            client.query(
              `update bookings set status = 'expired'
               where id = $1 and status = 'pending_payment'`,
              [booking.id],
            ),
          );
        }
      }
    }
  }
}
