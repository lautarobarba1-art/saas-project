import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TenantsModule } from '../tenants/tenants.module';
import { WhatsappBotController } from './whatsapp-bot.controller';
import { WhatsappBotService } from './whatsapp-bot.service';
import { ConversationStateService } from './conversation-state.service';

@Module({
  imports: [NotificationsModule, TenantsModule],
  controllers: [WhatsappBotController],
  providers: [WhatsappBotService, ConversationStateService],
})
export class WhatsappBotModule {}
