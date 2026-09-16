import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantsController } from './tenants.controller';
import { TenantsAdminController } from './tenants-admin.controller';
import { MembershipsController } from './memberships.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [AuthModule],
  controllers: [TenantsController, TenantsAdminController, MembershipsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
