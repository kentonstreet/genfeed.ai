import { BotAccountLinksController } from '@api/services/bot-account-links/bot-account-links.controller';
import { BotAccountLinksInternalController } from '@api/services/bot-account-links/bot-account-links.internal.controller';
import { BotAccountLinksCoreModule } from '@api/services/bot-account-links/bot-account-links-core.module';
import { Module } from '@nestjs/common';

@Module({
  imports: [BotAccountLinksCoreModule],
  controllers: [BotAccountLinksController, BotAccountLinksInternalController],
  exports: [BotAccountLinksCoreModule],
})
export class BotAccountLinksModule {}
