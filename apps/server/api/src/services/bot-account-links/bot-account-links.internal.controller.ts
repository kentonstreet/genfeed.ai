import { AdminApiKeyGuard } from '@api/helpers/guards/admin-api-key/admin-api-key.guard';
import { serializeSingle } from '@api/helpers/utils/response/response.util';
import { BotAccountLinkEventDto } from '@api/services/bot-account-links/bot-account-links.dto';
import { BotAccountLinksService } from '@api/services/bot-account-links/bot-account-links.service';
import { BotAccountLinkSerializer } from '@genfeedai/serializers';
import { Public } from '@libs/decorators/public.decorator';
import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

@Controller('internal/orgs/:orgId/bot-links')
@Public()
@UseGuards(AdminApiKeyGuard)
export class BotAccountLinksInternalController {
  constructor(private readonly links: BotAccountLinksService) {}

  @Post('challenges')
  async begin(
    @Req() request: Request,
    @Param('orgId') organizationId: string,
    @Body() body: BotAccountLinkEventDto,
  ) {
    const challenge = await this.links.beginChallenge(organizationId, {
      method: 'POST',
      path: request.originalUrl,
      body,
      event: body.event,
      nonce: request.get('x-genfeed-bot-nonce') ?? '',
      timestamp: Number(request.get('x-genfeed-bot-timestamp')),
      signature: request.get('x-genfeed-bot-signature') ?? '',
    });
    return serializeSingle(request, BotAccountLinkSerializer, challenge);
  }
}
