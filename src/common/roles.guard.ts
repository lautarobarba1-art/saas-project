import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

// Corre DESPUÉS de MembershipGuard — depende de que ya haya poblado
// req.membership.role. Sin @Roles() en la ruta, no restringe nada (el
// default es "cualquier miembro del tenant", que es lo que ya
// garantiza MembershipGuard por sí solo).
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedRoles = this.reflector.get<string[] | undefined>(
      ROLES_KEY,
      context.getHandler(),
    );
    if (!allowedRoles || allowedRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const role = req.membership?.role;
    if (!role || !allowedRoles.includes(role)) {
      throw new ForbiddenException('No tenés permisos para esta acción');
    }
    return true;
  }
}
