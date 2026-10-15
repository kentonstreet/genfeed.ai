import { createHash } from 'node:crypto';
import type {
  BrandAccessActor,
  BrandAccessService,
} from '@api/authorization/brand-access/brand-access.service';
import {
  getSystemWorkflowMetadata,
  isHiddenSystemWorkflowMetadata,
  SYSTEM_WORKFLOW_PRINCIPAL_ID,
} from '@api/collections/workflows/system-workflow.contract';
import type { SystemWorkflowActionRequest } from '@api/collections/workflows/system-workflow-runner.service';
import { GENFEED_ACTION_NODE_TYPE } from '@genfeedai/actions';
import { isCloudDeployment } from '@genfeedai/config';
import type { Prisma } from '@genfeedai/prisma';
import { readRecord } from '@genfeedai/utils/data/extract.util';
import { sha256Hex, stableStringify } from '@libs/utils/canonical-hash.util';
import { ForbiddenException } from '@nestjs/common';

export type WorkflowInitiatingActor = BrandAccessActor & {
  apiKeyId?: string;
  botAccountLinkId?: string;
  botAccountLinkRevision?: number;
  isApiKey: boolean;
  scopes: string[];
};
export function denyWorkflowActor(): never {
  throw new ForbiddenException('Brand access denied');
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
export function parseWorkflowActor(
  value: unknown,
  organizationId: string,
): WorkflowInitiatingActor {
  const actor = readRecord(value);
  if (
    !nonempty(actor.userId) ||
    actor.organizationId !== organizationId ||
    !nonempty(organizationId) ||
    typeof actor.isApiKey !== 'boolean' ||
    !Array.isArray(actor.scopes) ||
    !actor.scopes.every((scope) => typeof scope === 'string') ||
    (actor.apiKeyId !== undefined && !nonempty(actor.apiKeyId)) ||
    ((actor.botAccountLinkId !== undefined ||
      actor.botAccountLinkRevision !== undefined) &&
      (!nonempty(actor.botAccountLinkId) ||
        typeof actor.botAccountLinkRevision !== 'number' ||
        !Number.isSafeInteger(actor.botAccountLinkRevision) ||
        actor.botAccountLinkRevision < 1)) ||
    (isCloudDeployment() && actor.isApiKey && !nonempty(actor.apiKeyId))
  )
    denyWorkflowActor();
  return {
    organizationId,
    userId: actor.userId,
    isApiKey: actor.isApiKey,
    scopes: [...new Set(actor.scopes as string[])].sort(),
    ...(nonempty(actor.apiKeyId) ? { apiKeyId: actor.apiKeyId } : {}),
    ...(nonempty(actor.botAccountLinkId) &&
    typeof actor.botAccountLinkRevision === 'number'
      ? {
          botAccountLinkId: actor.botAccountLinkId,
          botAccountLinkRevision: actor.botAccountLinkRevision,
        }
      : {}),
  };
}
export function captureWorkflowActor(
  actor: BrandAccessActor & {
    apiKeyId?: string;
    botAccountLinkId?: string;
    botAccountLinkRevision?: number;
  },
): WorkflowInitiatingActor {
  return parseWorkflowActor(
    {
      organizationId: actor.organizationId,
      userId: actor.userId,
      isApiKey: actor.isApiKey === true,
      scopes: actor.scopes ?? [],
      apiKeyId: actor.apiKeyId,
      botAccountLinkId: actor.botAccountLinkId,
      botAccountLinkRevision: actor.botAccountLinkRevision,
    },
    actor.organizationId,
  );
}
/** Only the server's authenticated tool context carries invocation capabilities. */
export function captureWorkflowInvocationActor(
  userId: string,
  organizationId: string,
  principal?: { isApiKey?: boolean; apiKeyId?: string; scopes?: string[] },
): WorkflowInitiatingActor | undefined {
  if (!principal) {
    if (isCloudDeployment()) denyWorkflowActor();
    return undefined;
  }
  return captureWorkflowActor({
    userId,
    organizationId,
    isApiKey: principal.isApiKey,
    apiKeyId: principal.apiKeyId,
    scopes: principal.scopes,
  });
}
export function workflowActorKey(actor: WorkflowInitiatingActor): string {
  return createHash('sha256')
    .update(JSON.stringify(captureWorkflowActor(actor)))
    .digest('hex');
}
function canonicalRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) =>
            ![
              'initiatingActor',
              'initiatingActorKey',
              'initiatingRequestKey',
            ].includes(key) && item !== undefined,
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalRequest(item)]),
    );
  }
  return value;
}
export function workflowRequestKey(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalRequest(JSON.parse(JSON.stringify(value)))))
    .digest('hex');
}
/** Capture a trusted producer principal without granting its configured user a role. */
export function captureWorkflowActorEnvelope(
  actor: BrandAccessActor & {
    apiKeyId?: string;
    botAccountLinkId?: string;
    botAccountLinkRevision?: number;
  },
) {
  const initiatingActor = captureWorkflowActor(actor);
  const inputValues = { initiatingActor };
  return {
    inputValues,
    metadata: {
      initiatingActorKey: workflowActorKey(initiatingActor),
      initiatingRequestKey: workflowRequestKey(inputValues),
    },
  };
}
/** Public JSON cannot manufacture hidden-source provenance or a different principal. */
export function capturePublicWorkflowActorEnvelope(
  actor: BrandAccessActor & {
    apiKeyId?: string;
    botAccountLinkId?: string;
    botAccountLinkRevision?: number;
  },
  suppliedInputs: Record<string, unknown> = {},
  suppliedMetadata: Record<string, unknown> = {},
) {
  const initiatingActor = captureWorkflowActor(actor);
  const inputValues = {
    ...readRecord(canonicalRequest(suppliedInputs)),
    initiatingActor,
  };
  const metadata = readRecord(canonicalRequest(suppliedMetadata));
  delete metadata.source;
  delete metadata.canonicalId;
  delete metadata.isSystemAction;
  delete metadata.agentScope;
  return {
    inputValues,
    metadata: {
      ...metadata,
      initiatingActorKey: workflowActorKey(initiatingActor),
      initiatingRequestKey: workflowRequestKey(inputValues),
    },
  };
}

