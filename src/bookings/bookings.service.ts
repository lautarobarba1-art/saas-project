import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../database/tenant-context.service';
import { CreateBookingDto } from './dto/create-booking.dto';

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
  constructor(private readonly tenantContext: TenantContextService) {}

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
}
