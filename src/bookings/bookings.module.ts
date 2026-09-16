import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { HoldExpiryService } from './hold-expiry.service';

@Module({
  controllers: [BookingsController],
  providers: [BookingsService, HoldExpiryService],
})
export class BookingsModule {}
