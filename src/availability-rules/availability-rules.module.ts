import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AvailabilityRulesController } from './availability-rules.controller';
import { AvailabilityRulesService } from './availability-rules.service';

@Module({
  imports: [AuthModule],
  controllers: [AvailabilityRulesController],
  providers: [AvailabilityRulesService],
})
export class AvailabilityRulesModule {}
