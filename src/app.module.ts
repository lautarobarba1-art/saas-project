import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { ResourcesModule } from './resources/resources.module';
import { TenantsModule } from './tenants/tenants.module';
import { BookingsModule } from './bookings/bookings.module';
import { AvailabilityRulesModule } from './availability-rules/availability-rules.module';
import { PaymentsModule } from './payments/payments.module';
import { WhatsappBotModule } from './whatsapp-bot/whatsapp-bot.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    ResourcesModule,
    TenantsModule,
    BookingsModule,
    AvailabilityRulesModule,
    PaymentsModule,
    WhatsappBotModule,
  ],
})
export class AppModule {}
