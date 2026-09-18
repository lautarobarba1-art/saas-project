import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  InvalidWebhookSignatureError,
  WebhookSignatureValidator,
} from 'mercadopago';
import { TenantContextService } from '../database/tenant-context.service';
import { WhatsAppService } from '../notifications/whatsapp.service';

// Mapea el estado de una order de Mercado Pago a los tres que admite
// payments.status en el schema. "processed" + "accredited" es la única
// combinación que significa "cobrado de verdad" — cualquier otra cosa
// (created, in_process, processed con otro status_detail, ...) se
// trata como no confirmado.
export function mapOrderStatus(order: {
  status?: string;
  status_detail?: string;
}): 'pending' | 'approved' | 'rejected' {
  if (order.status === 'processed' && order.status_detail === 'accredited') {
    return 'approved';
  }
  if (order.status === 'processed') {
    return 'rejected';
  }
  return 'pending';
}

// external_reference tiene un límite de 64 caracteres en la Orders API
// (y no acepta ":") — dos UUIDs con guiones y separador ya son 73. Sacar
// los guiones deja cada UUID en 32 hex chars, 64 en total sin separador
// — se reparte de vuelta por posición fija, no hace falta delimitador.
export function encodeReference(tenantId: string, bookingId: string): string {
  return tenantId.replace(/-/g, '') + bookingId.replace(/-/g, '');
}

export function decodeReference(reference: string): [string, string] | null {
  if (reference.length !== 64) {
    return null;
  }
  const addDashes = (hex: string) =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return [addDashes(reference.slice(0, 32)), addDashes(reference.slice(32))];
}

