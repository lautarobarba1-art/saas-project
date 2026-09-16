import { Controller, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Público a propósito, igual que la creación de la reserva: el
  // cliente final no tiene cuenta, solo el bookingId que le devolvió
  // el POST anterior. La reserva ya validó pertenencia al tenant en
  // ese momento; acá solo hace falta el id.
  @Post(
    'public/tenants/:tenantId/resources/:resourceId/bookings/:bookingId/payment-preference',
  )
  createPreference(
    @Param('tenantId') tenantId: string,
    @Param('bookingId') bookingId: string,
  ) {
    return this.payments.createPreference(tenantId, bookingId);
  }

  // Lo llama Mercado Pago, no un usuario — sin JwtAuthGuard/RateLimitGuard.
  // La defensa acá es la verificación de firma dentro del service, no
  // un guard genérico.
  @Post('payments/webhook/mercadopago')
  @HttpCode(200)
  async webhook(
    @Query('data.id') dataId: string,
    @Headers('x-signature') xSignature: string,
    @Headers('x-request-id') xRequestId: string,
  ) {
    await this.payments.handleWebhook(dataId, xSignature, xRequestId);
    return { received: true };
  }
}
