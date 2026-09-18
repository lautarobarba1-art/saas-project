import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

// Separado de TenantsController (que es público, sin guards) a
// propósito: acá sí hace falta estar logueado. No lleva MembershipGuard
// porque estas rutas no operan sobre un tenant ya conocido — create()
// recién crea el tenant en este mismo request, y mine() es justo cómo
// el usuario se entera a qué tenants pertenece.
@UseGuards(JwtAuthGuard)
@Controller('tenants')
export class TenantsAdminController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateTenantDto) {
    return this.tenants.create(req.user.id, dto);
  }

  @Get('mine')
  mine(@Req() req: AuthenticatedRequest) {
    return this.tenants.listMyTenants(req.user.id);
  }
}
