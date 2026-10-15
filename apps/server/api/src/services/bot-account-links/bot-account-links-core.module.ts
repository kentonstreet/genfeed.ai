import { BrandAccessModule } from '@api/authorization/brand-access/brand-access.module';
import { CredentialsCoreModule } from '@api/collections/credentials/credentials-core.module';
import { BotAccountLinksService } from '@api/services/bot-account-links/bot-account-links.service';
import { CacheModule } from '@api/services/cache/cache.module';
import { PrismaModule } from '@api/shared/modules/prisma/prisma.module';
import { ConfigModule } from '@libs/config/config.module';
import { Module } from '@nestjs/common';

@Module({
  imports: [
    BrandAccessModule,
    CredentialsCoreModule,
    CacheModule,
    PrismaModule,
    ConfigModule,
  ],
  providers: [BotAccountLinksService],
  exports: [BotAccountLinksService],
})
export class BotAccountLinksCoreModule {}
