import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { TenantContextService } from '../database/tenant-context.service';
import { CreateTenantDto } from './dto/create-tenant.dto';

@Injectable()
export class TenantsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Pool directo, sin withTenant(): todavía no hay tenant_id que setear,
  // es justo lo que este método resuelve. La policy "public read" de
  // tenants permite el select sin SET LOCAL — es la excepción legítima
  // que documenta CLAUDE.md, no un atajo para copiar en otro service.
  async findBySlug(slug: string) {
    const { rows } = await this.pool.query(
      'select id, name, slug from tenants where slug = $1',
      [slug],
    );
    const tenant = rows[0];
    if (!tenant) {
      throw new NotFoundException('Club no encontrado');
    }
    return tenant;
  }

  // El id se genera acá, no en la base (sin `default gen_random_uuid()`
  // devuelto por el insert primero), para poder usar withTenant() desde
  // el arranque: hace falta un tenant_id ya definido antes de abrir la
  // transacción y setear app.tenant_id, así el insert en memberships
  // (que sí tiene RLS por tenant) queda cubierto igual que cualquier
  // otro dato de tenant, sin agregar otra excepción al patrón.
  async create(userId: string, dto: CreateTenantDto) {
    const tenantId = randomUUID();

    return this.tenantContext.withTenant(tenantId, async (client) => {
      try {
        await client.query(
          'insert into tenants (id, name, slug) values ($1, $2, $3)',
          [tenantId, dto.name, dto.slug],
        );
      } catch (err: any) {
        if (err.code === '23505') {
          throw new ConflictException('Ese slug ya está en uso');
        }
        throw err;
      }

      await client.query(
        `insert into memberships (tenant_id, user_id, role)
         values ($1, $2, 'owner')`,
        [tenantId, userId],
      );

      return { id: tenantId, name: dto.name, slug: dto.slug };
    });
  }
}
