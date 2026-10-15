import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  denyWorkflowActor,
  refreshWorkflowActor,
  type WorkflowInitiatingActor,
} from '@api/authorization/brand-access/workflow-actor.util';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import { AgentScopeContextService, scopedWhere } from '@api/index';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { isCloudDeployment } from '@genfeedai/config';
import type { ValidatedAgentScope } from '@genfeedai/contracts/interfaces';
import { BadRequestException, Injectable } from '@nestjs/common';

export interface AuthorizeWorkflowExecutionInput {
  readonly expectedContextVersion?: number;
  readonly initiatingActor?: WorkflowInitiatingActor;
  readonly organizationId: string;
  readonly requestedBrandId?: string;
  readonly threadId?: string;
  readonly userId: string;
  readonly workflowId: string;
}

/**
 * Thin workflow-owned adapter from optional shell context to the canonical
 * server scope validator. It authorizes only; deterministic execution remains
 * owned by WorkflowExecutorService and the workflow engine.
 */
@Injectable()
export class WorkflowExecutionAuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentScopeContextService: AgentScopeContextService,
    private readonly brandAccess: BrandAccessService,
  ) {}

  async authorize(
    input: AuthorizeWorkflowExecutionInput,
  ): Promise<ValidatedAgentScope | undefined> {
    const hasThreadId = Boolean(input.threadId);
    const hasContextVersion = input.expectedContextVersion !== undefined;

    if (
      (hasThreadId || hasContextVersion) &&
      (!input.threadId || input.expectedContextVersion === undefined)
    ) {
      throw new BadRequestException(
        'threadId and expectedContextVersion are required together for workflow actions.',
      );
    }

    let currentActor: WorkflowInitiatingActor | undefined;
    if (isCloudDeployment()) {
      const actor = input.initiatingActor;
      if (
        !actor ||
        actor.organizationId !== input.organizationId ||
        actor.userId !== input.userId
      )
        denyWorkflowActor();
      currentActor = await refreshWorkflowActor(
        this.prisma,
        this.brandAccess,
        actor,
        input.organizationId,
      );
      const access = await this.brandAccess.resolve(currentActor);
      const workflow = await this.prisma.workflow.findFirst({
        select: { id: true, brandId: true },
        where: scopedWhere(input.organizationId, {
          id: input.workflowId,
          OR: [{ brandId: null }, { brand: { is: access.where } }],
        }),
      });
      if (!workflow) throw new NotFoundException('Workflow');
      currentActor = await refreshWorkflowActor(
        this.prisma,
        this.brandAccess,
        actor,
        input.organizationId,
      );
      if (workflow.brandId)
        await this.brandAccess.assert(currentActor, workflow.brandId);
    }
    if (!hasThreadId && !hasContextVersion) return undefined;

    const prepared = await this.agentScopeContextService.prepareForTurn({
      expectedContextVersion: input.expectedContextVersion,
      organizationId: input.organizationId,
      requestedBrandId: input.requestedBrandId,
      threadId: input.threadId,
      userId: input.userId,
      ...(currentActor
        ? {
            isApiKey: currentActor.isApiKey,
            apiKeyId: currentActor.apiKeyId,
            scopes: currentActor.scopes,
          }
        : {}),
    });
    const scope = prepared.existingScope;
    if (!scope) {
      throw new BadRequestException(
        'A persisted thread context is required for workflow execution.',
      );
    }

    await this.agentScopeContextService.assertConsequentialBoundary(
      scope,
      'workflow',
    );

    const currentAccess =
      currentActor && input.initiatingActor
        ? await this.brandAccess.resolve(
            await refreshWorkflowActor(
              this.prisma,
              this.brandAccess,
              input.initiatingActor,
              input.organizationId,
            ),
          )
        : undefined;
    const workflow = await this.prisma.workflow.findFirst({
      select: { brandId: true, id: true },
      where: scopedWhere(input.organizationId, {
        id: input.workflowId,
        ...(currentAccess
          ? { OR: [{ brandId: null }, { brand: { is: currentAccess.where } }] }
          : {}),
      }),
    });
    if (!workflow) {
      throw new NotFoundException('Workflow');
    }

    this.agentScopeContextService.assertResourceBrand(
      scope,
      workflow.brandId,
      'workflow',
    );
    if (input.initiatingActor && isCloudDeployment()) {
      const fresh = await refreshWorkflowActor(
        this.prisma,
        this.brandAccess,
        input.initiatingActor,
        input.organizationId,
      );
      if (workflow.brandId)
        await this.brandAccess.assert(fresh, workflow.brandId);
    }

    return scope;
  }
}
