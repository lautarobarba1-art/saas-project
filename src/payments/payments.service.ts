import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { TenantContextService } from '../database/tenant-context.service';

// Mapea los estados de pago de Mercado Pago a los tres que admite
// payments.status en el schema. MP tiene más estados (in_process,
// refunded, charged_back, ...) que no necesitamos distinguir todavía
// — cualquiera que no sea 'approved' se trata como no confirmado.
function mapProviderStatus(mpStatus: string): 'pending' | 'approved' | 'rejected' {
  if (mpStatus === 'approved') return 'approved';
  if (mpStatus === 'rejected' || mpStatus === 'cancelled') return 'rejected';
  return 'pending';
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private get accessToken(): string {
    const token = this.config.get<string>('MERCADOPAGO_ACCESS_TOKEN');
    if (!token) {
      throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');
    }
    return token;
  }

  // Arma el checkout de Mercado Pago para la seña de una reserva ya
  // creada (en pending_payment). El external_reference lleva
  // "tenantId:bookingId" porque el webhook solo nos da un payment id
  // de MP — sin el tenantId codificado ahí no hay forma de abrir
  // withTenant() antes de tocar bookings/payments (que tienen RLS por
  // tenant), y no queremos resolver eso con un rol que bypasee RLS.
  async createPreference(tenantId: string, bookingId: string) {
    return this.tenantContext.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `select b.id, b.status, r.name as resource_name, r.sena_amount
         from bookings b
         join resources r on r.id = b.resource_id
         where b.id = $1 and b.tenant_id = $2`,
        [bookingId, tenantId],
      );
      const booking = rows[0];
      if (!booking) {
        throw new NotFoundException('Reserva no encontrada');
      }
      if (booking.status !== 'pending_payment') {
        throw new BadRequestException('Esta reserva no está esperando pago');
      }

      const notificationUrl = this.config.get<string>(
        'MERCADOPAGO_WEBHOOK_URL',
      );

      const res = await fetch(
        'https://api.mercadopago.com/checkout/preferences',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify({
            items: [
              {
                title: `Seña - ${booking.resource_name}`,
                quantity: 1,
                currency_id: 'ARS',
                unit_price: booking.sena_amount,
              },
            ],
            external_reference: `${tenantId}:${bookingId}`,
            notification_url: notificationUrl,
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Mercado Pago rechazó la preferencia: ${res.status} ${body}`);
        throw new Error('No se pudo iniciar el pago con Mercado Pago');
      }

      const preference = await res.json();
      return { checkoutUrl: preference.init_point };
    });
  }

  // Formato de firma documentado por Mercado Pago: header
  // "x-signature: ts=<timestamp>,v1=<hmac>". El manifest a firmar es
  // "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" — HMAC-SHA256
  // con el secret que Mercado Pago genera al configurar el webhook
  // (no lo elegimos nosotros, sale de su dashboard).
  private verifySignature(
    xSignature: string,
    xRequestId: string,
    dataId: string,
  ): boolean {
    const secret = this.config.get<string>('MERCADOPAGO_WEBHOOK_SECRET');
    if (!secret) {
      throw new Error('MERCADOPAGO_WEBHOOK_SECRET no configurado');
    }

    const parts = Object.fromEntries(
      xSignature
        .split(',')
        .map((p) => p.trim().split('=').map((s) => s.trim())),
    );
    const ts = parts['ts'];
    const v1 = parts['v1'];
    if (!ts || !v1) {
      return false;
    }

    const manifest = `id:${dataId.toLowerCase()};request-id:${xRequestId};ts:${ts};`;
    const expected = createHmac('sha256', secret).update(manifest).digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(v1, 'hex');
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, actualBuf);
  }

  async handleWebhook(
    dataId: string,
    xSignature: string | undefined,
    xRequestId: string | undefined,
  ) {
    if (!dataId || !xSignature || !xRequestId) {
      throw new BadRequestException('Notificación incompleta');
    }
    if (!this.verifySignature(xSignature, xRequestId, dataId)) {
      throw new ForbiddenException('Firma inválida');
    }

    // Nunca confiar en el payload del webhook para el monto/estado —
    // siempre volver a pedirle el recurso a la API de MP con nuestro
    // access token, que es la fuente de verdad.
    const res = await fetch(
      `https://api.mercadopago.com/v1/payments/${dataId}`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
    if (!res.ok) {
      throw new Error(
        `No se pudo obtener el pago ${dataId} de Mercado Pago: ${res.status}`,
      );
    }
    const payment = await res.json();

    const [tenantId, bookingId] = String(
      payment.external_reference ?? '',
    ).split(':');
    if (!tenantId || !bookingId) {
      this.logger.warn(`Pago ${dataId} sin external_reference válido`);
      return;
    }

    await this.tenantContext.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `select id, status from bookings where id = $1 and tenant_id = $2`,
        [bookingId, tenantId],
      );
      const booking = rows[0];
      if (!booking) {
        this.logger.warn(`Pago ${dataId} referencia una reserva inexistente`);
        return;
      }

      try {
        await client.query(
          `insert into payments (booking_id, provider, provider_payment_id, amount, status, raw_payload)
           values ($1, 'mercadopago', $2, $3, $4, $5)`,
          [
            bookingId,
            String(payment.id),
            Math.round(payment.transaction_amount ?? 0),
            mapProviderStatus(payment.status),
            JSON.stringify(payment),
          ],
        );
      } catch (err: any) {
        // 23505 = unique_violation en provider_payment_id: MP ya nos
        // mandó esta notificación antes (reintento). Idempotente, no
        // hay nada más que hacer.
        if (err.code === '23505') {
          return;
        }
        throw err;
      }

      if (payment.status === 'approved' && booking.status === 'pending_payment') {
        await client.query(
          `update bookings set status = 'confirmed' where id = $1`,
          [bookingId],
        );
      }
    });
  }
}
