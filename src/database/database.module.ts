import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { TenantContextService } from './tenant-context.service';

export const PG_POOL = 'PG_POOL';

// Módulo global: el pool y el helper de tenant-context se inyectan en
// cualquier módulo sin tener que reimportar esto en cada uno.
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          connectionString: config.get<string>('DATABASE_URL'),
          max: 10,
        }),
    },
    TenantContextService,
  ],
  exports: [PG_POOL, TenantContextService],
})
export class DatabaseModule {}
