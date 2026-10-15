import type { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  denyWorkflowActor,
  parseWorkflowActor,
  readPinnedWorkflowInput,
  refreshWorkflowActor,
  workflowActorKey,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import type { SystemWorkflowActionRequest } from '@api/collections/workflows/system-workflow-runner.service';
import type { TimelineScope } from '@api/services/social-timeline/social-timeline.types';
import {
  SOCIAL_TIMELINE_ACTION_ID,
  SOCIAL_TIMELINE_WORKFLOW_ID,
} from '@api/services/social-timeline/social-timeline-workflow-definition';
import { isCloudDeployment } from '@genfeedai/config';
import type { SourcePostNativeActionInput } from '@genfeedai/contracts/interfaces';
import type { Prisma } from '@genfeedai/prisma';
import { readRecord } from '@genfeedai/utils/data/extract.util';
import { BadRequestException } from '@nestjs/common';

export const captureTimelineActor = captureWorkflowActor;
export const timelineActorKey = workflowActorKey;
export async function refreshTimelineScope(
  tx: Prisma.TransactionClient,
  policy: BrandAccessService,
  scope: TimelineScope,
): Promise<TimelineScope> {
  const actor = await refreshWorkflowActor(
    tx,
    policy,
    captureWorkflowActor(scope),
    scope.organizationId,
  );
  await policy.assert(actor, scope.brandId, tx);
  return { ...actor, brandId: scope.brandId };
}
export async function validateTimelineWorkflowAction(
  tx: Prisma.TransactionClient,
  policy: BrandAccessService,
  action: SystemWorkflowActionRequest,
): Promise<{
  scope: TimelineScope;
  postId: string;
  input: SourcePostNativeActionInput;
}> {
  const { context } = action;
  const supplied = readRecord(action.input.request);
  if (
    supplied.organizationId !== context.organizationId ||
    supplied.userId !== context.userId
  )
    throw new BadRequestException(
      'The action scope does not match this workflow.',
    );
  let persisted = supplied;
  if (isCloudDeployment()) {
    const proof = await readPinnedWorkflowInput(
      tx,
      action,
      SOCIAL_TIMELINE_WORKFLOW_ID,
      ['SocialTimelineService.act'],
      [SOCIAL_TIMELINE_ACTION_ID],
    );
    persisted = readRecord(proof.inputValues.request);
    const actor = parseWorkflowActor(
      persisted.initiatingActor,
      context.organizationId,
    );
    if (
      actor.userId !== context.userId ||
      proof.metadata.initiatingActorKey !== workflowActorKey(actor) ||
      proof.metadata.initiatingRequestKey !== workflowRequestKey(persisted) ||
      workflowRequestKey(supplied) !== workflowRequestKey(persisted)
    )
      denyWorkflowActor();
  }
  const required = (key: string): string => {
    const value = persisted[key];
    if (typeof value !== 'string' || !value.trim()) denyWorkflowActor();
    return value;
  };
  if (
    required('organizationId') !== context.organizationId ||
    required('userId') !== context.userId
  )
    denyWorkflowActor();
  const captured = readRecord(persisted.initiatingActor);
  const scope: TimelineScope = {
    organizationId: context.organizationId,
    userId: context.userId,
    brandId: required('brandId'),
    isApiKey: captured.isApiKey === true,
    scopes: Array.isArray(captured.scopes)
      ? captured.scopes.filter(
          (scope): scope is string => typeof scope === 'string',
        )
      : [],
    ...(typeof captured.apiKeyId === 'string'
      ? { apiKeyId: captured.apiKeyId }
      : {}),
  };
  const nativeAction = (
    ['like', 'reply', 'repost', 'quote', 'comment'] as const
  ).find((value) => value === persisted.action);
  if (
    !nativeAction ||
    (persisted.text !== undefined && typeof persisted.text !== 'string')
  )
    denyWorkflowActor();
  return {
    scope: await refreshTimelineScope(tx, policy, scope),
    postId: required('postId'),
    input: {
      action: nativeAction,
      credentialId: required('credentialId'),
      idempotencyKey: required('idempotencyKey'),
      ...(typeof persisted.text === 'string' ? { text: persisted.text } : {}),
    },
  };
}
