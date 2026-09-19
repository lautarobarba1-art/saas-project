import { Injectable } from '@nestjs/common';

interface ConversationState {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  lastActivityAt: number;
}

const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// En memoria, por proceso — mismo criterio y misma limitación que
// RateLimitGuard: alcanza para una sola instancia. Si el servicio
// escala a más de una réplica, esto se pierde entre requests que caen
// en réplicas distintas y hay que moverlo a algo compartido (Redis).
// Se pierde también en cada redeploy, que es aceptable: en el peor
// caso el bot vuelve a preguntar de qué club se trata.
@Injectable()
export class ConversationStateService {
  private readonly byPhone = new Map<string, ConversationState>();

  constructor() {
    setInterval(() => this.sweep(), 30 * 60_000).unref();
  }

  get(phone: string): ConversationState | undefined {
    const state = this.byPhone.get(phone);
    if (!state) return undefined;
    if (Date.now() - state.lastActivityAt > IDLE_TIMEOUT_MS) {
      this.byPhone.delete(phone);
      return undefined;
    }
    return state;
  }

  set(
    phone: string,
    tenant: { id: string; name: string; slug: string },
  ): void {
    this.byPhone.set(phone, {
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      lastActivityAt: Date.now(),
    });
  }

  touch(phone: string): void {
    const state = this.byPhone.get(phone);
    if (state) state.lastActivityAt = Date.now();
  }

  private sweep() {
    const now = Date.now();
    for (const [phone, state] of this.byPhone) {
      if (now - state.lastActivityAt > IDLE_TIMEOUT_MS) {
        this.byPhone.delete(phone);
      }
    }
  }
}
