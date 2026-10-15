import type { AuthenticatedUser as User } from '@api/auth/interfaces/authenticated-user.interface';
import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  refreshWorkflowActor,
  workflowActorKey,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import { ContentPlanItemsService } from '@api/collections/content-plan-items/services/content-plan-items.service';
import { GenerateContentPlanDto } from '@api/collections/content-plans/dto/generate-content-plan.dto';
import { UpdateContentPlanDto } from '@api/collections/content-plans/dto/update-content-plan.dto';
import { ContentPlansService } from '@api/collections/content-plans/services/content-plans.service';
import { AUTOMATION_WORKFLOW_IDS } from '@api/collections/workflows/services/automation-workflow-definitions';
import { SystemWorkflowRunnerService } from '@api/collections/workflows/system-workflow-runner.service';
import { CurrentUser } from '@api/helpers/decorators/user/current-user.decorator';
import { TenantReadPolicy } from '@api/helpers/interceptors/tenant-context/tenant-read-policy.decorator';
import { resolveTenantReadScope } from '@api/helpers/interceptors/tenant-context/tenant-read-scope.context';
import {
  serializeCollection,
  serializeSingle,
} from '@api/helpers/utils/response/response.util';
import { ContentPlanSeedsService } from '@api/services/content-engine/content-plan-seeds.service';
import { ContentPlannerService } from '@api/services/content-engine/content-planner.service';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { WorkflowExecutionTrigger } from '@genfeedai/contracts';
import {
  ContentPlanItemSerializer,
  ContentPlanSerializer,
} from '@genfeedai/serializers';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

@ApiTags('ContentEngine')
@Controller('brands/:brandId/content')
export class ContentEngineController {
  constructor(
    private readonly contentPlannerService: ContentPlannerService,
    private readonly contentPlansService: ContentPlansService,
    private readonly contentPlanItemsService: ContentPlanItemsService,
    private readonly contentPlanSeedsService: ContentPlanSeedsService,
    private readonly moduleRef: ModuleRef,
    private readonly brandAccess: BrandAccessService,
    private readonly prisma: PrismaService,
  ) {}

  // WorkflowsModule already imports the content-engine graph, so resolve the
  // runner lazily instead of creating a module cycle here.
  private get systemWorkflowRunner(): SystemWorkflowRunnerService {
    return this.moduleRef.get(SystemWorkflowRunnerService, { strict: false });
  }

  private async initiatingActor(user: User, brandId: string) {
    const actor = await refreshWorkflowActor(
      this.prisma,
      this.brandAccess,
      captureWorkflowActor({
        organizationId: user.organizationId,
        userId: user.userId ?? user.id,
        isApiKey: user.isApiKey,
        scopes: user.scopes,
        apiKeyId: user.apiKeyId,
      }),
      user.organizationId,
    );
    await this.brandAccess.assert(actor, brandId);
    return actor;
  }

  // ── Plans ──────────────────────────────────────────────────────────

  @Post('plans')
  async generatePlan(
    @Req() req: Request,
    @CurrentUser() user: User,
    @Param('brandId') brandId: string,
    @Body() dto: GenerateContentPlanDto,
  ) {
    const organization = user.organizationId;
    const userId = user.userId ?? user.id;
    const { items, plan } = await this.contentPlannerService.generatePlan(
      organization,
      brandId,
      userId,
      dto,
    );
    return {
      items: serializeCollection(req, ContentPlanItemSerializer, {
        docs: items,
      }),
      plan: serializeSingle(req, ContentPlanSerializer, plan),
    };
  }

  /**
   * Preview surface for cold-start seeding: what a plan would be grounded in
   * before the caller picks a subset via `GenerateContentPlanDto.seeds`.
   * Declared before `plans/:planId` so `seeds` never matches that param.
   */
  @TenantReadPolicy('selected')
  @Get('plans/seeds')
  async getPlanSeeds(
    @CurrentUser() user: User,
    @Param('brandId') brandId: string,
  ) {
    const organization = resolveTenantReadScope(user).organizationId;
    return this.contentPlanSeedsService.buildPreview(organization, brandId);
  }

