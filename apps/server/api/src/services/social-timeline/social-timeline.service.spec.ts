import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  buildHiddenSystemWorkflowMetadata,
  SYSTEM_WORKFLOW_PRINCIPAL_ID,
} from '@api/collections/workflows/system-workflow.contract';
import type {
  RunSystemWorkflowInput,
  SystemWorkflowActionExecutor,
  SystemWorkflowRunnerService,
} from '@api/collections/workflows/system-workflow-runner.service';
import { SocialTimelineService } from '@api/services/social-timeline/social-timeline.service';
import type { SocialTimelineProviderService } from '@api/services/social-timeline/social-timeline-provider.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => true,
}));

const scope = { organizationId: 'org-a', brandId: 'brand-a', userId: 'user-a' };
const input = {
  action: 'reply' as const,
  credentialId: 'credential-a',
  idempotencyKey: 'request-a',
  text: 'An actual reply',
};
const post = { id: 'post-a', platform: 'twitter', externalId: 'tweet-a' };

describe('connected timeline isolation and action delivery', () => {
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'actor' }) },
    member: { findFirst: vi.fn() },
    brand: { findFirst: vi.fn() },
    apiKey: { findFirst: vi.fn() },
    workflowExecution: { findFirst: vi.fn() },
    credential: { findFirst: vi.fn(), findMany: vi.fn() },
    socialSource: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    sourcePost: { findFirst: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    sourcePostNativeAction: {
      create: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const provider = { collect: vi.fn(), execute: vi.fn() };
  let executor: SystemWorkflowActionExecutor;
  const workflows = {
    registerWorkflow: vi.fn(),
    registerAction: vi.fn(
      (_id: string, action: SystemWorkflowActionExecutor) => {
        executor = action;
      },
    ),
    runWorkflow: vi.fn(),
  };
  const service = new SocialTimelineService(
    prisma as unknown as PrismaService,
    provider as unknown as SocialTimelineProviderService,
    workflows as unknown as SystemWorkflowRunnerService,
    new BrandAccessService(prisma as unknown as PrismaService),
  );
  beforeEach(() => {
    vi.resetAllMocks();
    workflows.registerAction.mockImplementation(
      (_id: string, action: SystemWorkflowActionExecutor) => {
        executor = action;
      },
    );
    service.onModuleInit();
    workflows.runWorkflow.mockImplementation(
      async (request: RunSystemWorkflowInput) => {
        prisma.workflowExecution.findFirst.mockResolvedValue({
          userId: request.userId,
          workflowId: 'workflow',
          workflowVersionId: 'version',
          workflow: {
            isDeleted: false,
            organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
            userId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
            metadata: {
              sourceType: 'hidden-system-workflow',
              systemWorkflow: buildHiddenSystemWorkflowMetadata({
                canonicalId: request.canonicalId,
              }),
            },
          },
          workflowVersion: {
            workflowId: 'workflow',
            organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
            userId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
          },
          result: {
            inputValues: structuredClone(request.inputValues),
            metadata: {
              ...request.metadata,
              canonicalId: request.canonicalId,
              source: request.source,
            },
          },
        });
        return {
          result: await executor({
            input: request.inputValues ?? {},
            context: {
              organizationId: request.organizationId,
              userId: request.userId ?? '',
              workflowId: 'workflow',
              workflowVersionId: 'version',
              runId: 'run',
            },
            provenance: {
              executionId: 'run',
              workflowId: 'workflow',
              workflowLabel: 'Following',
            },
          }),
        };
      },
    );
    prisma.user.findFirst.mockResolvedValue({ id: scope.userId });
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [{ id: scope.brandId }],
    });
    prisma.brand.findFirst.mockImplementation(async (query) => {
      const clauses = query.where.AND;
      const allowed = clauses[0].id?.in;
      return clauses[1].id === scope.brandId &&
        (allowed === undefined || allowed.includes(scope.brandId))
        ? { id: scope.brandId }
        : null;
    });
    prisma.$transaction.mockImplementation(async (run) => run(prisma));
    prisma.credential.findMany.mockResolvedValue([]);
    prisma.socialSource.findMany.mockResolvedValue([]);
    prisma.sourcePost.findFirst.mockResolvedValue(post);
    prisma.credential.findFirst.mockResolvedValue({
      id: 'credential-a',
      platform: 'TWITTER',
    });
    prisma.sourcePostNativeAction.create.mockResolvedValue({ id: 'receipt-a' });
    prisma.sourcePostNativeAction.updateMany.mockResolvedValue({ count: 1 });
    provider.execute.mockResolvedValue('published-reply-a');
  });

  it('never ingests on GET, and scopes credentials, sources and nested posts', async () => {
    expect(await service.read(scope)).toEqual({ accounts: [] });
    expect(provider.collect).not.toHaveBeenCalled();
    expect(prisma.credential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          brandId: 'brand-a',
          isDeleted: false,
        }),
      }),
    );
    expect(prisma.socialSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          brandId: 'brand-a',
          sourceType: 'timeline',
          isDeleted: false,
        }),
        include: expect.objectContaining({
          posts: expect.objectContaining({
            where: expect.objectContaining({
              organizationId: 'org-a',
              brandId: 'brand-a',
              isDeleted: false,
            }),
          }),
        }),
      }),
    );
  });

  it('does not substitute own-account uploads or watched profiles for home feeds', async () => {
    prisma.credential.findMany.mockResolvedValue([
      {
        id: 'ig-a',
        platform: 'INSTAGRAM',
        externalName: 'My Instagram',
        isConnected: true,
      },
    ]);
    const result = await service.read(scope);
    expect(result.accounts[0]).toMatchObject({
      credentialId: 'ig-a',
      kind: 'unsupported',
      status: 'unsupported',
      posts: [],
      actions: [],
    });
    expect(provider.collect).not.toHaveBeenCalled();
  });

  it('reserves before publishing, validates both post and selected account in the tenant, and saves the platform receipt', async () => {
    expect(await service.act(scope, post.id, input)).toMatchObject({
      status: 'completed',
      externalId: 'published-reply-a',
    });
    expect(workflows.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: 'social.timeline.native-action',
        organizationId: scope.organizationId,
        userId: scope.userId,
      }),
    );
    expect(prisma.sourcePost.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: post.id,
        organizationId: 'org-a',
        brandId: 'brand-a',
        isDeleted: false,
      }),
    });
    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: input.credentialId,
        organizationId: 'org-a',
        brandId: 'brand-a',
        platform: 'TWITTER',
        isConnected: true,
        isDeleted: false,
      }),
    });
    expect(
      prisma.sourcePostNativeAction.create.mock.invocationCallOrder[0],
    ).toBeLessThan(provider.execute.mock.invocationCallOrder[0]);
    expect(prisma.sourcePostNativeAction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'completed', externalId: 'published-reply-a' },
        where: expect.objectContaining({
          organizationId: 'org-a',
          brandId: 'brand-a',
          id: 'receipt-a',
        }),
      }),
    );
  });

  it('rejects a workflow request whose actor or organization differs from its execution context', async () => {
    workflows.runWorkflow.mockImplementationOnce(
      async (request: RunSystemWorkflowInput) => ({
        result: await executor({
          input: request.inputValues ?? {},
          context: {
            organizationId: 'another-org',
            userId: 'another-user',
            workflowId: 'workflow',
            workflowVersionId: 'version',
            runId: 'run',
          },
          provenance: {
            executionId: 'run',
            workflowId: 'workflow',
            workflowLabel: 'Following',
          },
        }),
      }),
    );
    await expect(service.act(scope, post.id, input)).rejects.toThrow(
      'scope does not match',
    );
    expect(prisma.sourcePostNativeAction.create).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429])(
    'persists a definite provider rejection %s as failed and replays its receipt without publication',
    async (status) => {
      provider.execute.mockRejectedValue({ status });
      const first = await service.act(scope, post.id, input);
      expect(first.status).toBe('failed');
      expect(first.message).not.toContain('could not be confirmed');
      const saved = prisma.sourcePostNativeAction.create.mock.calls[0][0].data;
      prisma.sourcePostNativeAction.findFirst.mockResolvedValue({
        ...saved,
        ...first,
      });
      expect(await service.act(scope, post.id, input)).toMatchObject(first);
      expect(provider.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('does not execute the same request twice, including uncertain delivery', async () => {
    provider.execute.mockRejectedValue(
      new Error('socket closed after publication'),
    );
    const first = await service.act(scope, post.id, input);
    const saved = prisma.sourcePostNativeAction.create.mock.calls[0][0].data;
    prisma.sourcePostNativeAction.create.mockRejectedValue({ code: 'P2002' });
    prisma.sourcePostNativeAction.findFirst.mockResolvedValue({
      ...saved,
      id: first.id,
      status: 'uncertain',
      message: first.message,
    });
    const retried = await service.act(scope, post.id, input);
    expect(first.status).toBe('uncertain');
    expect(retried).toMatchObject(first);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('can confirm a saved action after a refresh removes the post, without republishing', async () => {
    await service.act(scope, post.id, input);
    const saved = prisma.sourcePostNativeAction.create.mock.calls[0][0].data;
    prisma.sourcePost.findFirst.mockResolvedValue(null);
    prisma.sourcePostNativeAction.findFirst.mockResolvedValue({
      ...saved,
      id: 'receipt-a',
      status: 'completed',
      externalId: 'published-reply-a',
    });
    expect(await service.act(scope, post.id, input)).toMatchObject({
      status: 'completed',
      externalId: 'published-reply-a',
    });
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an action key for changed text', async () => {
    await service.act(scope, post.id, input);
    const saved = prisma.sourcePostNativeAction.create.mock.calls[0][0].data;
    prisma.sourcePostNativeAction.create.mockRejectedValue({ code: 'P2002' });
    prisma.sourcePostNativeAction.findFirst.mockResolvedValue({
      ...saved,
      status: 'completed',
    });
    await expect(
      service.act(scope, post.id, { ...input, text: 'Different reply' }),
    ).rejects.toThrow('another request');
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('never publishes when another tenant owns the post or credential', async () => {
    prisma.sourcePost.findFirst.mockResolvedValue(null);
    await expect(service.act(scope, 'foreign-post', input)).rejects.toThrow();
    prisma.sourcePost.findFirst.mockResolvedValue(post);
    prisma.credential.findFirst.mockResolvedValue(null);
    await expect(service.act(scope, post.id, input)).rejects.toThrow();
    expect(prisma.sourcePostNativeAction.create).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('rejects empty text and unsupported native actions before reserving', async () => {
    await expect(
      service.act(scope, post.id, { ...input, text: '  ' }),
    ).rejects.toThrow('Enter the text');
    prisma.sourcePost.findFirst.mockResolvedValue({
      ...post,
      platform: 'instagram',
    });
    await expect(service.act(scope, post.id, input)).rejects.toThrow(
      'does not support',
    );
    expect(prisma.sourcePostNativeAction.create).not.toHaveBeenCalled();
  });
  it.each(['read', 'refresh', 'act'] as const)(
    'denies zero assignments before %s private reads or provider dispatch',
    async (method) => {
      prisma.member.findFirst.mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [],
      });
      const result =
        method === 'act'
          ? service.act(scope, post.id, input)
          : service[method](scope);
      await expect(result).rejects.toThrow('Brand access denied');
      expect(prisma.credential.findMany).not.toHaveBeenCalled();
      expect(prisma.socialSource.findMany).not.toHaveBeenCalled();
      expect(prisma.sourcePost.findFirst).not.toHaveBeenCalled();
      expect(workflows.runWorkflow).not.toHaveBeenCalled();
      expect(provider.collect).not.toHaveBeenCalled();
      expect(provider.execute).not.toHaveBeenCalled();
    },
  );

  it('denies foreign brands before reading credentials or nested timeline posts', async () => {
    await expect(
      service.read({ ...scope, brandId: 'foreign-brand' }),
    ).rejects.toThrow('Brand access denied');
    expect(prisma.credential.findMany).not.toHaveBeenCalled();
    expect(prisma.socialSource.findMany).not.toHaveBeenCalled();
  });

  it('reauthorizes a previously read timeline immediately after assignment revocation', async () => {
    await expect(service.read(scope)).resolves.toEqual({ accounts: [] });
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [],
    });
    await expect(service.read(scope)).rejects.toThrow('Brand access denied');
    expect(prisma.credential.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.socialSource.findMany).toHaveBeenCalledTimes(1);
  });

  it('caps an owner API key against fresh scopes before any private read', async () => {
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    prisma.apiKey.findFirst.mockResolvedValue({ scopes: [] });
    await expect(
      service.read({
        ...scope,
        isApiKey: true,
        apiKeyId: 'key',
        scopes: ['admin'],
      }),
    ).rejects.toThrow('Brand access denied');
    expect(prisma.credential.findMany).not.toHaveBeenCalled();
  });

  it('does not turn a revoked reservation into success or provider uncertainty', async () => {
    prisma.$transaction.mockImplementationOnce(async (run) => {
      const receipt = await run(prisma);
      prisma.member.findFirst.mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [],
      });
      return receipt;
    });
    await expect(service.act(scope, post.id, input)).rejects.toThrow(
      'Brand access denied',
    );
    expect(prisma.sourcePostNativeAction.create).toHaveBeenCalledTimes(1);
    expect(prisma.sourcePostNativeAction.updateMany).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('picks only native receipt fields and captures no bearer, secret or auth state in Prisma data', async () => {
    await service.act(scope, post.id, input);
    expect(
      Object.keys(
        prisma.sourcePostNativeAction.create.mock.calls[0][0].data,
      ).sort(),
    ).toEqual([
      'action',
      'brandId',
      'credentialId',
      'idempotencyKey',
      'organizationId',
      'postId',
      'requestHash',
      'userId',
    ]);
    const queued = workflows.runWorkflow.mock.calls[0][0];
    expect(queued.inputValues.request.initiatingActor).toEqual({
      organizationId: scope.organizationId,
      userId: scope.userId,
      isApiKey: false,
      scopes: [],
    });
    expect(queued.metadata.initiatingActorKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([MemberRole.OWNER, MemberRole.ADMIN])(
    'retains all-brand timeline admission for the current canonical %s with no assignments',
    async (role) => {
      prisma.member.findFirst.mockResolvedValue({
        role: { key: role },
        brands: [],
      });
      await expect(service.read(scope)).resolves.toEqual({ accounts: [] });
      expect(prisma.credential.findMany).toHaveBeenCalledOnce();
      expect(prisma.socialSource.findMany).toHaveBeenCalledOnce();
    },
  );

  it.each(['user', 'apiKey', 'member'] as const)(
    'denies a removed current %s before any timeline resource query',
    async (delegate) => {
      prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['admin'] });
      prisma[delegate].findFirst.mockResolvedValueOnce(null);
      await expect(
        service.read({
          ...scope,
          isApiKey: true,
          apiKeyId: 'key',
          scopes: ['admin'],
        }),
      ).rejects.toThrow('Brand access denied');
      expect(prisma.credential.findMany).not.toHaveBeenCalled();
      expect(prisma.socialSource.findMany).not.toHaveBeenCalled();
      expect(provider.collect).not.toHaveBeenCalled();
    },
  );

  it('does not gain owner privileges from an admin scope added after key capture', async () => {
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['admin', 'read'] });
    await expect(
      service.read({
        ...scope,
        isApiKey: true,
        apiKeyId: 'key',
        scopes: ['read'],
      }),
    ).rejects.toThrow('Brand access denied');
    expect(prisma.credential.findMany).not.toHaveBeenCalled();
  });

  it('does not acknowledge or rewrite a native receipt after authority is revoked during provider dispatch', async () => {
    provider.execute.mockImplementationOnce(async () => {
      prisma.member.findFirst.mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [],
      });
      return 'submitted-reply';
    });
    await expect(service.act(scope, post.id, input)).rejects.toThrow(
      'Brand access denied',
    );
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(prisma.sourcePostNativeAction.create).toHaveBeenCalledOnce();
    expect(prisma.sourcePostNativeAction.updateMany).not.toHaveBeenCalled();
  });

  it('retains all-brand admission for a current owner key with explicit live admin scope', async () => {
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['admin'] });
    await expect(
      service.read({
        ...scope,
        isApiKey: true,
        apiKeyId: 'key',
        scopes: ['admin'],
      }),
    ).resolves.toEqual({ accounts: [] });
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'key',
          organizationId: scope.organizationId,
          userId: scope.userId,
          isRevoked: false,
        }),
      }),
    );
    expect(prisma.credential.findMany).toHaveBeenCalledOnce();
  });
});