/** Server-written schedule capture is bound to the exact live configuration. */
export interface WorkflowScheduleConfiguration {
  workflowId: string;
  organizationId: string;
  schedule: string | null;
  timezone: string;
  isScheduleEnabled: boolean;
}
export function captureWorkflowScheduleActor(
  actor: WorkflowInitiatingActor,
  configuration: WorkflowScheduleConfiguration,
) {
  const initiatingActor = captureWorkflowActor(actor);
  if (initiatingActor.organizationId !== configuration.organizationId)
    denyWorkflowActor();
  return {
    ...configuration,
    initiatingActor,
    initiatingActorKey: workflowActorKey(initiatingActor),
    initiatingRequestKey: workflowRequestKey(configuration),
  };
}
export function readWorkflowScheduleActor(
  value: unknown,
  configuration: WorkflowScheduleConfiguration,
): WorkflowInitiatingActor {
  const stored = readRecord(value);
  const initiatingActor = parseWorkflowActor(
    stored.initiatingActor,
    configuration.organizationId,
  );
  if (
    stored.workflowId !== configuration.workflowId ||
    stored.organizationId !== configuration.organizationId ||
    stored.schedule !== configuration.schedule ||
    stored.timezone !== configuration.timezone ||
    stored.isScheduleEnabled !== configuration.isScheduleEnabled ||
    stored.initiatingActorKey !== workflowActorKey(initiatingActor) ||
    stored.initiatingRequestKey !== workflowRequestKey(configuration)
  )
    denyWorkflowActor();
  return initiatingActor;
}

