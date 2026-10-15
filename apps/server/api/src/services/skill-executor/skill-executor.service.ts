import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  denyWorkflowActor,
  parseWorkflowActor,
  readPinnedWorkflowInput,
  refreshWorkflowActor,
  type WorkflowInitiatingActor,
  workflowActorKey,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import { isExecutableBuiltInSkillIdentity } from '@api/collections/skills/constants/skill-validation.constant';
import { SkillLibraryService } from '@api/collections/skills/services/skill-library.service';
import { SkillsService } from '@api/collections/skills/services/skills.service';
import { SYSTEM_WORKFLOW_PRINCIPAL_ID } from '@api/collections/workflows/system-workflow.contract';
import {
  type SystemWorkflowActionRequest,
  SystemWorkflowRunnerService,
} from '@api/collections/workflows/system-workflow-runner.service';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import { ContentGeoOptimizerHandler } from '@api/services/skill-executor/handlers/content-geo-optimizer.handler';
import { ContentWritingHandler } from '@api/services/skill-executor/handlers/content-writing.handler';
import { ImageGenerationHandler } from '@api/services/skill-executor/handlers/image-generation.handler';
import { TrendDiscoveryHandler } from '@api/services/skill-executor/handlers/trend-discovery.handler';
import { TrendRemixHandler } from '@api/services/skill-executor/handlers/trend-remix.handler';
import type {
  GeneratedContent,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillHandler,
} from '@api/services/skill-executor/interfaces/skill-executor.interfaces';
import {
  buildSkillWorkflowDefinition,
  EXECUTABLE_SKILL_SLUGS,
  type ExecutableSkillSlug,
  isExecutableSkillSlug,
  SKILL_ACTION_IDS,
  SKILL_WORKFLOW_IDS,
} from '@api/services/skill-executor/skill-workflow-definition';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { isCloudDeployment } from '@genfeedai/config';
import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';

@Injectable()
export class SkillWorkflowService implements OnModuleInit {
  private readonly handlers: Record<ExecutableSkillSlug, SkillHandler>;

  constructor(
    private readonly skillsService: SkillsService,
    private readonly workflowRunner: SystemWorkflowRunnerService,
    contentGeoOptimizerHandler: ContentGeoOptimizerHandler,
    contentWritingHandler: ContentWritingHandler,
    imageGenerationHandler: ImageGenerationHandler,
    trendDiscoveryHandler: TrendDiscoveryHandler,
    trendRemixHandler: TrendRemixHandler,
    private readonly brandAccess: BrandAccessService,
    private readonly prisma: PrismaService,
    @Optional() private readonly skillLibrary?: SkillLibraryService,
  ) {
    this.handlers = {
      'content-geo-optimizer': contentGeoOptimizerHandler,
      'content-writing': contentWritingHandler,
      'image-generation': imageGenerationHandler,
      'trend-discovery': trendDiscoveryHandler,
      'trend-remix': trendRemixHandler,
    };
  }

  onModuleInit(): void {
    for (const skillSlug of EXECUTABLE_SKILL_SLUGS) {
      this.workflowRunner.registerAction(
        SKILL_ACTION_IDS[skillSlug],
        (request) => this.executeAction(skillSlug, request),
      );
      this.workflowRunner.registerWorkflow(
        buildSkillWorkflowDefinition(skillSlug),
      );
    }
  }

