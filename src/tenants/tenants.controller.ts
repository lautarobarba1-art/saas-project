import { Controller, Get, Param } from '@nestjs/common';
import { TenantsService } from './tenants.service';

// Sin guards: el cliente final reserva sin cuenta, y necesita poder
// resolver "cancha.com/public/tenants/mi-club" a un tenantId antes de
// loguearse (nunca lo hace). Ver nota en CLAUDE.md sobre el flujo
// público de reservas.
@Controller('public/tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.tenants.findBySlug(slug);
  }
}
