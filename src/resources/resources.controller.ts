import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipGuard } from '../common/membership.guard';
import { ResourcesService } from './resources.service';
import { CreateResourceDto } from './dto/create-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';

// Orden importa: primero autenticar (¿quién sos?), después autorizar
// (¿pertenecés a este tenant?). MembershipGuard depende de que
// JwtAuthGuard ya haya poblado req.user.
@UseGuards(JwtAuthGuard, MembershipGuard)
@Controller('tenants/:tenantId/resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  list(@Param('tenantId') tenantId: string) {
    return this.resources.list(tenantId);
  }

  @Post()
  create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateResourceDto,
  ) {
    return this.resources.create(tenantId, dto);
  }

  @Patch(':resourceId')
  update(
    @Param('tenantId') tenantId: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: UpdateResourceDto,
  ) {
    return this.resources.update(tenantId, resourceId, dto);
  }
}