  async execute(
    skillSlug: string,
    context: SkillExecutionContext,
    params: Record<string, unknown> = {},
    userId?: string,
    initiatingActor?: WorkflowInitiatingActor,
  ): Promise<SkillExecutionResult> {
    if (!isExecutableSkillSlug(skillSlug)) {
      throw new NotFoundException(`Skill not found: ${skillSlug}`);
    }

    let actor: WorkflowInitiatingActor | undefined;
    if (initiatingActor) {
      if (
        initiatingActor.organizationId !== context.organizationId ||
        initiatingActor.userId !== userId
      )
        denyWorkflowActor();
      actor = await this.admit(initiatingActor, context.brandId);
    } else if (isCloudDeployment()) denyWorkflowActor();
    const startedAt = Date.now();
    const pinnedContext = await this.contextWithPins(
      skillSlug,
      context,
      userId,
    );
    const persistedContext = {
      ...pinnedContext,
      ...(actor ? { initiatingActor: captureWorkflowActor(actor) } : {}),
    };
    const inputValues = { context: persistedContext, params };
    const execution = await this.workflowRunner.runWorkflow<GeneratedContent>({
      actionType: SKILL_ACTION_IDS[skillSlug],
      canonicalId: SKILL_WORKFLOW_IDS[skillSlug],
      inputValues,
      ...(actor
        ? {
            metadata: {
              initiatingActorKey: workflowActorKey(actor),
              initiatingRequestKey: workflowRequestKey(inputValues),
            },
          }
        : {}),
      organizationId: context.organizationId,
      source: 'SkillWorkflowService.execute',
      userId,
    });

    return {
      creditsUsed: 0,
      draft: execution.result,
      duration: Math.max(0, Date.now() - startedAt),
      executionId: execution.provenance.executionId,
    };
  }

  private async executeAction(
    skillSlug: ExecutableSkillSlug,
    request: SystemWorkflowActionRequest,
  ): Promise<GeneratedContent> {
    let persistedInput = request.input;
    let actor: WorkflowInitiatingActor | undefined;
    if (isCloudDeployment()) {
      const proof = await readPinnedWorkflowInput(
        this.prisma,
        request,
        SKILL_WORKFLOW_IDS[skillSlug],
        ['SkillWorkflowService.execute'],
        [SKILL_ACTION_IDS[skillSlug]],
      );
      persistedInput = proof.inputValues;
      actor = parseWorkflowActor(
        this.readRecord(persistedInput.context, 'context').initiatingActor,
        request.context.organizationId,
      );
      if (
        actor.userId !== request.context.userId ||
        proof.metadata.initiatingActorKey !== workflowActorKey(actor) ||
        proof.metadata.initiatingRequestKey !==
          workflowRequestKey(persistedInput) ||
        workflowRequestKey(request.input) !== workflowRequestKey(persistedInput)
      )
        denyWorkflowActor();
    }
    const context = this.readContext(persistedInput.context);
    if (actor)
      context.initiatingActor = await this.admit(actor, context.brandId);
    if (context.organizationId !== request.context.organizationId) {
      throw new Error('Skill workflow organization context mismatch');
    }
    await this.assertSkillExecutable(
      context.organizationId,
      context.brandId,
      skillSlug,
      request.context.userId,
      this.readRecord(persistedInput.context, 'context'),
    );
    if (context.initiatingActor)
      context.initiatingActor = await this.admit(
        context.initiatingActor,
        context.brandId,
      );
    return this.handlers[skillSlug].execute(
      context,
      this.readRecord(persistedInput.params, 'params'),
      async () => {
        if (actor) await this.admit(actor, context.brandId);
        else if (isCloudDeployment()) denyWorkflowActor();
      },
    );
  }

  private async admit(
    actor: WorkflowInitiatingActor,
    brandId: string,
  ): Promise<WorkflowInitiatingActor> {
    const fresh = await refreshWorkflowActor(
      this.prisma,
      this.brandAccess,
      actor,
      actor.organizationId,
    );
    await this.brandAccess.assert(fresh, brandId);
    return fresh;
  }