// Mismo criterio de timezone fijo -03:00 que el resto del proyecto
// (ver BookingsService): Argentina no observa horario de verano desde
// 2009.
export function formatWhenLabel(startAt: Date): string {
  const dayLabel = new Intl.DateTimeFormat('es-AR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(startAt);
  const timeLabel = new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(startAt);
  return `${dayLabel.charAt(0).toUpperCase()}${dayLabel.slice(1)} ${timeLabel}`;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  private get accessToken(): string {
    const token = this.config.get<string>('MERCADOPAGO_ACCESS_TOKEN');
    if (!token) {
      throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');
    }
    return token;
  }

  // Arma el checkout de Mercado Pago para la seña de una reserva ya
  // creada (en pending_payment), usando la Orders API (POST /v1/orders
  // — reemplaza a la vieja /checkout/preferences). El external_reference
  // lleva "tenantId:bookingId" porque el webhook solo nos da el id de
  // la order — sin el tenantId codificado ahí no hay forma de abrir
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

      const amount = Number(booking.sena_amount).toFixed(2);

      const res = await fetch('https://api.mercadopago.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          // Evita crear una order duplicada si el cliente reintenta el
          // request (ej. doble click, retry de red) — MP dedupea por
          // esta key en vez de por el contenido del body.
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          type: 'online',
          processing_mode: 'manual',
          total_amount: amount,
          external_reference: encodeReference(tenantId, bookingId),
          description: `Seña - ${booking.resource_name}`,
          items: [
            {
              title: `Seña - ${booking.resource_name}`,
              unit_price: amount,
              quantity: 1,
            },
          ],
          config: { payment_method: {} },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Mercado Pago rechazó la order: ${res.status} ${body}`);
        throw new Error('No se pudo iniciar el pago con Mercado Pago');
      }

      const order = await res.json();
      return { checkoutUrl: order.checkout_url };
    });
  }

  async handleWebhook(
    dataId: string,
    xSignature: string | undefined,
    xRequestId: string | undefined,
  ) {
    if (!dataId || !xSignature || !xRequestId) {
      throw new BadRequestException('Notificación incompleta');
    }

    const secret = this.config.get<string>('MERCADOPAGO_WEBHOOK_SECRET');
    if (!secret) {
      throw new Error('MERCADOPAGO_WEBHOOK_SECRET no configurado');
    }

    // Validador del SDK oficial en vez de una implementación manual del
    // HMAC — la doc pública de MP ya no detalla el manifest exacto y
    // recomienda usar el SDK; esto evita tener una versión propia que
    // puede desincronizarse silenciosamente si MP ajusta el formato.
    try {
      WebhookSignatureValidator.validate({
        xSignature,
        xRequestId,
        dataId,
        secret,
      });
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        // reason es un enum público (MissingSignatureHeader,
        // MalformedSignatureHeader, MissingTimestamp, MissingHash,
        // SignatureMismatch, TimestampOutOfTolerance) — nunca revela el
        // secret ni el hash, es seguro loguearlo.
        this.logger.warn(
          `Webhook rechazado: ${err.reason} (dataId=${dataId}, xRequestId=${xRequestId})`,
        );
        throw new ForbiddenException('Firma inválida');
      }
      throw err;
    }

    // Este webhook está suscripto a más de un tipo de evento en el
    // panel de MP (además de "Order", también dispara para
    // "Órdenes comerciales"/merchant_order). Un merchant_order id no es
    // un order id — /v1/orders/{id} devuelve 404 para esos, y no es un
    // error real, solo una notificación que no nos interesa procesar.
    const res = await fetch(`https://api.mercadopago.com/v1/orders/${dataId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (res.status === 404) {
      this.logger.log(`${dataId} no es una order (probablemente merchant_order) — ignorado`);
      return;
    }
    if (!res.ok) {
      throw new Error(
        `No se pudo obtener la order ${dataId} de Mercado Pago: ${res.status}`,
      );
    }
    const order = await res.json();

    const decoded = decodeReference(String(order.external_reference ?? ''));
    if (!decoded) {
      this.logger.warn(`Order ${dataId} sin external_reference válido`);
      return;
    }
    const [tenantId, bookingId] = decoded;

    const status = mapOrderStatus(order);
    const providerPaymentId = String(order.id);
    const payment = order.transactions?.payments?.[0];
    const amount = Number(payment?.amount ?? order.total_paid_amount ?? 0);

    await this.tenantContext.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `select b.id, b.status, b.client_name, b.client_phone, b.start_at,
                r.name as resource_name, t.name as tenant_name
         from bookings b
         join resources r on r.id = b.resource_id
         join tenants t on t.id = b.tenant_id
         where b.id = $1 and b.tenant_id = $2`,
        [bookingId, tenantId],
      );
      const booking = rows[0];
      if (!booking) {
        this.logger.warn(`Order ${dataId} referencia una reserva inexistente`);
        return;
      }

      try {
        await client.query(
          `insert into payments (booking_id, provider, provider_payment_id, amount, status, raw_payload)
           values ($1, 'mercadopago', $2, $3, $4, $5)`,
          [
            bookingId,
            providerPaymentId,
            Math.round(amount),
            status,
            JSON.stringify(order),
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

      if (
        status === 'approved' &&
        (booking.status === 'pending_payment' || booking.status === 'expired')
      ) {
        // El caso normal es confirmar un pending_payment. El caso
        // "expired" es un pago aprobado que llegó después de que el
        // cron ya liberó el hold — no debería pasar en uso normal (MP
        // notifica en segundos), pero si pasa, el horario pudo haber
        // quedado libre para que otra persona lo reserve mientras
        // tanto. Intentar confirmar de todas formas: si nadie más lo
        // tomó, el EXCLUDE constraint deja pasar el update tranquilo.
        // Si alguien sí lo tomó, el mismo 23P01 que ya se maneja en
        // bookings.service.ts salta acá — y acá SÍ es una situación
        // real que necesita a alguien mirando (plata cobrada, cancha
        // ocupada por otro), no un 409 más del montón.
        try {
          await client.query(
            `update bookings set status = 'confirmed' where id = $1`,
            [bookingId],
          );
          // Fire-and-forget a propósito: si WhatsApp falla o tarda, no
          // tiene que demorar ni tirar abajo la confirmación del
          // webhook — el pago y la reserva ya quedaron bien, la
          // notificación es un plus, no la fuente de verdad.
          void this.whatsapp.sendBookingConfirmation({
            phone: booking.client_phone,
            clientName: booking.client_name,
            tenantName: booking.tenant_name,
            resourceName: booking.resource_name,
            whenLabel: formatWhenLabel(booking.start_at),
          });
        } catch (err: any) {
          if (err.code === '23P01') {
            this.logger.error(
              `CONFLICTO: pago aprobado (${providerPaymentId}, $${amount}) para booking ${bookingId} ` +
                `que expiró y ya fue ocupado por otra reserva — requiere revisión manual (posible reembolso).`,
            );
          } else {
            throw err;
          }
        }
      }
    });
  }
}
