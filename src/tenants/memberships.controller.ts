import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipGuard } from '../common/membership.guard';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { TenantsService } from './tenants.service';
import { AddMembershipDto } from './dto/add-membership.dto';

// Orden de guards importa: JwtAuthGuard puebla req.user, MembershipGuard
// puebla req.membership (y valida pertenencia al tenant), recién ahí
// RolesGuard puede mirar req.membership.role.
@UseGuards(JwtAuthGuard, MembershipGuard, RolesGuard)
@Controller('tenants/:tenantId/memberships')
export class MembershipsController {
  constructor(private readonly tenants: TenantsService) {}

  // Sin @Roles(): cualquier miembro (owner o staff) puede ver el
  // equipo del club.
  @Get()
  list(@Param('tenantId') tenantId: string) {
    return this.tenants.listMembers(tenantId);
  }

  // Solo el owner suma gente nueva — dejar que cualquier staff invite
  // más staff abre una cadena sin control real de quién entra al club.
  @Roles('owner')
  @Post()
  add(
    @Param('tenantId') tenantId: string,
    @Body() dto: AddMembershipDto,
  ) {
    return this.tenants.addMember(tenantId, dto);
  }

  // Solo el owner saca gente del equipo — mismo criterio que sumar.
  // tenants.service.ts#removeMember además bloquea sacar al último
  // owner, para que un club nunca quede sin nadie que pueda administrarlo.
  @Roles('owner')
  @Delete(':userId')
  remove(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
  ) {
    return this.tenants.removeMember(tenantId, userId);
  }
}
