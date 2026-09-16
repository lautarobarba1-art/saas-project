import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

// @Roles('owner') restringe la ruta a ese rol. Sin el decorador,
// RolesGuard deja pasar a cualquiera que ya haya pasado MembershipGuard.
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
