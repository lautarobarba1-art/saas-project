import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../common/rate-limit.decorator';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { DemoBudgetGuard } from './demo-budget.guard';
import { WhatsappBotService } from './whatsapp-bot.service';
import { AskBotDemoDto } from './dto/ask-bot-demo.dto';

// Público a propósito, para el chat interactivo de la landing (mismo
// criterio que public/tenants/:slug/resources/...): cualquier visitante
// sin cuenta puede probar el bot contra un club real (el de demo). Cada
// llamada consume la API de Claude de verdad, por eso hay dos guards:
// RateLimitGuard corta el abuso por IP, DemoBudgetGuard pone un techo
// diario global — ninguno de los dos alcanza solo.
@UseGuards(RateLimitGuard, DemoBudgetGuard)
@Controller('public/tenants/:slug/bot-demo')
export class BotDemoController {
  constructor(private readonly bot: WhatsappBotService) {}

  @RateLimit(10, 60_000)
  @Post()
  async ask(@Param('slug') slug: string, @Body() dto: AskBotDemoDto) {
    const reply = await this.bot.answerForDemo(slug, dto.question);
    return { reply };
  }
}
