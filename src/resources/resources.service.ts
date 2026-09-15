import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../database/tenant-context.service';
import { CreateResourceDto } from './dto/create-resource.dto';

@Injectable()
export class ResourcesService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(tenantId: string) {
    return this.tenantContext.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `select id, name, type, sena_amount, active
         from resources
         where tenant_id = $1
         order by created_at`,
        [tenantId],
      );
      return rows;
    });
  }

  async create(tenantId: string, dto: CreateResourceDto) {
    return this.tenantContext.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `insert into resources (tenant_id, name, type, sena_amount)
         values ($1, $2, $3, $4)
         returning id, name, type, sena_amount, active`,
        [tenantId, dto.name, dto.type, dto.senaAmount],
      );
      return rows[0];
    });
  }
}