export async function refreshWorkflowActor(
  tx: Prisma.TransactionClient,
  policy: BrandAccessService,
  value: unknown,
  organizationId: string,
): Promise<WorkflowInitiatingActor> {
  const actor = parseWorkflowActor(value, organizationId);
  if (isCloudDeployment()) {
    const user = await tx.user.findFirst({
      where: { id: actor.userId, isDeleted: false, banned: false },
      select: { id: true },
    });
    if (!user) denyWorkflowActor();
    if (actor.botAccountLinkId) {
      const link = await tx.botAccountLink.findFirst({
        where: {
          id: actor.botAccountLinkId,
          revision: actor.botAccountLinkRevision,
          organizationId,
          userId: actor.userId,
          isDeleted: false,
          revokedAt: null,
          integration: { organizationId, isDeleted: false, status: 'ACTIVE' },
        },
        select: {
          capturedIsApiKey: true,
          capturedApiKeyId: true,
          capturedScopes: true,
        },
      });
      if (
        !link ||
        link.capturedIsApiKey !== actor.isApiKey ||
        (link.capturedApiKeyId ?? undefined) !== actor.apiKeyId
      )
        denyWorkflowActor();
      if (actor.isApiKey) {
        actor.scopes = actor.scopes.filter((scope) =>
          link.capturedScopes.includes(scope),
        );
      }
    }
    if (actor.isApiKey) {
      const key = await tx.apiKey.findFirst({
        where: {
          id: actor.apiKeyId,
          organizationId,
          userId: actor.userId,
          isRevoked: false,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { scopes: true },
      });
      if (!key) denyWorkflowActor();
      actor.scopes = actor.scopes.filter((scope) => key.scopes.includes(scope));
    }
  }
  await policy.resolve(actor, tx);
  return actor;
}

/** Read authorization state only from the immutable hidden execution, never action JSON. */
export async function readPinnedWorkflowInput(
  tx: Prisma.TransactionClient,
  action: SystemWorkflowActionRequest,
  canonicalId: string,
  sources: readonly string[],
  allowedActionIds: readonly string[],
) {
  const { context, provenance } = action;
  if (
    !context.organizationId ||
    !context.userId ||
    provenance.executionId !== (context.executionId ?? context.runId) ||
    provenance.workflowId !== context.workflowId ||
    !nonempty(provenance.nodeId)
  )
    denyWorkflowActor();
  const execution = await tx.workflowExecution.findFirst({
    where: {
      id: provenance.executionId,
      organizationId: context.organizationId,
      isDeleted: false,
    },
    select: {
      id: true,
      userId: true,
      workflowId: true,
      workflowVersionId: true,
      result: true,
      workflow: {
        select: {
          organizationId: true,
          userId: true,
          isDeleted: true,
          metadata: true,
        },
      },
      workflowVersion: {
        select: {
          id: true,
          workflowId: true,
          organizationId: true,
          userId: true,
          contentHash: true,
          graph: true,
          inputSchema: true,
        },
      },
    },
  });
  if (
    !execution ||
    execution.userId !== context.userId ||
    execution.workflowId !== context.workflowId ||
    execution.workflowVersionId !== context.workflowVersionId ||
    execution.workflow.isDeleted ||
    execution.workflow.organizationId !== SYSTEM_WORKFLOW_PRINCIPAL_ID ||
    execution.workflow.userId !== SYSTEM_WORKFLOW_PRINCIPAL_ID ||
    execution.workflowVersion.organizationId !== SYSTEM_WORKFLOW_PRINCIPAL_ID ||
    execution.workflowVersion.userId !== SYSTEM_WORKFLOW_PRINCIPAL_ID ||
    execution.workflowVersion.workflowId !== execution.workflowId ||
    execution.workflowVersion.id !== execution.workflowVersionId ||
    !isHiddenSystemWorkflowMetadata(execution.workflow.metadata) ||
    getSystemWorkflowMetadata(execution.workflow.metadata)?.canonicalId !==
      canonicalId
  )
    denyWorkflowActor();
  const version = execution.workflowVersion;
  const graph = readRecord(version.graph);
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const node = nodes.find(
    (candidate) => readRecord(candidate).id === provenance.nodeId,
  );
  const storedNode = readRecord(node);
  const actionId = readRecord(readRecord(storedNode.data).config).actionId;
  if (
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(version.inputSchema) ||
    version.contentHash !==
      `sha256:v1:${sha256Hex(stableStringify({ graph: version.graph, inputSchema: version.inputSchema }))}` ||
    nodes.filter((candidate) => readRecord(candidate).id === provenance.nodeId)
      .length !== 1 ||
    storedNode.type !== GENFEED_ACTION_NODE_TYPE ||
    typeof actionId !== 'string' ||
    !allowedActionIds.includes(actionId)
  )
    denyWorkflowActor();
  const result = readRecord(execution.result);
  const metadata = readRecord(result.metadata);
  if (
    metadata.canonicalId !== canonicalId ||
    !sources.includes(String(metadata.source))
  )
    denyWorkflowActor();
  return { execution, metadata, inputValues: readRecord(result.inputValues) };
}

/** A server closure supplied after persisted proof, never read from action/context JSON. */
export async function admitWorkflowDispatch(
  admission?: () => Promise<void>,
): Promise<void> {
  if (admission) {
    await admission();
    return;
  }
  if (isCloudDeployment()) denyWorkflowActor();
}
