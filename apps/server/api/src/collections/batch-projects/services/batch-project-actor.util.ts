import type { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  parseWorkflowActor,
  refreshWorkflowActor,
  type WorkflowInitiatingActor,
  workflowActorKey,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import { isCloudDeployment } from '@genfeedai/config';
import type {
  IBatchProjectItemDispatch,
  IBatchProjectScope,
} from '@genfeedai/contracts/interfaces';
import type { Prisma } from '@genfeedai/prisma';
import { readRecord } from '@genfeedai/utils/data/extract.util';
import { ForbiddenException } from '@nestjs/common';

/** Authenticated caller state, independent of project attribution and selected brand. */
export async function batchProjectAccess(
  tx: Prisma.TransactionClient,
  policy: BrandAccessService,
  scope: IBatchProjectScope,
  opaqueId?: string,
) {
  const captured = captureWorkflowActor({
    userId: scope.userId,
    organizationId: scope.organizationId,
    isApiKey: scope.isApiKey,
    apiKeyId: scope.apiKeyId,
    scopes: scope.scopes,
  });
  const read = async () => {
    try {
      const actor = await refreshWorkflowActor(
        tx,
        policy,
        captured,
        scope.organizationId,
      );
      const access = await policy.resolve(actor, tx);
      return {
        actor,
        access,
        fingerprint: workflowRequestKey({
          actor,
          role: access.role,
          brandIds: access.brandIds,
        }),
      };
    } catch (error) {
      if (opaqueId && error instanceof ForbiddenException)
        throw new NotFoundException('Batch project', opaqueId);
      throw error;
    }
  };
  const initial = await read();
  const where: Prisma.BatchProjectWhereInput = {
    organizationId: scope.organizationId,
    isDeleted: false,
    ...(isCloudDeployment() ? { brand: { is: initial.access.where } } : {}),
  };
  return {
    actor: initial.actor,
    where,
    async assertBrands(brandIds: readonly string[]) {
      if (!isCloudDeployment()) return;
      try {
        for (const brandId of new Set(brandIds)) {
          const current = await read();
          await policy.assert(current.actor, brandId, tx);
        }
      } catch (error) {
        if (opaqueId && error instanceof ForbiddenException)
          throw new NotFoundException('Batch project', opaqueId);
        throw error;
      }
    },
    async assertUnchanged() {
      const current = await read();
      if (current.fingerprint !== initial.fingerprint) {
        if (opaqueId) throw new NotFoundException('Batch project', opaqueId);
        throw new ForbiddenException('Brand access denied');
      }
    },
  };
}

/** One immutable server-authorized attempt; public dispatch parsing omits proof. */
export type BatchIdeaAttemptIdentity = {
  itemId: string;
  key: string;
  organizationId: string;
  projectId: string;
  userId: string;
};
export function captureBatchIdeaAttempt(
  dispatch: IBatchProjectItemDispatch,
  job: BatchIdeaAttemptIdentity,
  brandId: string,
  actor: WorkflowInitiatingActor,
  idea: unknown,
) {
  if (!isCloudDeployment()) return dispatch;
  if (
    job.userId !== actor.userId ||
    job.organizationId !== actor.organizationId
  )
    throw new ForbiddenException('Brand access denied');
  return {
    ...dispatch,
    initiatingActor: captureWorkflowActor(actor),
    initiatingActorKey: workflowActorKey(actor),
    initiatingRequestKey: workflowRequestKey({
      job,
      brandId,
      idea,
      dispatch: {
        attempt: dispatch.attempt,
        billingMode: dispatch.billingMode,
        credits: dispatch.credits,
        key: dispatch.key,
        model: dispatch.model,
      },
    }),
  };
}
export function readBatchIdeaAttempt(
  value: unknown,
  dispatch: IBatchProjectItemDispatch,
  job: BatchIdeaAttemptIdentity,
  brandId: string,
  idea: unknown,
): WorkflowInitiatingActor {
  const raw = readRecord(value);
  const actor = parseWorkflowActor(raw.initiatingActor, job.organizationId);
  if (
    actor.userId !== job.userId ||
    raw.initiatingActorKey !== workflowActorKey(actor) ||
    raw.initiatingRequestKey !==
      workflowRequestKey({
        job,
        brandId,
        idea,
        dispatch: {
          attempt: dispatch.attempt,
          billingMode: dispatch.billingMode,
          credits: dispatch.credits,
          key: dispatch.key,
          model: dispatch.model,
        },
      })
  )
    throw new ForbiddenException('Brand access denied');
  return actor;
}
