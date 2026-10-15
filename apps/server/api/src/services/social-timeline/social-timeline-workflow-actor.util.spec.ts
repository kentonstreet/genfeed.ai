import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { workflowRequestKey } from '@api/authorization/brand-access/workflow-actor.util';
import {
  buildHiddenSystemWorkflowMetadata,
  SYSTEM_WORKFLOW_PRINCIPAL_ID,
} from '@api/collections/workflows/system-workflow.contract';
import type { SystemWorkflowActionRequest } from '@api/collections/workflows/system-workflow-runner.service';
import { buildWorkflowVersionDefinition } from '@api/collections/workflows/workflow-version-definition';
import {
  captureTimelineActor,
  refreshTimelineScope,
  timelineActorKey,
  validateTimelineWorkflowAction,
} from '@api/services/social-timeline/social-timeline-workflow-actor.util';
import {
  buildSocialTimelineActionWorkflow,
  SOCIAL_TIMELINE_WORKFLOW_ID,
} from '@api/services/social-timeline/social-timeline-workflow-definition';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { sha256Hex, stableStringify } from '@libs/utils/canonical-hash.util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: true }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
function fixture() {
  const scope = {
    organizationId: 'org',
    userId: 'actor',
    brandId: 'assigned',
    isApiKey: false,
    scopes: [] as string[],
    apiKeyId: undefined as string | undefined,
  };
  const stored = {
    organizationId: scope.organizationId,
    userId: scope.userId,
    brandId: scope.brandId,
    initiatingActor: captureTimelineActor(scope),
    postId: 'post',
    credentialId: 'credential',
    action: 'reply',
    idempotencyKey: 'request',
    text: 'Reply',
  };
  const execution = {
    userId: scope.userId,
    workflowId: 'workflow',
    workflowVersionId: 'pinned',
    workflow: {
      organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
      userId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
      isDeleted: false,
      metadata: {
        sourceType: 'hidden-system-workflow',
        systemWorkflow: buildHiddenSystemWorkflowMetadata({
          canonicalId: SOCIAL_TIMELINE_WORKFLOW_ID,
        }),
      },
    },
    workflowVersion: {
      id: 'pinned',
      ...buildWorkflowVersionDefinition(
        buildSocialTimelineActionWorkflow().definition,
      ),
      organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
      userId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
      workflowId: 'workflow',
    },
    result: {
      inputValues: { request: stored },
      metadata: {
        canonicalId: SOCIAL_TIMELINE_WORKFLOW_ID,
        source: 'SocialTimelineService.act',
        initiatingActorKey: timelineActorKey(captureTimelineActor(scope)),
        initiatingRequestKey: workflowRequestKey(stored),
      },
    },
  };
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: scope.userId }) },
    workflowExecution: { findFirst: vi.fn().mockResolvedValue(execution) },
    member: {
      findFirst: vi.fn().mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [{ id: scope.brandId }],
      }),
    },
    brand: { findFirst: vi.fn() },
    apiKey: { findFirst: vi.fn().mockResolvedValue({ scopes: ['admin'] }) },
  };
  prisma.brand.findFirst.mockImplementation(async (query) => {
    const clauses = query.where.AND;
    const ids = clauses[0].id?.in;
    return clauses[1].id === scope.brandId &&
      (ids === undefined || ids.includes(scope.brandId))
      ? { id: scope.brandId }
      : null;
  });
  const action = {
    context: {
      organizationId: scope.organizationId,
      userId: scope.userId,
      workflowId: 'workflow',
      workflowVersionId: 'pinned',
      runId: 'run',
    },
    provenance: {
      executionId: 'run',
      workflowId: 'workflow',
      workflowLabel: 'Following',
      nodeId: 'execute-action',
    },
    input: { request: structuredClone(stored) },
  } satisfies SystemWorkflowActionRequest;
  const db = prisma as unknown as PrismaService;
  return {
    scope,
    stored,
    execution,
    action,
    prisma,
    db,
    policy: new BrandAccessService(db),
  };
}
describe('persisted native timeline actor admission', () => {
  beforeEach(() => {
    runtime.cloud = true;
  });
  it('admits the pinned server request with actual live canonical assignment', async () => {
    const f = fixture();
    const admitted = await validateTimelineWorkflowAction(
      f.db,
      f.policy,
      f.action,
    );
    expect(admitted).toEqual({
      scope: { ...captureTimelineActor(f.scope), brandId: f.scope.brandId },
      postId: 'post',
      input: {
        action: 'reply',
        credentialId: 'credential',
        idempotencyKey: 'request',
        text: 'Reply',
      },
    });
    expect(f.prisma.workflowExecution.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run', organizationId: 'org', isDeleted: false },
      }),
    );
    expect(f.prisma.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'actor',
          organizationId: 'org',
          isActive: true,
          isDeleted: false,
          role: { isDeleted: false },
        }),
      }),
    );
  });
  it.each([
    'brandId',
    'postId',
    'credentialId',
    'action',
    'idempotencyKey',
    'text',
  ] as const)('denies supplied critical request tampering: %s', async (key) => {
    const f = fixture();
    f.action.input.request[key] = 'forged';
    await expect(
      validateTimelineWorkflowAction(f.db, f.policy, f.action),
    ).rejects.toThrow();
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
  });
  it.each([
    [
      'context principal',
      (f: ReturnType<typeof fixture>) => {
        f.action.context.userId = 'another';
      },
    ],
    [
      'execution provenance',
      (f: ReturnType<typeof fixture>) => {
        f.action.provenance.executionId = 'another';
      },
    ],
    [
      'pinned immutable version',
      (f: ReturnType<typeof fixture>) => {
        f.execution.workflowVersionId = 'newer';
      },
    ],
    [
      'custom graph mirror',
      (f: ReturnType<typeof fixture>) => {
        f.execution.workflow.organizationId = 'org';
      },
    ],
    [
      'deleted mirror',
      (f: ReturnType<typeof fixture>) => {
        f.execution.workflow.isDeleted = true;
      },
    ],
    [
      'stored graph hash',
      (f: ReturnType<typeof fixture>) => {
        f.execution.workflowVersion.contentHash = 'tampered';
      },
    ],
    [
      'registered action node',
      (f: ReturnType<typeof fixture>) => {
        f.action.provenance.nodeId = 'foreign-node';
      },
    ],
    [
      'rehashed foreign action',
      (f: ReturnType<typeof fixture>) => {
        f.execution.workflowVersion.graph.nodes[0].data.config.actionId =
          'foreign-action';
        const version = f.execution.workflowVersion;
        version.contentHash = `sha256:v1:${sha256Hex(stableStringify({ graph: version.graph, inputSchema: version.inputSchema }))}`;
      },
    ],
    [
      'version principal',
      (f: ReturnType<typeof fixture>) => {
        f.execution.workflowVersion.userId = 'actor';
      },
    ],
    [
      'canonical workflow',
      (f: ReturnType<typeof fixture>) => {
        f.execution.result.metadata.canonicalId = 'custom';
      },
    ],
    [
      'producer source',
      (f: ReturnType<typeof fixture>) => {
        f.execution.result.metadata.source = 'client';
      },
    ],
    [
      'actor binding',
      (f: ReturnType<typeof fixture>) => {
        f.execution.result.metadata.initiatingActorKey = 'forged';
      },
    ],
    [
      'persisted actor principal',
      (f: ReturnType<typeof fixture>) => {
        f.stored.initiatingActor.userId = 'another';
      },
    ],
  ] as const)(
    'denies malformed or forged %s before brand admission',
    async (_title, tamper) => {
      const f = fixture();
      tamper(f);
      await expect(
        validateTimelineWorkflowAction(f.db, f.policy, f.action),
      ).rejects.toThrow();
      expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
    },
  );
  it('fails closed when the persisted execution or captured actor is missing', async () => {
    const f = fixture();
    f.prisma.workflowExecution.findFirst.mockResolvedValue(null);
    await expect(
      validateTimelineWorkflowAction(f.db, f.policy, f.action),
    ).rejects.toThrow();
    f.prisma.workflowExecution.findFirst.mockResolvedValue(f.execution);
    Reflect.deleteProperty(f.stored, 'initiatingActor');
    await expect(
      validateTimelineWorkflowAction(f.db, f.policy, f.action),
    ).rejects.toThrow();
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
  });
  it('never trusts a supplied actor or runtime context to grant privilege', async () => {
    const f = fixture();
    f.action.input.request.initiatingActor.userId = 'owner';
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [],
    });
    await expect(
      validateTimelineWorkflowAction(f.db, f.policy, f.action),
    ).rejects.toThrow('Brand access denied');
    expect(f.prisma.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'actor' }),
      }),
    );
  });
  it('denies foreign brands, empty assignments and fresh inactive membership', async () => {
    const f = fixture();
    await expect(
      refreshTimelineScope(f.db, f.policy, { ...f.scope, brandId: 'foreign' }),
    ).rejects.toThrow('Brand access denied');
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [],
    });
    await expect(refreshTimelineScope(f.db, f.policy, f.scope)).rejects.toThrow(
      'Brand access denied',
    );
    f.prisma.member.findFirst.mockResolvedValue(null);
    await expect(refreshTimelineScope(f.db, f.policy, f.scope)).rejects.toThrow(
      'Brand access denied',
    );
  });
  it('checks canonical privilege anew and caps owner API keys before admission', async () => {
    const f = fixture();
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    await expect(
      refreshTimelineScope(f.db, f.policy, f.scope),
    ).resolves.toMatchObject({ userId: 'actor' });
    await expect(
      refreshTimelineScope(f.db, f.policy, {
        ...f.scope,
        isApiKey: true,
        apiKeyId: 'key',
      }),
    ).rejects.toThrow('Brand access denied');
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [],
    });
    await expect(refreshTimelineScope(f.db, f.policy, f.scope)).rejects.toThrow(
      'Brand access denied',
    );
  });
  it('intersects captured key scopes with the fresh key and denies expiry or revocation', async () => {
    const f = fixture();
    const keyed = {
      ...f.scope,
      isApiKey: true,
      apiKeyId: 'key',
      scopes: ['admin'],
    };
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    await expect(
      refreshTimelineScope(f.db, f.policy, keyed),
    ).resolves.toMatchObject({ scopes: ['admin'] });
    f.prisma.apiKey.findFirst.mockResolvedValue({ scopes: [] });
    await expect(refreshTimelineScope(f.db, f.policy, keyed)).rejects.toThrow(
      'Brand access denied',
    );
    f.prisma.apiKey.findFirst.mockResolvedValue(null);
    await expect(refreshTimelineScope(f.db, f.policy, keyed)).rejects.toThrow(
      'Brand access denied',
    );
    expect(f.prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'key',
        userId: 'actor',
        organizationId: 'org',
        isRevoked: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      select: { scopes: true },
    });
  });
  it('preserves explicit selfhost native request semantics without inventing Cloud authority', async () => {
    const f = fixture();
    runtime.cloud = false;
    Reflect.deleteProperty(f.action.input.request, 'initiatingActor');
    await expect(
      validateTimelineWorkflowAction(f.db, f.policy, f.action),
    ).resolves.toMatchObject({ postId: 'post' });
    expect(f.prisma.workflowExecution.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
  });
});
