import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminBookingsController } from './admin-bookings.controller';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { HoldExpiryService } from './hold-expiry.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [BookingsController, AdminBookingsController],
  providers: [BookingsService, HoldExpiryService],
})
export class BookingsModule {}