  @TenantReadPolicy('selected')
  @Get('plans')
  async listPlans(
    @Req() req: Request,
    @CurrentUser() user: User,
    @Param('brandId') brandId: string,
  ) {
    const organization = resolveTenantReadScope(user).organizationId;
    const docs = await this.contentPlansService.listByBrand(
      organization,
      brandId,
    );
    return serializeCollection(req, ContentPlanSerializer, { docs });
  }

  @TenantReadPolicy('selected')
  @Get('plans/:planId')
  async getPlan(
    @Req() req: Request,
    @CurrentUser() user: User,
    @Param('planId') planId: string,
  ) {
    const organization = resolveTenantReadScope(user).organizationId;
    const plan = await this.contentPlansService.getByIdOrFail(
      organization,
      planId,
    );
    const items = await this.contentPlanItemsService.listByPlan(
      organization,
      planId,
    );
    return {
      items: serializeCollection(req, ContentPlanItemSerializer, {
        docs: items,
      }),
      plan: serializeSingle(req, ContentPlanSerializer, plan),
    };
  }

  @Put('plans/:planId')
  async updatePlan(
    @Req() req: Request,
    @CurrentUser() user: User,
    @Param('planId') planId: string,
    @Body() dto: UpdateContentPlanDto,
  ) {
    const organization = user.organizationId;
    const data = await this.contentPlansService.patch(planId, {
      ...dto,
      organizationId: organization,
    });
    return serializeSingle(req, ContentPlanSerializer, data);
  }

  @Delete('plans/:planId')
  async deletePlan(@CurrentUser() user: User, @Param('planId') planId: string) {
    const organization = user.organizationId;
    await this.contentPlanItemsService.softDeleteByPlan(organization, planId);
    return this.contentPlansService.softDelete(organization, planId);
  }

  // ── Execution ──────────────────────────────────────────────────────

  /**
   * Entry surface only: the plan is claimed, fanned out, and finalized by the
   * immutable `content.production.engine.plan` system workflow.
   */
  @Post('plans/:planId/execute')
  async executePlan(
    @CurrentUser() user: User,
    @Param('brandId') brandId: string,
    @Param('planId') planId: string,
  ) {
    const organization = user.organizationId;
    const userId = user.userId ?? user.id;
    const actor = await this.initiatingActor(user, brandId);
    const inputValues = {
      request: { brandId, planId, userId, initiatingActor: actor },
    };
    const { result } = await this.systemWorkflowRunner.runWorkflow<
      Record<string, unknown>
    >({
      actionType: AUTOMATION_WORKFLOW_IDS.CONTENT_ENGINE_PLAN,
      canonicalId: AUTOMATION_WORKFLOW_IDS.CONTENT_ENGINE_PLAN,
      inputValues,
      metadata: {
        initiatingActorKey: workflowActorKey(actor),
        initiatingRequestKey: workflowRequestKey(inputValues),
      },
      organizationId: organization,
      source: 'api:content-engine.execute-plan',
      trigger: WorkflowExecutionTrigger.API,
      userId,
    });
    return result;
  }

  /**
   * Entry surface only: one plan item runs through the immutable
   * `content.production.engine.plan-item` system workflow.
   */
  @Post('plans/:planId/items/:itemId/execute')
  async executeItem(
    @CurrentUser() user: User,
    @Param('brandId') brandId: string,
    @Param('itemId') itemId: string,
  ) {
    const organization = user.organizationId;
    const userId = user.userId ?? user.id;
    const actor = await this.initiatingActor(user, brandId);
    const inputValues = {
      brandId,
      item: { id: itemId },
      userId,
      initiatingActor: actor,
    };
    const { result } = await this.systemWorkflowRunner.runWorkflow<
      Record<string, unknown>
    >({
      actionType: AUTOMATION_WORKFLOW_IDS.CONTENT_ENGINE_ITEM,
      canonicalId: AUTOMATION_WORKFLOW_IDS.CONTENT_ENGINE_ITEM,
      inputValues,
      metadata: {
        initiatingActorKey: workflowActorKey(actor),
        initiatingRequestKey: workflowRequestKey(inputValues),
      },
      organizationId: organization,
      source: 'api:content-engine.execute-plan-item',
      trigger: WorkflowExecutionTrigger.API,
      userId,
    });
    return result;
  }
}
