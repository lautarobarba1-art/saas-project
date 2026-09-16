import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

// Sin guards, a propósito: el cliente final reserva sin cuenta. El
// tenantId viene de haber resuelto antes /public/tenants/:slug, y la
// defensa real contra abuso es el EXCLUDE constraint de bookings + la
// validación de los DTOs, no un login. Ver nota en CLAUDE.md.
@Controller('public/tenants/:tenantId/resources/:resourceId')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get('availability')
  availability(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.bookings.getAvailability(tenantId, resourceId, query.date);
  }

  @Post('bookings')
  create(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookings.create(tenantId, resourceId, dto);
  }
}
