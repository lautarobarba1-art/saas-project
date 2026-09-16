import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

// Ej: @RateLimit(5, 60_000) = 5 requests por minuto por IP+ruta.
export const RateLimit = (limit: number, windowMs: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowMs });
