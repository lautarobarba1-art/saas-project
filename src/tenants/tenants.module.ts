import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantsController } from './tenants.controller';
import { TenantsAdminController } from './tenants-admin.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [AuthModule],
  controllers: [TenantsController, TenantsAdminController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
