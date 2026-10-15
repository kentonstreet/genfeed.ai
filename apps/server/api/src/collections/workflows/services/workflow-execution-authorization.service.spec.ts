import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { captureWorkflowActor } from '@api/authorization/brand-access/workflow-actor.util';
import { WorkflowExecutionAuthorizationService } from '@api/collections/workflows/services/workflow-execution-authorization.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
const scope = {
  brandId: 'brand-1',
  contextVersion: 3,
  isLegacyFallback: false,
  isVersionExplicit: true,
  organizationId: 'org-1',
  source: 'explicit',
  threadId: 'thread-1',
  userId: 'user-1',
} as const;

describe('WorkflowExecutionAuthorizationService', () => {
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
    member: {
      findFirst: vi.fn().mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [{ id: 'brand-1' }],
      }),
    },
    apiKey: { findFirst: vi.fn().mockResolvedValue({ scopes: ['admin'] }) },
    brand: {
      findFirst: vi.fn(
        async (query: {
          where: { AND: { id?: string | { in?: string[] } }[] };
        }) => {
          const allowed = query.where.AND[0].id;
          return query.where.AND[1].id === 'brand-1' &&
            (typeof allowed !== 'object' ||
              allowed.in === undefined ||
              allowed.in.includes('brand-1'))
            ? { id: 'brand-1' }
            : null;
        },
      ),
    },
    workflow: {
      findFirst: vi.fn(),
    },
  };
  const agentScopeContextService = {
    assertConsequentialBoundary: vi.fn(),
    assertResourceBrand: vi.fn(),
    prepareForTurn: vi.fn(),
  };
  const service = new WorkflowExecutionAuthorizationService(
    prisma as never,
    agentScopeContextService as never,
    new BrandAccessService(prisma as unknown as PrismaService),
  );

  beforeEach(() => {
    runtime.cloud = false;
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [{ id: 'brand-1' }],
    });
    prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['admin'] });
    vi.clearAllMocks();
    agentScopeContextService.prepareForTurn.mockResolvedValue({
      existingScope: scope,
    });
    prisma.workflow.findFirst.mockResolvedValue({
      brandId: 'brand-1',
      id: 'workflow-1',
    });
  });

  it('preserves the existing direct-route authorization path without shell state', async () => {
    await expect(
      service.authorize({
        organizationId: 'org-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
      }),
    ).resolves.toBeUndefined();

    expect(agentScopeContextService.prepareForTurn).not.toHaveBeenCalled();
    expect(prisma.workflow.findFirst).not.toHaveBeenCalled();
  });

  it('requires the thread and context version as one authorization unit', async () => {
    await expect(
      service.authorize({
        organizationId: 'org-1',
        threadId: 'thread-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(agentScopeContextService.prepareForTurn).not.toHaveBeenCalled();
  });

  it('validates stale context and exact workflow brand before execution', async () => {
    await expect(
      service.authorize({
        expectedContextVersion: 3,
        organizationId: 'org-1',
        requestedBrandId: 'brand-1',
        threadId: 'thread-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
      }),
    ).resolves.toBe(scope);

    expect(agentScopeContextService.prepareForTurn).toHaveBeenCalledWith({
      expectedContextVersion: 3,
      organizationId: 'org-1',
      requestedBrandId: 'brand-1',
      threadId: 'thread-1',
      userId: 'user-1',
    });
    expect(
      agentScopeContextService.assertConsequentialBoundary,
    ).toHaveBeenCalledWith(scope, 'workflow');
    expect(prisma.workflow.findFirst).toHaveBeenCalledWith({
      select: { brandId: true, id: true },
      where: {
        id: 'workflow-1',
        isDeleted: false,
        organizationId: 'org-1',
      },
    });
    expect(agentScopeContextService.assertResourceBrand).toHaveBeenCalledWith(
      scope,
      'brand-1',
      'workflow',
    );
  });

  it('rejects a workflow outside the validated thread brand before engine execution', async () => {
    agentScopeContextService.assertResourceBrand.mockImplementationOnce(() => {
      throw new ForbiddenException('outside scope');
    });

    await expect(
      service.authorize({
        expectedContextVersion: 3,
        organizationId: 'org-1',
        threadId: 'thread-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('requires actual Cloud caller authority before a direct private workflow lookup', async () => {
    runtime.cloud = true;
    await expect(
      service.authorize({
        organizationId: 'org-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
      }),
    ).rejects.toThrow('Brand access denied');
    expect(prisma.workflow.findFirst).not.toHaveBeenCalled();
  });
  it('admits a direct caller only through a current authorized brand predicate', async () => {
    runtime.cloud = true;
    const actor = captureWorkflowActor({
      organizationId: 'org-1',
      userId: 'user-1',
    });
    await expect(
      service.authorize({
        organizationId: 'org-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
        initiatingActor: actor,
      }),
    ).resolves.toBeUndefined();
    expect(prisma.workflow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          isDeleted: false,
          OR: [
            { brandId: null },
            {
              brand: {
                is: {
                  organizationId: 'org-1',
                  isDeleted: false,
                  id: { in: ['brand-1'] },
                },
              },
            },
          ],
        }),
      }),
    );
  });
  it('rechecks canonical membership after the private workflow await', async () => {
    runtime.cloud = true;
    prisma.workflow.findFirst.mockImplementationOnce(async () => {
      prisma.member.findFirst.mockResolvedValue(null);
      return { id: 'workflow-1', brandId: 'brand-1' };
    });
    await expect(
      service.authorize({
        organizationId: 'org-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
        initiatingActor: captureWorkflowActor({
          organizationId: 'org-1',
          userId: 'user-1',
        }),
      }),
    ).rejects.toThrow('Brand access denied');
    expect(agentScopeContextService.prepareForTurn).not.toHaveBeenCalled();
  });
  it('passes fresh captured/current key intersection into actual thread preparation', async () => {
    runtime.cloud = true;
    const actor = captureWorkflowActor({
      organizationId: 'org-1',
      userId: 'user-1',
      isApiKey: true,
      apiKeyId: 'key',
      scopes: ['admin', 'read'],
    });
    prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['read'] });
    await expect(
      service.authorize({
        organizationId: 'org-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
        threadId: 'thread-1',
        expectedContextVersion: 3,
        initiatingActor: actor,
      }),
    ).resolves.toBe(scope);
    expect(agentScopeContextService.prepareForTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        isApiKey: true,
        apiKeyId: 'key',
        scopes: ['read'],
      }),
    );
  });
  it('does not upgrade an owner API key after its current admin scope is removed', async () => {
    runtime.cloud = true;
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['read'] });
    await expect(
      service.authorize({
        organizationId: 'org-1',
        userId: 'user-1',
        workflowId: 'workflow-1',
        initiatingActor: captureWorkflowActor({
          organizationId: 'org-1',
          userId: 'user-1',
          isApiKey: true,
          apiKeyId: 'key',
          scopes: ['admin', 'read'],
        }),
      }),
    ).rejects.toThrow('Brand access denied');
    expect(agentScopeContextService.prepareForTurn).not.toHaveBeenCalled();
  });
});
