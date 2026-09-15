import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

/**
 * Corre DESPUÉS de JwtAuthGuard (req.user ya tiene que existir).
 * Verifica que el usuario logueado sea miembro del tenant que aparece
 * en el parámetro de ruta :tenantId. Sin este guard, cualquier usuario
 * autenticado podría mandar el UUID de OTRO club en la URL y, si algún
 * endpoint no lo revisa, administrar recursos ajenos — el JWT prueba
 * quién sos, no qué tenant te pertenece.
 */
@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = req.user?.id;
    const tenantId = req.params?.tenantId;

    if (!userId || !tenantId) {
      throw new ForbiddenException('Falta contexto de usuario o tenant');
    }

    const { rows } = await this.pool.query(
      'select role from memberships where tenant_id = $1 and user_id = $2',
      [tenantId, userId],
    );
    if (rows.length === 0) {
      throw new ForbiddenException('No pertenecés a este club');
    }

    req.membership = { role: rows[0].role };
    return true;
  }
}
