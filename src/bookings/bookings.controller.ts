import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../common/rate-limit.decorator';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

// Sin JwtAuthGuard/MembershipGuard, a propósito: el cliente final
// reserva sin cuenta. El tenantId viene de haber resuelto antes
// /public/tenants/:slug, y la defensa real contra abuso es el EXCLUDE
// constraint de bookings + la validación de los DTOs, no un login. Ver
// nota en CLAUDE.md. Sí lleva RateLimitGuard: es el endpoint público
// más expuesto a spam/scraping de todo el sistema.
@UseGuards(RateLimitGuard)
@Controller('public/tenants/:tenantId/resources/:resourceId')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @RateLimit(30, 60_000)
  @Get('availability')
  availability(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.bookings.getAvailability(tenantId, resourceId, query.date);
  }

  // Más estricto que la consulta de disponibilidad: cada intento acá
  // compite por un hold real de 10 minutos sobre un horario.
  @RateLimit(10, 60_000)
  @Post('bookings')
  create(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookings.create(tenantId, resourceId, dto);
  }
}
