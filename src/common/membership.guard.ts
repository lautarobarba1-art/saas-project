import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { TenantContextService } from '../database/tenant-context.service';

/**
 * Corre DESPUÉS de JwtAuthGuard (req.user ya tiene que existir).
 * Verifica que el usuario logueado sea miembro del tenant que aparece
 * en el parámetro de ruta :tenantId. Sin este guard, cualquier usuario
 * autenticado podría mandar el UUID de OTRO club en la URL y, si algún
 * endpoint no lo revisa, administrar recursos ajenos — el JWT prueba
 * quién sos, no qué tenant te pertenece.
 *
 * `memberships` tiene RLS activado, así que esta lectura tiene que pasar
 * por TenantContextService igual que cualquier otro dato de tenant — un
 * pool.query() directo acá nunca ve filas (current_setting('app.tenant_id')
 * da null) y termina bloqueando hasta a los miembros legítimos.
 */
@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = req.user?.id;
    const tenantId = req.params?.tenantId;

    if (!userId || !tenantId) {
      throw new ForbiddenException('Falta contexto de usuario o tenant');
    }

    const rows = await this.tenantContext.withTenant(tenantId, (client) =>
      client
        .query(
          'select role from memberships where tenant_id = $1 and user_id = $2',
          [tenantId, userId],
        )
        .then((res) => res.rows),
    );
    if (rows.length === 0) {
      throw new ForbiddenException('No pertenecés a este club');
    }

    req.membership = { role: rows[0].role };
    return true;
  }
}
