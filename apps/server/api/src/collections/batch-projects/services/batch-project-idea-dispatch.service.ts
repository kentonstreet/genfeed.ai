import type { AuthenticatedUser } from '@api/auth/interfaces/authenticated-user.interface';
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
import {
  batchProjectAccess,
  readBatchIdeaAttempt,
} from '@api/collections/batch-projects/services/batch-project-actor.util';
import { BatchProjectCreditsService } from '@api/collections/batch-projects/services/batch-project-credits.service';
import {
  IDEA_OUTPUT_ASPECT_RATIO,
  ideaPromptText,
  ideaSpeechText,
  parseBatchProjectItemDispatch,
  resolveIdeaGenerationParams,
} from '@api/collections/batch-projects/services/batch-project-dispatch.util';
import { readBatchProjectIdea } from '@api/collections/batch-projects/services/batch-project-idea.util';
import {
  BATCH_PROJECT_IDEA_DISPATCH_ACTION_IDS,
  BATCH_PROJECT_IDEA_DISPATCH_FAILURE_WORKFLOW_ID,
  BATCH_PROJECT_IDEA_DISPATCH_WORKFLOW_ID,
  buildBatchProjectIdeaDispatchFailureWorkflowDefinition,
  buildBatchProjectIdeaDispatchWorkflowDefinition,
} from '@api/collections/batch-projects/services/batch-project-idea-dispatch-workflow.definition';
import { BrandKitAssetsService } from '@api/collections/brands/services/brand-kit-assets.service';
import type { CreateImageDto } from '@api/collections/images/dto/create-image.dto';
import { ImageGenerationService } from '@api/collections/images/services/image-generation.service';
import type { CreateVideoDto } from '@api/collections/videos/dto/create-video.dto';
import { AvatarVideoGenerationService } from '@api/collections/videos/services/avatar-video-generation.service';
import { VideoGenerationService } from '@api/collections/videos/services/video-generation.service';
import { WorkflowExecutionQueueService } from '@api/collections/workflows/services/workflow-execution-queue.service';
import {
  type SystemWorkflowActionRequest,
  SystemWorkflowRunnerService,
} from '@api/collections/workflows/system-workflow-runner.service';
import type { GenerationPlaceholderScope } from '@api/common/interfaces/generation-placeholder-lifecycle.interface';
import type { RequestWithContext } from '@api/common/middleware/request-context.middleware';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import type { DeferredCreditsRequest } from '@api/helpers/utils/credits/generation-credit-cost.util';
import { scopedWhere } from '@api/index';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { isCloudDeployment } from '@genfeedai/config';
import {
  BatchProjectItemStatus,
  IngredientCategory,
} from '@genfeedai/contracts';
import type {
  BatchIdea,
  IBatchProjectItemDispatch,
} from '@genfeedai/contracts/interfaces';
import { SystemWorkflowDispatchClass } from '@genfeedai/contracts/queue';
import type { BatchProject, BatchProjectItem } from '@genfeedai/prisma';
import { toPrismaJson } from '@genfeedai/prisma';
import { readRecord, readString } from '@genfeedai/utils/data/extract.util';
import { LoggerService } from '@libs/logger/logger.service';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';

/** Job input of one idea generation attempt. */
export type BatchProjectIdeaDispatchJob = {
  itemId: string;
  key: string;
  organizationId: string;
  projectId: string;
  userId: string;
};

type IdeaGenerationRequest = RequestWithContext & DeferredCreditsRequest;

type DispatchTarget = {
  dispatch: IBatchProjectItemDispatch;
  idea: BatchIdea;
  item: BatchProjectItem;
  project: BatchProject;
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Generation could not start';
}

