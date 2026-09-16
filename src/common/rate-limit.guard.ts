import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY, RateLimitOptions } from './rate-limit.decorator';

interface Bucket {
  count: number;
  resetAt: number;
}

// Contador en memoria, por proceso: alcanza para cómo corre hoy el
// servicio en Railway (una sola instancia). Si en algún momento se
// escala a más de un replica, cada una cuenta aparte y el límite real
// pasa a ser limit * replicas — ahí hay que mover esto a algo
// compartido (Redis), no antes.
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly reflector: Reflector) {
    // Barrido periódico para no acumular entradas de IPs que ya
    // vencieron y no van a volver a pegarle a la ruta.
    setInterval(() => this.sweep(), 5 * 60_000).unref();
  }

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.get<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!options) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const key = `${context.getClass().name}.${context.getHandler().name}:${ip}`;

    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return true;
    }

    if (bucket.count >= options.limit) {
      throw new HttpException(
        'Demasiadas solicitudes, probá de nuevo en un momento',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
    return true;
  }

  private sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
