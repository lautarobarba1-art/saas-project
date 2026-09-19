import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipGuard } from '../common/membership.guard';
import { AvailabilityRulesService } from './availability-rules.service';
import { CreateAvailabilityRuleDto } from './dto/create-availability-rule.dto';

// Mismo patrón que ResourcesController: autenticar, después validar
// pertenencia al tenant. Cargar horarios es una acción de administración
// del club, no algo que el cliente final toque.
@UseGuards(JwtAuthGuard, MembershipGuard)
@Controller('tenants/:tenantId/resources/:resourceId/availability-rules')
export class AvailabilityRulesController {
  constructor(private readonly availabilityRules: AvailabilityRulesService) {}

  @Get()
  list(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.availabilityRules.list(tenantId, resourceId);
  }

  @Post()
  create(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: CreateAvailabilityRuleDto,
  ) {
    return this.availabilityRules.create(tenantId, resourceId, dto);
  }

  @Patch(':id')
  update(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
    @Param('id') id: string,
    @Body() dto: CreateAvailabilityRuleDto,
  ) {
    return this.availabilityRules.update(tenantId, resourceId, id, dto);
  }

  @Delete(':id')
  remove(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
    @Param('id') id: string,
  ) {
    return this.availabilityRules.remove(tenantId, resourceId, id);
  }
}
