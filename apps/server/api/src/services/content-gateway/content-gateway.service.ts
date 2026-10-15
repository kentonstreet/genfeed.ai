import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  denyWorkflowActor,
  refreshWorkflowActor,
  type WorkflowInitiatingActor,
} from '@api/authorization/brand-access/workflow-actor.util';
import { BrandsService } from '@api/collections/brands/services/brands.service';
import { ReviewablePostsService } from '@api/collections/posts/services/reviewable-posts.service';
import { SkillsService } from '@api/collections/skills/services/skills.service';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import type {
  ContentGatewayResult,
  ContentSignal,
} from '@api/services/content-gateway/interfaces/content-gateway.interfaces';
import { SkillWorkflowService } from '@api/services/skill-executor/skill-executor.service';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { isCloudDeployment } from '@genfeedai/config';
import { LoggerService } from '@libs/logger/logger.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class ContentGatewayService {
  constructor(
    private readonly brandsService: BrandsService,
    private readonly skillsService: SkillsService,
    private readonly skillWorkflowService: SkillWorkflowService,
    private readonly reviewablePostsService: ReviewablePostsService,
    private readonly logger: LoggerService,
    private readonly brandAccess: BrandAccessService,
    private readonly prisma: PrismaService,
  ) {}

  async routeSignal(signal: ContentSignal): Promise<ContentGatewayResult> {
    const actor = await this.admit(
      signal.organizationId,
      signal.brandId,
      signal.userId,
      signal.initiatingActor,
    );
    await this.assertBrand(signal.organizationId, signal.brandId);

    const requestedSkillSlugs = this.resolveSkillSlugs(signal.payload);
    const enabledSkillSlugs = await this.skillsService.getEnabledSkillSlugs(
      signal.organizationId,
      signal.brandId,
      requestedSkillSlugs,
    );

    const executions: string[] = [];
    const posts: ContentGatewayResult['posts'] = [];

    for (const skillSlug of enabledSkillSlugs) {
      const execution = await this.skillWorkflowService.execute(
        skillSlug,
        {
          brandId: signal.brandId,
          brandVoice: '',
          organizationId: signal.organizationId,
          platforms: [],
        },
        signal.payload,
        signal.userId,
        actor,
      );

      executions.push(execution.executionId);

      await this.admit(
        signal.organizationId,
        signal.brandId,
        signal.userId,
        actor,
      );
      const createdPosts =
        await this.reviewablePostsService.createFromSkillExecution({
          brandId: signal.brandId,
          campaignId: this.readCampaignId(signal.payload),
          drafts: [execution.draft],
          executionId: execution.executionId,
          organizationId: signal.organizationId,
          skillSlug,
          userId: signal.userId,
        });

      posts.push(...createdPosts);
    }

    this.logger.log('Signal routed through ContentGateway', {
      brandId: signal.brandId,
      posts: posts.length,
      organizationId: signal.organizationId,
      executions: executions.length,
      signalType: signal.type,
    });

    return { executions, posts };
  }

  async processManualRequest(
    organizationId: string,
    brandId: string,
    skillSlug: string,
    params?: Record<string, unknown>,
    userId?: string,
    initiatingActor?: WorkflowInitiatingActor,
  ): Promise<ContentGatewayResult> {
    const actor = await this.admit(
      organizationId,
      brandId,
      userId,
      initiatingActor,
    );
    await this.assertBrand(organizationId, brandId);

    const execution = await this.skillWorkflowService.execute(
      skillSlug,
      {
        brandId,
        brandVoice: '',
        organizationId,
        platforms: [],
      },
      params,
      userId,
      actor,
    );

    await this.admit(organizationId, brandId, userId, actor);
    const posts = await this.reviewablePostsService.createFromSkillExecution({
      brandId,
      campaignId: this.readCampaignId(params),
      drafts: [execution.draft],
      executionId: execution.executionId,
      organizationId,
      skillSlug,
      userId,
    });

    return {
      executions: [execution.executionId],
      posts,
    };
  }

  private async admit(
    organizationId: string,
    brandId: string,
    userId: string | undefined,
    actor: WorkflowInitiatingActor | undefined,
  ): Promise<WorkflowInitiatingActor | undefined> {
    if (!actor) {
      if (isCloudDeployment()) denyWorkflowActor();
      return undefined;
    }
    if (actor.organizationId !== organizationId || actor.userId !== userId)
      denyWorkflowActor();
    const fresh = await refreshWorkflowActor(
      this.prisma,
      this.brandAccess,
      captureWorkflowActor(actor),
      organizationId,
    );
    await this.brandAccess.assert(fresh, brandId);
    return fresh;
  }

  private readCampaignId(
    payload: Record<string, unknown> | undefined,
  ): string | undefined {
    const campaignId = payload?.campaignId;
    return typeof campaignId === 'string' && campaignId.trim()
      ? campaignId
      : undefined;
  }

  private async assertBrand(
    organizationId: string,
    brandId: string,
  ): Promise<void> {
    const brand = await this.brandsService.findOne({
      id: brandId,
      organizationId: organizationId,
    });

    if (!brand) {
      throw new NotFoundException('Brand', brandId);
    }
  }

  private resolveSkillSlugs(
    payload?: Record<string, unknown>,
  ): string[] | undefined {
    if (!payload) {
      return undefined;
    }

    const skillSlugs = payload.skillSlugs;

    if (!Array.isArray(skillSlugs)) {
      return undefined;
    }

    const parsed = skillSlugs.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );

    return parsed.length > 0 ? parsed : undefined;
  }
}
