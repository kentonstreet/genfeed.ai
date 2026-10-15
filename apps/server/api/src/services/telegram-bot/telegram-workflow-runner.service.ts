import type { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  refreshWorkflowActor,
  workflowActorKey,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import { isCloudDeployment } from '@genfeedai/config';
/**
 * Executes Telegram recipes through the same immutable system-workflow path as
 * every other Genfeed entry surface. Telegram owns presentation only.
 */

import type { SystemWorkflowRunnerService } from '@api/collections/workflows/system-workflow-runner.service';
import { scopedWhere } from '@api/index';
import type {
  ChatAuthContext,
  ConversationState,
} from '@api/services/telegram-bot/telegram-bot.types';
import { TELEGRAM_SYSTEM_WORKFLOW_PREFIX } from '@api/services/telegram-bot/telegram-workflow-loader';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { ParseMode, WorkflowExecutionTrigger } from '@genfeedai/contracts';
import type { LoggerService } from '@libs/logger/logger.service';
import type { Context } from 'grammy';

type TelegramMediaOutput = {
  type: 'image' | 'video';
  url: string;
};

export class TelegramWorkflowRunnerService {
  constructor(
    private readonly loggerService: LoggerService,
    private readonly systemWorkflowRunner: SystemWorkflowRunnerService,
    private readonly prisma: PrismaService,
    private readonly brandAccess: BrandAccessService,
    private readonly resolveAuthContext: (
      chatId: number,
    ) => ChatAuthContext | null | Promise<ChatAuthContext | null>,
  ) {}

  async execute(
    ctx: Context,
    chatId: number,
    state: ConversationState,
  ): Promise<void> {
    const workflowId = state.workflowId;
    const workflow = state.workflow;
    if (!workflowId || !workflow) {
      return;
    }

    const authContext = await this.resolveAuthContext(chatId);
    if (
      !authContext ||
      (isCloudDeployment() &&
        (authContext.authType !== 'api_key' || !authContext.apiKeyId))
    ) {
      await ctx.reply(
        '🔐 Connect first with `/connect <api_key>` or configure default org/user context.',
        { parse_mode: ParseMode.MARKDOWN },
      );
      return;
    }

    state.step = 'executing';
    const statusMessage = await ctx.reply(
      `⏳ **Running: ${state.workflowName}**\n` +
        `Processing ${workflow.nodes.length} workflow nodes through shared Genfeed actions...`,
      { parse_mode: ParseMode.MARKDOWN },
    );
    state.statusMessageId = statusMessage.message_id;
    const startedAt = Date.now();

    try {
      if (
        isCloudDeployment() &&
        ![
          'single-image',
          'image-series',
          'image-to-video',
          'single-video',
          'full-pipeline',
        ].includes(workflowId)
      ) {
        throw new Error('Telegram workflow is not authorized.');
      }
      const actor = await refreshWorkflowActor(
        this.prisma,
        this.brandAccess,
        captureWorkflowActor({
          organizationId: authContext.organizationId,
          userId: authContext.userId,
          isApiKey: authContext.authType === 'api_key',
          apiKeyId: authContext.apiKeyId,
          scopes: authContext.scopes ?? [],
        }),
        authContext.organizationId,
      );
      const brandId = await this.resolveExecutionBrand(
        authContext.organizationId,
        authContext,
      );
      await this.brandAccess.assert(actor, brandId);
      const inputValues = {
        ...Object.fromEntries(
          [...state.collectedInputs].filter(
            ([key]) =>
              ![
                'initiatingActor',
                'initiatingActorKey',
                'initiatingRequestKey',
              ].includes(key),
          ),
        ),
        brandId,
        initiatingActor: actor,
      };
      const admittedActor = await refreshWorkflowActor(
        this.prisma,
        this.brandAccess,
        actor,
        actor.organizationId,
      );
      await this.brandAccess.assert(admittedActor, brandId);
      inputValues.initiatingActor = admittedActor;
      const { provenance, result } =
        await this.systemWorkflowRunner.runWorkflow<unknown>({
          actionType: 'telegram-media-workflow',
          canonicalId: `${TELEGRAM_SYSTEM_WORKFLOW_PREFIX}${workflowId}`,
          inputValues,
          metadata: {
            initiatingActorKey: workflowActorKey(admittedActor),
            initiatingRequestKey: workflowRequestKey(inputValues),
            chatId,
            telegramUserId: ctx.from?.id,
            username: ctx.from?.username,
          },
          organizationId: authContext.organizationId,
          source: 'telegram',
          trigger: WorkflowExecutionTrigger.API,
          userId: authContext.userId,
        });

      const responseActor = await refreshWorkflowActor(
        this.prisma,
        this.brandAccess,
        admittedActor,
        admittedActor.organizationId,
      );
      await this.brandAccess.assert(responseActor, brandId);
      await this.sendResults(
        ctx,
        result,
        provenance.executionId,
        this.durationSeconds(startedAt),
      );
    } catch (error) {
      this.loggerService.error(
        'TelegramBotService: Workflow execution failed',
        { chatId, error, workflowId },
      );
      await ctx.reply(
        `❌ **Error running workflow**\n\n` +
          `${error instanceof Error ? error.message : 'Unknown error'}\n` +
          `Duration: ${this.durationSeconds(startedAt)}s`,
        { parse_mode: ParseMode.MARKDOWN },
      );
    }
  }

  /**
   * #5219: generation always has an explicit brand. An API-key-authenticated
   * chat resolves the key's validated defaultBrandId; a Better-Auth-linked
   * chat resolves the acting member's currentBrandId. Neither falls back to
   * "any active brand in the org" — the bot must be configured with a brand
   * before it can run media workflows.
   */
  private async resolveExecutionBrand(
    organizationId: string,
    authContext: ChatAuthContext,
  ): Promise<string> {
    if (authContext.authType === 'api_key' && authContext.apiKeyId) {
      const apiKey = await this.prisma.apiKey.findFirst({
        select: { defaultBrandId: true },
        where: {
          id: authContext.apiKeyId,
          isRevoked: false,
          organizationId,
          ...(isCloudDeployment()
            ? {
                userId: authContext.userId,
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              }
            : {}),
        },
      });
      const brand = apiKey?.defaultBrandId
        ? await this.prisma.brand.findFirst({
            select: { id: true },
            where: {
              id: apiKey.defaultBrandId,
              isDeleted: false,
              organizationId,
            },
          })
        : null;
      if (!brand) {
        throw new Error(
          'This API key has no default brand configured. Set one before running media workflows from Telegram.',
        );
      }
      return brand.id;
    }

    const member = await this.prisma.member.findFirst({
      select: { currentBrandId: true },
      where: scopedWhere(organizationId, {
        isActive: true,
        userId: authContext.userId,
      }),
    });
    const brand = member?.currentBrandId
      ? await this.prisma.brand.findFirst({
          select: { id: true },
          where: {
            id: member.currentBrandId,
            isDeleted: false,
            organizationId,
          },
        })
      : null;
    if (!brand) {
      throw new Error(
        'Select a current brand before running media workflows from Telegram.',
      );
    }
    return brand.id;
  }

  private durationSeconds(startedAt: number): string {
    return ((Date.now() - startedAt) / 1000).toFixed(1);
  }

  private async sendResults(
    ctx: Context,
    result: unknown,
    executionId: string,
    durationSeconds: string,
  ): Promise<void> {
    const outputs = this.collectMediaOutputs(result);
    await ctx.reply(
      `✅ **Workflow completed!**\n\n` +
        `⏱ Duration: ${durationSeconds}s\n` +
        `🆔 Execution: ${executionId}\n` +
        `📦 Outputs: ${outputs.length} file(s)`,
      { parse_mode: ParseMode.MARKDOWN },
    );

    for (const output of outputs) {
      try {
        if (output.type === 'image') {
          await ctx.replyWithPhoto(output.url, {
            caption: '🖼 Generated Image',
          });
        } else {
          await ctx.replyWithVideo(output.url, {
            caption: '🎬 Generated Video',
          });
        }
      } catch (error) {
        this.loggerService.error(
          'TelegramBotService: Failed to send workflow output',
          { error, output },
        );
        await ctx.reply(
          `📎 ${output.type === 'image' ? '🖼' : '🎬'} Output URL: ${output.url}`,
        );
      }
    }

    if (outputs.length === 0) {
      await ctx.reply(
        `📋 **Workflow output:**\n\`\`\`\n${JSON.stringify(result).substring(0, 1200)}\n\`\`\``,
        { parse_mode: ParseMode.MARKDOWN },
      );
    }
  }

  private collectMediaOutputs(value: unknown): TelegramMediaOutput[] {
    const outputs: TelegramMediaOutput[] = [];
    const seen = new Set<string>();
    const visit = (
      candidate: unknown,
      key = '',
      inheritedType?: TelegramMediaOutput['type'],
    ): void => {
      if (typeof candidate === 'string') {
        if (!/^https?:\/\//.test(candidate) || seen.has(candidate)) {
          return;
        }
        const normalizedKey = key.toLowerCase();
        const type = normalizedKey.includes('video')
          ? 'video'
          : normalizedKey.includes('image')
            ? 'image'
            : normalizedKey.includes('media')
              ? inheritedType
              : undefined;
        if (type) {
          seen.add(candidate);
          outputs.push({ type, url: candidate });
        }
        return;
      }
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          visit(item, key, inheritedType);
        }
        return;
      }
      if (!candidate || typeof candidate !== 'object') {
        return;
      }
      const record = candidate as Record<string, unknown>;
      const declaredType =
        record.inputType === 'image' || record.inputType === 'video'
          ? record.inputType
          : inheritedType;
      for (const [childKey, childValue] of Object.entries(candidate)) {
        visit(childValue, childKey, declaredType);
      }
    };

    visit(value);
    return outputs;
  }
}
