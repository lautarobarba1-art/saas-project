import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipGuard } from '../common/membership.guard';
import { BookingsService } from './bookings.service';
import { AdminBookingsQueryDto } from './dto/admin-bookings-query.dto';
import { CreateManualBookingDto } from './dto/create-manual-booking.dto';

// Mismo patrón de guards que resources/availability-rules: cualquier
// miembro del tenant (owner o staff) puede ver y cargar reservas, es
// trabajo del día a día, no una acción sensible que requiera @Roles.
@UseGuards(JwtAuthGuard, MembershipGuard)
@Controller('tenants/:tenantId/bookings')
export class AdminBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  list(
    @Param('tenantId') tenantId: string,
    @Query() query: AdminBookingsQueryDto,
  ) {
    return this.bookings.listForTenant(tenantId, query);
  }

  @Post()
  createManual(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateManualBookingDto,
  ) {
    return this.bookings.createManual(tenantId, dto);
  }
}
