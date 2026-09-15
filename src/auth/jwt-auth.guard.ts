import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

// Valida el JWT del header Authorization y deja req.user = { id }
// disponible para el resto de la request. Esto NO valida a qué tenant
// pertenece el usuario — eso lo hace MembershipGuard, a propósito
// separado: autenticación (quién sos) y autorización (qué podés tocar)
// son responsabilidades distintas.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token de autenticación');
    }
    const token = header.slice('Bearer '.length);
    try {
      const payload = await this.jwt.verifyAsync(token);
      req.user = { id: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
