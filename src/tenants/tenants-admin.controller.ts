import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

// Separado de TenantsController (que es público, sin guards) a
// propósito: acá sí hace falta estar logueado. No lleva MembershipGuard
// porque el tenant recién se crea en este mismo request — no hay nada
// contra qué validar pertenencia todavía.
@UseGuards(JwtAuthGuard)
@Controller('tenants')
export class TenantsAdminController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateTenantDto) {
    return this.tenants.create(req.user.id, dto);
  }
}