  private async contextWithPins(
    skillSlug: ExecutableSkillSlug,
    context: SkillExecutionContext,
    userId?: string,
  ): Promise<SkillExecutionContext & { pinnedSkills?: unknown[] }> {
    const existing = context as SkillExecutionContext & {
      pinnedSkills?: unknown[];
    };
    if (
      !userId ||
      !this.skillLibrary ||
      (Array.isArray(existing.pinnedSkills) && existing.pinnedSkills.length > 0)
    ) {
      return existing;
    }
    const skill = await this.skillsService.getSkillById(
      context.organizationId,
      skillSlug,
      userId,
    );
    if (!skill) return existing;
    const decision = await this.skillLibrary.authorizeResolved(
      {
        brandId: context.brandId,
        organizationId: context.organizationId,
        userId,
      },
      [skill],
      [],
    );
    const version = decision.versions[0];
    const executed = decision.included.find(
      (item) => String(item.id) === String(skill.id),
    );
    if (!version || !executed) return existing;
    return {
      ...context,
      pinnedSkills: [
        {
          contentHash: version.contentHash,
          instructions:
            executed.systemPromptTemplate ?? executed.defaultInstructions ?? '',
          slug: String(skill.slug ?? skillSlug),
          versionId: version.skillVersionId,
        },
      ],
    };
  }

  private async assertSkillExecutable(
    organizationId: string,
    brandId: string,
    skillSlug: ExecutableSkillSlug,
    userId: string,
    rawContext: Record<string, unknown>,
  ): Promise<void> {
    const skill = await this.skillsService.getSkillById(
      organizationId,
      skillSlug,
      userId,
    );
    if (
      !skill?.isEnabled ||
      skill.status === 'disabled' ||
      !isExecutableBuiltInSkillIdentity(skill.id, skill.slug)
    ) {
      throw new NotFoundException(`Skill not found: ${skillSlug}`);
    }
    await this.skillsService.assertBrandSkillEnabled(
      organizationId,
      brandId,
      skillSlug,
    );
    if (!this.skillLibrary || !userId) return;
    const actor = { brandId, organizationId, userId };
    const storedPins = Array.isArray(rawContext.pinnedSkills)
      ? rawContext.pinnedSkills.flatMap((pin) => {
          if (!pin || typeof pin !== 'object') return [];
          const record = pin as Record<string, unknown>;
          if (
            typeof record.versionId !== 'string' ||
            typeof record.contentHash !== 'string'
          ) {
            return [];
          }
          return [
            {
              contentHash: record.contentHash,
              skillId: String(skill.id),
              skillVersionId: record.versionId,
            },
          ];
        })
      : [];
    const decision = await this.skillLibrary.authorizeResolved(
      actor,
      [skill],
      storedPins,
    );
    if (
      !decision.included.some((item) => String(item.id) === String(skill.id))
    ) {
      throw new NotFoundException(`Skill not found: ${skillSlug}`);
    }
    if (storedPins.length === 0 && decision.versions[0]) {
      const executed = decision.included.find(
        (item) => String(item.id) === String(skill.id),
      );
      rawContext.pinnedSkills = [
        {
          contentHash: decision.versions[0].contentHash,
          instructions:
            executed?.systemPromptTemplate ??
            executed?.defaultInstructions ??
            '',
          slug: String(skill.slug ?? skillSlug),
          versionId: decision.versions[0].skillVersionId,
        },
      ];
    }
    if (userId === SYSTEM_WORKFLOW_PRINCIPAL_ID) return;
    await this.skillLibrary.recordResolution(
      actor,
      decision.versions,
      decision.excluded,
    );
  }

  private readContext(value: unknown): SkillExecutionContext {
    const context = this.readRecord(value, 'context');
    const platforms = Array.isArray(context.platforms)
      ? context.platforms.filter(
          (platform): platform is string => typeof platform === 'string',
        )
      : [];
    return {
      brandId: this.requiredString(context.brandId, 'context.brandId'),
      brandVoice:
        typeof context.brandVoice === 'string' ? context.brandVoice : '',
      ...(this.isRecord(context.memory) ? { memory: context.memory } : {}),
      organizationId: this.requiredString(
        context.organizationId,
        'context.organizationId',
      ),
      platforms,
    };
  }

  private readRecord(value: unknown, field: string): Record<string, unknown> {
    if (!this.isRecord(value)) {
      throw new Error(`Skill workflow requires ${field}`);
    }
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Skill workflow requires ${field}`);
    }
    return value.trim();
  }
}
