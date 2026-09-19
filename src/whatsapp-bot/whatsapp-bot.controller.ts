import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappBotService } from './whatsapp-bot.service';
import { RawBodyRequest } from './raw-body-request';

// Público a propósito, igual que el webhook de Mercado Pago: lo llama
// Meta, no un usuario logueado. La defensa acá es la verificación de
// firma (POST) y el verify_token (GET), no un guard genérico.
@Controller('whatsapp/webhook')
export class WhatsappBotController {
  constructor(
    private readonly bot: WhatsappBotService,
    private readonly config: ConfigService,
  ) {}

  // Meta llama esto una sola vez, al configurar el webhook en el panel
  // de la app — confirma que este servidor es dueño de la URL antes de
  // empezar a mandarle mensajes de verdad.
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const expected = this.config.get<string>('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && token && expected && token === expected) {
      return challenge;
    }
    throw new ForbiddenException('Token de verificación inválido');
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    // Nunca lanza: Meta reintenta agresivamente si no recibe 200, y un
    // error de nuestro lado en un mensaje puntual no tiene que generar
    // una tormenta de reintentos. handleIncoming loguea lo que haga
    // falta y no deja que nada se propague hasta acá.
    await this.bot.handleIncoming(req.rawBody, signature, req.body);
    return { received: true };
  }
}
