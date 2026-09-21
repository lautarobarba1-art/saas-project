import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

// Tope diario GLOBAL (no por IP) de consultas al demo del bot en la
// landing — cada una es una llamada real a Claude. El rate limit por
// IP (RateLimitGuard) no alcanza solo: no protege contra tráfico real
// alto ni contra alguien insistiendo desde muchas IPs distintas. Esto
// pone un techo de gasto predecible sin importar cuánta gente lo use.
// 200/día a este volumen de tokens por respuesta es unos pocos
// centavos de costo máximo, con margen de sobra para que la gente
// realmente lo pruebe.
const DAILY_LIMIT = 200;

@Injectable()
export class DemoBudgetGuard implements CanActivate {
  private count = 0;
  private resetAt = this.nextMidnightUTC();

  canActivate(_context: ExecutionContext): boolean {
    const now = Date.now();
    if (now >= this.resetAt) {
      this.count = 0;
      this.resetAt = this.nextMidnightUTC();
    }

    if (this.count >= DAILY_LIMIT) {
      throw new HttpException(
        'El demo del bot alcanzó su límite de uso por hoy — probá de nuevo mañana.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.count += 1;
    return true;
  }

  private nextMidnightUTC(): number {
    const d = new Date();
    d.setUTCHours(24, 0, 0, 0);
    return d.getTime();
  }
}
