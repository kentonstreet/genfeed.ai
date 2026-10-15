import type { AuthenticatedUser } from '@api/auth/interfaces/authenticated-user.interface';
import { captureWorkflowActor } from '@api/authorization/brand-access/workflow-actor.util';
import { CurrentUser } from '@api/helpers/decorators/user/current-user.decorator';
import {
  serializeCollection,
  serializeSingle,
} from '@api/helpers/utils/response/response.util';
import { ConfirmBotAccountLinkDto } from '@api/services/bot-account-links/bot-account-links.dto';
import { BotAccountLinksService } from '@api/services/bot-account-links/bot-account-links.service';
import { BotAccountLinkSerializer } from '@genfeedai/serializers';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

@Controller('bot-account-links')
export class BotAccountLinksController {
  constructor(private readonly links: BotAccountLinksService) {}

  @Get()
  async list(@Req() request: Request, @CurrentUser() user: AuthenticatedUser) {
    return serializeCollection(request, BotAccountLinkSerializer, {
      docs: await this.links.list(this.actor(user)),
    });
  }
  @Get('challenges/:id')
  async preview(
    @Req() request: Request,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return serializeSingle(
      request,
      BotAccountLinkSerializer,
      await this.links.previewChallenge(id, this.actor(user)),
    );
  }
  @Post('confirm')
  async confirm(
    @Req() request: Request,
    @Body() body: ConfirmBotAccountLinkDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return serializeSingle(
      request,
      BotAccountLinkSerializer,
      await this.links.confirmChallenge(body.challengeId, this.actor(user)),
    );
  }
  @Delete(':id')
  @HttpCode(204)
  async unlink(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.links.unlink(id, this.actor(user));
  }
  private actor(user: AuthenticatedUser) {
    return captureWorkflowActor({
      userId: user.userId ?? user.id,
      organizationId: user.organizationId,
      isApiKey: user.isApiKey,
      apiKeyId: user.apiKeyId,
      scopes: user.scopes,
    });
  }
}
