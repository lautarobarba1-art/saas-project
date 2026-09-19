import type { Request } from 'express';

// main.ts guarda los bytes crudos del body acá antes de parsearlo a
// JSON — hace falta para recalcular el HMAC de X-Hub-Signature-256.
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}