/**
 * Starts idea generation server-side (#5463) so an idea batch keeps
 * generating after the creator leaves. Each accepted quote line runs as one
 * durable system-workflow job keyed by its dispatch key:
 *
 * 1. the generation service creates the placeholder ingredient, which is
 *    recorded on the item before anything else happens;
 * 2. immediately before the provider call, the line's credits are reserved
 *    (image/video reserve inside the generation service with deferred
 *    credits; avatar reserves here) and checked against the accepted quote —
 *    a mismatch or a missing reservation aborts before the provider;
 * 3. the provider runs; reconciliation settles the hold when a usable output
 *    lands and releases it when generation fails.
 */
@Injectable()
export class BatchProjectIdeaDispatchService implements OnModuleInit {
  private readonly context = BatchProjectIdeaDispatchService.name;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly credits: BatchProjectCreditsService,
    private readonly brandKitAssets: BrandKitAssetsService,
    private readonly imageGeneration: ImageGenerationService,
    private readonly videoGeneration: VideoGenerationService,
    private readonly avatarGeneration: AvatarVideoGenerationService,
    private readonly workflowQueue: WorkflowExecutionQueueService,
    private readonly workflowRunner: SystemWorkflowRunnerService,
    private readonly brandAccess: BrandAccessService,
  ) {}

  onModuleInit(): void {
    this.workflowRunner.registerAction(
      BATCH_PROJECT_IDEA_DISPATCH_ACTION_IDS.DISPATCH,
      (request) => this.dispatchAction(request),
    );
    this.workflowRunner.registerAction(
      BATCH_PROJECT_IDEA_DISPATCH_ACTION_IDS.FAIL,
      (request) => this.failAction(request),
    );
    this.workflowRunner.registerWorkflow(
      buildBatchProjectIdeaDispatchWorkflowDefinition(),
    );
    this.workflowRunner.registerWorkflow(
      buildBatchProjectIdeaDispatchFailureWorkflowDefinition(),
    );
  }

  /** Queue one attempt; the job id makes a repeated enqueue a no-op. */
  async enqueue(
    job: BatchProjectIdeaDispatchJob,
    actor?: WorkflowInitiatingActor,
  ): Promise<void> {
    if (isCloudDeployment() && !actor) denyWorkflowActor();
    const proof = actor ? captureWorkflowActor(actor) : undefined;
    if (
      proof &&
      (proof.userId !== job.userId ||
        proof.organizationId !== job.organizationId)
    )
      denyWorkflowActor();
    if (isCloudDeployment()) {
      const target = await this.loadTarget(job, proof);
      if (!target)
        throw new ConflictException(
          'Batch project idea attempt is unavailable.',
        );
      const original = readBatchIdeaAttempt(
        target.item.dispatch,
        target.dispatch,
        job,
        target.project.brandId,
        target.item.idea,
      );
      if (!proof || workflowActorKey(original) !== workflowActorKey(proof))
        denyWorkflowActor();
    }
    const inputValues = {
      job,
      ...(isCloudDeployment() && proof ? { initiatingActor: proof } : {}),
    };
    const attempt = job.key.split(':').pop() ?? '0';
    await this.workflowQueue.queueSystemWorkflow(
      {
        actionType: BATCH_PROJECT_IDEA_DISPATCH_WORKFLOW_ID,
        canonicalId: BATCH_PROJECT_IDEA_DISPATCH_WORKFLOW_ID,
        inputValues,
        metadata: {
          batchProjectId: job.projectId,
          itemId: job.itemId,
          ...(isCloudDeployment() && proof
            ? {
                initiatingActorKey: workflowActorKey(proof),
                initiatingRequestKey: workflowRequestKey(inputValues),
              }
            : {}),
        },
        organizationId: job.organizationId,
        source: 'batch-project-idea-dispatch',
        userId: job.userId,
      },
      `batch-project-idea-${job.itemId}-${attempt}`,
      {
        attempts: 2,
        dispatchClass: SystemWorkflowDispatchClass.BACKGROUND,
        failureWorkflow: {
          canonicalId: BATCH_PROJECT_IDEA_DISPATCH_FAILURE_WORKFLOW_ID,
          inputValues: { job },
        },
      },
    );
  }

  /** Generate one attempt; stale or already dispatched attempts are no-ops. */
  async dispatch(
    job: BatchProjectIdeaDispatchJob,
    actor?: WorkflowInitiatingActor,
  ): Promise<{ status: 'dispatched' | 'failed' | 'skipped' }> {
    const target = await this.loadTarget(job, actor);
    if (!target) {
      return { status: 'skipped' };
    }
    try {
      await this.generate(job, target, actor);
      return { status: 'dispatched' };
    } catch (error: unknown) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      )
        throw error;
      await this.failItem(job, errorMessage(error), actor);
      return { status: 'failed' };
    }
  }

  /**
   * Fail an attempt that could not start and release whatever it reserved.
   * Guarded by the dispatch key, so it never touches a newer attempt.
   */
  async failItem(
    job: BatchProjectIdeaDispatchJob,
    error: string,
    actor?: WorkflowInitiatingActor,
  ) {
    const access = await this.attemptAccess(job, actor);
    const project = access
      ? await this.prisma.batchProject.findFirst({
          where: { ...access.where, id: job.projectId },
          select: { brandId: true },
        })
      : undefined;
    if (access && !project) denyWorkflowActor();
    const item = await this.prisma.batchProjectItem.findFirst({
      where: scopedWhere(job.organizationId, {
        id: job.itemId,
        projectId: job.projectId,
        status: BatchProjectItemStatus.GENERATING,
        ...(access ? { project: { is: access.where } } : {}),
      }),
    });
    const dispatch = parseBatchProjectItemDispatch(item?.dispatch);
    if (!item || !dispatch || dispatch.key !== job.key) {
      return;
    }
    if (access) {
      if (!project) denyWorkflowActor();
      readBatchIdeaAttempt(
        item.dispatch,
        dispatch,
        job,
        project.brandId,
        item.idea,
      );
      await access.assertBrands([project.brandId]);
      await access.assertUnchanged();
    }
    // Only a recorded hold is released: an attempt that never reached its
    // reservation has nothing to return.
    if (dispatch.state === 'reserved') {
      await this.credits.release({
        dispatch,
        organizationId: job.organizationId,
      });
    }
    if (access) {
      if (!project) denyWorkflowActor();
      await access.assertBrands([project.brandId]);
      await access.assertUnchanged();
    }
    await this.prisma.batchProjectItem.updateMany({
      data: {
        dispatch: toPrismaJson({
          ...readRecord(item.dispatch),
          ...dispatch,
          state: 'released',
        }),
        error,
        status: BatchProjectItemStatus.FAILED,
      },
      where: scopedWhere(job.organizationId, {
        dispatch: { equals: job.key, path: ['key'] },
        id: item.id,
        status: BatchProjectItemStatus.GENERATING,
        ...(access ? { project: { is: access.where } } : {}),
      }),
    });
    this.logger.warn('Batch project idea failed to start', {
      batchProjectId: job.projectId,
      batchProjectItemId: job.itemId,
      context: this.context,
      error,
      organizationId: job.organizationId,
    });
  }

  private async dispatchAction(request: SystemWorkflowActionRequest) {
    const { job, actor } = await this.authorizedJob(request, false);
    return this.dispatch(job, actor);
  }

  private async failAction(request: SystemWorkflowActionRequest) {
    const { job, actor } = await this.authorizedJob(request, true);
    await this.failItem(job, 'Generation could not start', actor);
    return { status: 'failed' };
  }

  private async authorizedJob(
    request: SystemWorkflowActionRequest,
    failure: boolean,
  ) {
    if (!isCloudDeployment())
      return { job: this.readJob(request), actor: undefined };
    const current = await readPinnedWorkflowInput(
      this.prisma,
      request,
      failure
        ? BATCH_PROJECT_IDEA_DISPATCH_FAILURE_WORKFLOW_ID
        : BATCH_PROJECT_IDEA_DISPATCH_WORKFLOW_ID,
      [
        failure
          ? `workflow-failure:${BATCH_PROJECT_IDEA_DISPATCH_WORKFLOW_ID}`
          : 'batch-project-idea-dispatch',
      ],
      [
        failure
          ? BATCH_PROJECT_IDEA_DISPATCH_ACTION_IDS.FAIL
          : BATCH_PROJECT_IDEA_DISPATCH_ACTION_IDS.DISPATCH,
      ],
    );
    if (
      workflowRequestKey(request.input.job) !==
      workflowRequestKey(current.inputValues.job)
    )
      denyWorkflowActor();
    let origin = current;
    if (failure) {
      const parent = readRecord(current.inputValues.failedParent);
      if (
        !readString(parent.executionId) ||
        !readString(parent.workflowId) ||
        !readString(parent.workflowVersionId) ||
        workflowRequestKey(parent) !==
          workflowRequestKey(current.metadata.failedParent) ||
        current.metadata.failedCanonicalId !==
          BATCH_PROJECT_IDEA_DISPATCH_WORKFLOW_ID
      )
        denyWorkflowActor();
      origin = await readPinnedWorkflowInput(
        this.prisma,
        {
          context: {
            ...request.context,
            executionId: String(parent.executionId),
            runId: String(parent.executionId),
            workflowId: String(parent.workflowId),
            workflowVersionId: String(parent.workflowVersionId),
          },
          input: {},
          provenance: {
            executionId: String(parent.executionId),
            workflowId: String(parent.workflowId),
            workflowLabel: '',
            nodeId: 'dispatch-idea',
          },
        },
        BATCH_PROJECT_IDEA_DISPATCH_WORKFLOW_ID,
        ['batch-project-idea-dispatch'],
        [BATCH_PROJECT_IDEA_DISPATCH_ACTION_IDS.DISPATCH],
      );
      if (
        workflowRequestKey(current.inputValues.job) !==
        workflowRequestKey(origin.inputValues.job)
      )
        denyWorkflowActor();
    }
    const actor = parseWorkflowActor(
      origin.inputValues.initiatingActor,
      request.context.organizationId,
    );
    if (
      origin.metadata.initiatingActorKey !== workflowActorKey(actor) ||
      origin.metadata.initiatingRequestKey !==
        workflowRequestKey(origin.inputValues) ||
      actor.userId !== origin.execution.userId
    )
      denyWorkflowActor();
    const job = this.readJob({
      ...request,
      input: { job: origin.inputValues.job },
    });
    if (job.userId !== actor.userId) denyWorkflowActor();
    return { job, actor };
  }

  private async attemptAccess(
    job: BatchProjectIdeaDispatchJob,
    actor?: WorkflowInitiatingActor,
  ) {
    if (!isCloudDeployment()) return undefined;
    if (
      !actor ||
      actor.userId !== job.userId ||
      actor.organizationId !== job.organizationId
    )
      denyWorkflowActor();
    const current = await refreshWorkflowActor(
      this.prisma,
      this.brandAccess,
      actor,
      job.organizationId,
    );
    return batchProjectAccess(
      this.prisma,
      this.brandAccess,
      {
        ...current,
        userId: current.userId,
        organizationId: current.organizationId,
      },
      job.projectId,
    );
  }

  private readJob(request: SystemWorkflowActionRequest) {
    const job = readRecord(request.input.job);
    const parsed = {
      itemId: readString(job.itemId),
      key: readString(job.key),
      organizationId: readString(job.organizationId),
      projectId: readString(job.projectId),
      userId: readString(job.userId),
    };
    if (
      !parsed.itemId ||
      !parsed.key ||
      !parsed.organizationId ||
      !parsed.projectId ||
      !parsed.userId ||
      parsed.organizationId !== request.context.organizationId
    ) {
      throw new ConflictException('Invalid batch project idea dispatch job.');
    }
    return parsed as BatchProjectIdeaDispatchJob;
  }

  private async loadTarget(
    job: BatchProjectIdeaDispatchJob,
    actor?: WorkflowInitiatingActor,
  ): Promise<DispatchTarget | null> {
    const access = await this.attemptAccess(job, actor);
    const [project, item] = await Promise.all([
      this.prisma.batchProject.findFirst({
        where: scopedWhere(job.organizationId, {
          id: job.projectId,
          ...(access?.where ?? {}),
        }),
      }),
      this.prisma.batchProjectItem.findFirst({
        where: scopedWhere(job.organizationId, {
          id: job.itemId,
          projectId: job.projectId,
          ...(access ? { project: { is: access.where } } : {}),
        }),
      }),
    ]);
    const dispatch = parseBatchProjectItemDispatch(item?.dispatch);
    const idea = readBatchProjectIdea(item?.idea);
    if (
      !project ||
      !item ||
      !dispatch ||
      !idea ||
      item.status !== BatchProjectItemStatus.GENERATING ||
      dispatch.key !== job.key ||
      dispatch.state !== 'queued' ||
      item.outputIngredientId
    ) {
      return null;
    }
    if (access) {
      readBatchIdeaAttempt(
        item.dispatch,
        dispatch,
        job,
        project.brandId,
        item.idea,
      );
      await access.assertBrands([project.brandId]);
      await access.assertUnchanged();
    }
    return { dispatch, idea, item, project };
  }

  private async generate(
    job: BatchProjectIdeaDispatchJob,
    target: DispatchTarget,
    actor?: WorkflowInitiatingActor,
  ): Promise<void> {
    const { dispatch, idea, item, project } = target;
    const user: AuthenticatedUser = {
      brandId: project.brandId,
      id: job.userId,
      organizationId: job.organizationId,
      userId: job.userId,
      ...(actor
        ? {
            isApiKey: actor.isApiKey,
            apiKeyId: actor.apiKeyId,
            scopes: actor.scopes,
          }
        : {}),
    };
    const admit = async () => {
      const access = await this.attemptAccess(job, actor);
      if (access) {
        await access.assertBrands([project.brandId]);
        await access.assertUnchanged();
      }
    };
    await admit();
    const placeholderScope: GenerationPlaceholderScope = {
      groupId: project.id,
      groupIndex: item.position,
      isByokBypass: dispatch.billingMode === 'byok',
      settleCreditsExternally: true,
    };
    const onPlaceholderCreated = async (ingredientId: string) => {
      await admit();
      await this.recordPlaceholder(job, idea, ingredientId);
    };

    if (idea.format === 'avatar') {
      // The avatar service resolves the brand's (else the organization's)
      // default avatar and saved voice into provider identities.
      await this.avatarGeneration.generateAvatarVideo(
        {
          aspectRatio: IDEA_OUTPUT_ASPECT_RATIO,
          text: ideaSpeechText(idea),
          useIdentity: true,
        },
        {
          brandId: project.brandId,
          organizationId: job.organizationId,
          userId: job.userId,
        },
        onPlaceholderCreated,
        placeholderScope,
        async (price) => {
          await admit();
          if (
            price.billingMode !== dispatch.billingMode ||
            price.credits !== dispatch.credits
          ) {
            throw new ConflictException(
              'Avatar funding changed after the accepted quote. Retry with a fresh quote.',
            );
          }
          await this.reserveLine(job, dispatch, project.brandId, item.dispatch);
        },
      );
      return;
    }

    const request = {
      body: { sourceActionId: dispatch.key },
      creditsConfig: { deferred: true },
      user,
    } as IdeaGenerationRequest;
    const references = (
      await this.brandKitAssets.resolveBrandKitAssets(
        project.brandId,
        job.organizationId,
      )
    ).references.map((reference) => reference.id);
    const { duration, height, width } = resolveIdeaGenerationParams(
      idea.format,
    );
    const media = {
      autoSelectModel: false,
      brandId: project.brandId,
      brandingMode: 'brand',
      ...(duration ? { duration } : {}),
      height,
      isBrandingEnabled: true,
      model: dispatch.model,
      outputs: 1,
      references,
      sourceActionId: dispatch.key,
      text: ideaPromptText(idea),
      width,
    };
    await admit();
    const onCreditsPrepared = async () => {
      await admit();
      await this.recordGenerationReservation(
        job,
        dispatch,
        request,
        item.dispatch,
      );
    };

    if (idea.format === 'video') {
      await this.videoGeneration.generateVideo(
        user,
        media as CreateVideoDto,
        request,
        onPlaceholderCreated,
        placeholderScope,
        onCreditsPrepared,
      );
      return;
    }
    await this.imageGeneration.generateImage(
      user,
      { ...media, waitForCompletion: false } as CreateImageDto,
      request,
      onPlaceholderCreated,
      placeholderScope,
      onCreditsPrepared,
    );
  }

  private async recordPlaceholder(
    job: BatchProjectIdeaDispatchJob,
    idea: BatchIdea,
    ingredientId: string,
  ): Promise<void> {
    await this.prisma.batchProjectItem.updateMany({
      data: {
        outputCategory:
          idea.format === 'image'
            ? IngredientCategory.IMAGE
            : idea.format === 'avatar'
              ? IngredientCategory.AVATAR
              : IngredientCategory.VIDEO,
        outputIngredientId: ingredientId,
      },
      where: scopedWhere(job.organizationId, {
        dispatch: { equals: job.key, path: ['key'] },
        id: job.itemId,
        outputIngredientId: null,
        status: BatchProjectItemStatus.GENERATING,
      }),
    });
  }

  /** Avatar lines reserve here, right before the provider call. */
  private async reserveLine(
    job: BatchProjectIdeaDispatchJob,
    dispatch: IBatchProjectItemDispatch,
    brandId: string | null | undefined,
    rawDispatch: unknown,
  ): Promise<void> {
    const reservationId = await this.credits.reserve({
      actorUserId: job.userId,
      brandId,
      dispatch,
      organizationId: job.organizationId,
    });
    await this.markReserved(job, dispatch, reservationId, rawDispatch);
  }

  /**
   * Image and video services reserve the request's price themselves before
   * their provider call; accept it only when it is exactly the accepted line.
   */
  private async recordGenerationReservation(
    job: BatchProjectIdeaDispatchJob,
    dispatch: IBatchProjectItemDispatch,
    request: IdeaGenerationRequest,
    rawDispatch: unknown,
  ): Promise<void> {
    const credits = request.creditsConfig;
    const isByok = Boolean(credits?.isByokBypass);
    const amount = isByok ? 0 : (credits?.amount ?? 0);
    if (
      !credits ||
      credits.modelKey !== dispatch.model ||
      isByok !== (dispatch.billingMode === 'byok') ||
      amount !== dispatch.credits ||
      (dispatch.credits > 0 && !credits.reservationId)
    ) {
      if (credits?.reservationId) {
        await this.credits.release({
          dispatch: { ...dispatch, reservationId: credits.reservationId },
          organizationId: job.organizationId,
        });
      }
      throw new ConflictException(
        'Generation pricing changed after the accepted quote. Retry with a fresh quote.',
      );
    }
    await this.markReserved(job, dispatch, credits.reservationId, rawDispatch);
  }

  private async markReserved(
    job: BatchProjectIdeaDispatchJob,
    dispatch: IBatchProjectItemDispatch,
    reservationId: string | undefined,
    rawDispatch: unknown,
  ): Promise<void> {
    const proof = readRecord(rawDispatch);
    await this.prisma.batchProjectItem.updateMany({
      data: {
        dispatch: toPrismaJson({
          ...dispatch,
          ...(isCloudDeployment()
            ? {
                initiatingActor: proof.initiatingActor,
                initiatingActorKey: proof.initiatingActorKey,
                initiatingRequestKey: proof.initiatingRequestKey,
              }
            : {}),
          state: 'reserved',
          ...(reservationId ? { reservationId } : {}),
        }),
      },
      where: scopedWhere(job.organizationId, {
        dispatch: { equals: job.key, path: ['key'] },
        id: job.itemId,
        status: BatchProjectItemStatus.GENERATING,
      }),
    });
  }
}
