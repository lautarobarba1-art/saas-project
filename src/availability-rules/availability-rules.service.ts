import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { TenantContextService } from '../database/tenant-context.service';
import { CreateAvailabilityRuleDto } from './dto/create-availability-rule.dto';

@Injectable()
export class AvailabilityRulesService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(tenantId: string, resourceId: string) {
    return this.tenantContext.withTenant(tenantId, async (client) => {
      await this.assertResourceInTenant(client, tenantId, resourceId);
      const { rows } = await client.query(
        `select id, day_of_week, start_time, end_time
         from availability_rules
         where resource_id = $1
         order by day_of_week, start_time`,
        [resourceId],
      );
      return rows;
    });
  }

  async create(
    tenantId: string,
    resourceId: string,
    dto: CreateAvailabilityRuleDto,
  ) {
    if (dto.endTime <= dto.startTime) {
      throw new BadRequestException('endTime debe ser posterior a startTime');
    }

    return this.tenantContext.withTenant(tenantId, async (client) => {
      await this.assertResourceInTenant(client, tenantId, resourceId);
      const { rows } = await client.query(
        `insert into availability_rules (resource_id, day_of_week, start_time, end_time)
         values ($1, $2, $3, $4)
         returning id, day_of_week, start_time, end_time`,
        [resourceId, dto.dayOfWeek, dto.startTime, dto.endTime],
      );
      return rows[0];
    });
  }

  async remove(tenantId: string, resourceId: string, ruleId: string) {
    return this.tenantContext.withTenant(tenantId, async (client) => {
      await this.assertResourceInTenant(client, tenantId, resourceId);
      const { rows } = await client.query(
        `delete from availability_rules
         where id = $1 and resource_id = $2
         returning id`,
        [ruleId, resourceId],
      );
      if (rows.length === 0) {
        throw new NotFoundException('Horario no encontrado');
      }
    });
  }

  // resources no tiene su propia RLS-por-tenant salteable acá: ya
  // corremos dentro de withTenant, así que esto también sirve para dar
  // un 404 claro en vez de dejar que availability_rules quede "vacío"
  // en silencio si el resourceId no es de este tenant.
  private async assertResourceInTenant(
    client: PoolClient,
    tenantId: string,
    resourceId: string,
  ) {
    const { rows } = await client.query(
      'select id from resources where id = $1 and tenant_id = $2',
      [resourceId, tenantId],
    );
    if (rows.length === 0) {
      throw new NotFoundException('Cancha no encontrada');
    }
  }
}
