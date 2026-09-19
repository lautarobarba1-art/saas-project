import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../database/tenant-context.service';
import { WhatsAppService } from '../notifications/whatsapp.service';
import { formatWhenLabel } from '../payments/payments.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { AdminBookingsQueryDto } from './dto/admin-bookings-query.dto';
import { CreateManualBookingDto } from './dto/create-manual-booking.dto';

export interface Interval {
  start: Date;
  end: Date;
}

// Resta los intervalos "busy" (reservas ya tomadas) de un intervalo base
// (una ventana de availability_rules), devolviendo los huecos que quedan
// libres. Puramente aritmético, no toca la base — la disponibilidad real
// la garantiza el EXCLUDE constraint de bookings al momento del insert.
// Exportada (no solo de uso interno) para poder testearla sin DB — es
// la lógica más propensa a bugs sutiles de todo el módulo.
export function subtractBusy(base: Interval, busy: Interval[]): Interval[] {
  let free = [base];
  for (const b of busy) {
    free = free.flatMap((f) => {
      if (b.end <= f.start || b.start >= f.end) return [f];
      const pieces: Interval[] = [];
      if (b.start > f.start) pieces.push({ start: f.start, end: b.start });
      if (b.end < f.end) pieces.push({ start: b.end, end: f.end });
      return pieces;
    });
  }
  return free;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  // Argentina no observa horario de verano desde 2009, así que un offset
  // fijo -03:00 es seguro acá. Si el producto se expande a otro país esto
  // deja de valer y hay que resolver el timezone por tenant.
  private static readonly TZ_OFFSET = '-03:00';

  async getAvailability(tenantId: string, resourceId: string, date: string) {
    return this.tenantContext.withTenant(tenantId, async (client) => {
      const resourceCheck = await client.query(
        `select id from resources where id = $1 and tenant_id = $2 and active`,
        [resourceId, tenantId],
      );
      if (resourceCheck.rows.length === 0) {
        throw new NotFoundException('Cancha no encontrada');
      }

      const dayStart = new Date(`${date}T00:00:00${BookingsService.TZ_OFFSET}`);
      const dayOfWeek = dayStart.getUTCDay();

      const { rows: rules } = await client.query(
        `select start_time, end_time from availability_rules
         where resource_id = $1 and day_of_week = $2
         order by start_time`,
        [resourceId, dayOfWeek],
      );
      if (rules.length === 0) {
        return [];
      }

      const dayEnd = new Date(`${date}T23:59:59.999${BookingsService.TZ_OFFSET}`);
      const { rows: bookings } = await client.query(
        `select start_at, end_at from bookings
         where resource_id = $1
           and status in ('pending_payment', 'confirmed')
           and start_at < $3 and end_at > $2
         order by start_at`,
        [resourceId, dayStart, dayEnd],
      );
      const busy: Interval[] = bookings.map((b) => ({
        start: b.start_at,
        end: b.end_at,
      }));

      const free = rules.flatMap((rule) =>
        subtractBusy(
          {
            start: new Date(`${date}T${rule.start_time}${BookingsService.TZ_OFFSET}`),
            end: new Date(`${date}T${rule.end_time}${BookingsService.TZ_OFFSET}`),
          },
          busy,
        ),
      );

      return free.map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      }));
    });
  }

  async create(tenantId: string, resourceId: string, dto: CreateBookingDto) {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt <= startAt) {
      throw new BadRequestException('endAt debe ser posterior a startAt');
    }
    if (startAt < new Date()) {
      throw new BadRequestException('No se puede reservar un horario pasado');
    }

    return this.tenantContext.withTenant(tenantId, async (client) => {
      const resourceCheck = await client.query(
        `select id from resources where id = $1 and tenant_id = $2 and active`,
        [resourceId, tenantId],
      );
      if (resourceCheck.rows.length === 0) {
        throw new NotFoundException('Cancha no encontrada');
      }

      try {
        const { rows } = await client.query(
          `insert into bookings
             (tenant_id, resource_id, start_at, end_at, client_name, client_phone, hold_expires_at)
           values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')
           returning id, start_at, end_at, status, hold_expires_at`,
          [tenantId, resourceId, startAt, endAt, dto.clientName, dto.clientPhone],
        );
        return rows[0];
      } catch (err: any) {
        // 23P01 = exclusion_violation: el EXCLUDE constraint de bookings
        // detectó un solape con otra reserva activa. Es un 409 esperado,
        // no una excepción rara — puede pasar todo el tiempo bajo carga.
        if (err.code === '23P01') {
          throw new ConflictException('Ese horario ya no está disponible');
        }
        throw err;
      }
    });
  }

  // Vista de reservas para el panel de admin: un día a la vez, con el
  // último estado de pago si lo hay (las reservas manuales no tienen
  // ninguno). El LEFT JOIN LATERAL a payments corre dentro de la misma
  // transacción withTenant, así que la RLS de payments (que valida vía
  // join contra bookings.tenant_id) se aplica igual que en cualquier
  // otro query — no hace falta un rol ni una policy nueva.
  async listForTenant(tenantId: string, query: AdminBookingsQueryDto) {
    return this.tenantContext.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `select b.id, b.resource_id, r.name as resource_name,
                b.start_at, b.end_at, b.status, b.client_name, b.client_phone,
                p.status as payment_status, p.amount as payment_amount
         from bookings b
         join resources r on r.id = b.resource_id
         left join lateral (
           select status, amount from payments
           where booking_id = b.id order by created_at desc limit 1
         ) p on true
         where b.tenant_id = $1
           and ($2::date is null or b.start_at::date = $2::date)
           and ($3::uuid is null or b.resource_id = $3)
           and ($4::text is null or b.status = $4)
         order by b.start_at`,
        [tenantId, query.date ?? null, query.resourceId ?? null, query.status ?? null],
      );
      return rows;
    });
  }

  // Carga manual del staff (teléfono/mostrador): mismas validaciones
  // mínimas que el flujo público (cancha activa, endAt > startAt, no en
  // el pasado), pero entra directo como 'confirmed' — no hay pago que
  // esperar, así que tampoco hay hold de 10 minutos.
  async createManual(tenantId: string, dto: CreateManualBookingDto) {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt <= startAt) {
      throw new BadRequestException('endAt debe ser posterior a startAt');
    }
    if (startAt < new Date()) {
      throw new BadRequestException('No se puede cargar una reserva en el pasado');
    }

    return this.tenantContext.withTenant(tenantId, async (client) => {
      const { rows: resourceRows } = await client.query(
        `select id, name from resources where id = $1 and tenant_id = $2 and active`,
        [dto.resourceId, tenantId],
      );
      const resource = resourceRows[0];
      if (!resource) {
        throw new NotFoundException('Cancha no encontrada');
      }

      const { rows: tenantRows } = await client.query(
        `select name from tenants where id = $1`,
        [tenantId],
      );

      try {
        const { rows } = await client.query(
          `insert into bookings
             (tenant_id, resource_id, start_at, end_at, client_name, client_phone, status)
           values ($1, $2, $3, $4, $5, $6, 'confirmed')
           returning id, start_at, end_at, status`,
          [tenantId, dto.resourceId, startAt, endAt, dto.clientName, dto.clientPhone],
        );
        const booking = rows[0];

        // Fire-and-forget, mismo criterio que en payments.service.ts:
        // la reserva ya quedó confirmada, la notificación es un plus.
        void this.whatsapp.sendBookingConfirmation({
          phone: dto.clientPhone,
          clientName: dto.clientName,
          tenantName: tenantRows[0]?.name ?? '',
          resourceName: resource.name,
          whenLabel: formatWhenLabel(startAt),
        });

        return booking;
      } catch (err: any) {
        if (err.code === '23P01') {
          throw new ConflictException('Ese horario ya no está disponible');
        }
        throw err;
      }
    });
  }
}
