import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class TenantsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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
}
