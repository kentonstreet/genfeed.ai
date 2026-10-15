import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { captureWorkflowActor } from '@api/authorization/brand-access/workflow-actor.util';
import { WorkflowExecutionReadScopeService } from '@api/authorization/brand-access/workflow-execution-read-scope.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { SYSTEM_WORKFLOW_PRINCIPAL_ID } from '@genfeedai/contracts/interfaces';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: true }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
function fixture(role = MemberRole.USER, brands = ['brand']) {
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user' }) },
    member: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          role: { key: role },
          brands: brands.map((id) => ({ id })),
        }),
    },
    apiKey: { findFirst: vi.fn().mockResolvedValue({ scopes: ['read'] }) },
    workflowExecution: {
      findFirst: vi.fn().mockResolvedValue({ id: 'execution' }),
    },
  };
  const db = prisma as unknown as PrismaService;
  const service = new WorkflowExecutionReadScopeService(
    db,
    new BrandAccessService(db),
  );
  const actor = captureWorkflowActor({
    userId: 'user',
    organizationId: 'org',
    isApiKey: false,
    scopes: [],
  });
  return { prisma, service, actor };
}
describe('execution history fresh current-reader predicate', () => {
  beforeEach(() => {
    runtime.cloud = true;
  });
  it('retains the caller resource policy AND the fresh complete dependency predicate before the execution lookup', async () => {
    const f = fixture();
    const resource = { userId: 'secret-owner' };
    await f.service.assert(f.actor, 'execution', resource);
    expect(f.prisma.workflowExecution.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'execution',
        organizationId: 'org',
        isDeleted: false,
        AND: [resource, await f.service.predicate(f.actor)],
      },
      select: { id: true },
    });
    const predicate = JSON.stringify(await f.service.predicate(f.actor));
    expect(predicate).toContain('TRACKED');
    expect(predicate).toContain('BRAND_BOUND');
    expect(predicate).toContain('ORG_ONLY');
    expect(predicate).toContain('"id":{"in":["brand"]}');
  });
  it('uses explicit empty assignment dependencies while allowing only certified org-only scope', async () => {
    const f = fixture(MemberRole.USER, []);
    const predicate = await f.service.predicate(f.actor);
    expect(predicate).toMatchObject({
      organizationId: 'org',
      isDeleted: false,
      AND: [
        expect.anything(),
        {
          readScope: {
            is: {
              coverage: 'TRACKED',
              OR: [
                { scopeClass: 'ORG_ONLY', dependencies: { none: {} } },
                {
                  scopeClass: 'BRAND_BOUND',
                  dependencies: {
                    some: {},
                    none: {
                      OR: [
                        expect.anything(),
                        {
                          brand: {
                            isNot: {
                              organizationId: 'org',
                              isDeleted: false,
                              id: { in: [] },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    });
  });
  it.each([MemberRole.OWNER, MemberRole.ADMIN])(
    'preserves unrestricted canonical %s legacy history inside the existing protected root and resource arms',
    async (role) => {
      const f = fixture(role, []);
      const predicate = await f.service.predicate(f.actor);
      expect(predicate).toMatchObject({
        AND: [
          expect.anything(),
          { OR: [{ readScope: { is: null } }, expect.anything()] },
        ],
      });
      expect(JSON.stringify(predicate)).not.toContain('TRACKED');
    },
  );
  it('caps an owner key by captured AND current scopes before choosing unrestricted history access', async () => {
    const f = fixture(MemberRole.OWNER);
    const keyActor = captureWorkflowActor({
      ...f.actor,
      isApiKey: true,
      apiKeyId: 'key',
      scopes: ['admin', 'read'],
    });
    expect(JSON.stringify(await f.service.predicate(keyActor))).toContain(
      'TRACKED',
    );
    expect(f.prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'key',
          userId: 'user',
          organizationId: 'org',
          isRevoked: false,
        }),
      }),
    );
    expect(keyActor.scopes).toEqual(['admin', 'read']);
  });
  it('binds authored nullable-brand roots to the real tenant and retains only the two existing protected native SYSTEM arms', async () => {
    const f = fixture(MemberRole.OWNER);
    const predicate = await f.service.predicate(f.actor);
    expect(predicate).toMatchObject({
      AND: [
        {
          OR: [
            {
              workflow: {
                is: {
                  organizationId: 'org',
                  isDeleted: false,
                  OR: [{ brandId: null }, expect.anything()],
                },
              },
            },
            {
              workflow: {
                is: {
                  organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
                  isDeleted: false,
                  metadata: {
                    path: ['systemWorkflow', 'canonicalId'],
                    equals: 'agent.turn.execute',
                  },
                },
              },
              AND: expect.any(Array),
            },
            {
              workflow: {
                is: {
                  organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
                  isDeleted: false,
                  metadata: {
                    path: ['systemWorkflow', 'canonicalId'],
                    equals: 'workflow.batch.execute',
                  },
                },
              },
            },
          ],
        },
        expect.anything(),
      ],
    });
  });
  it('reads canonical membership again after revocation and denies opaquely before fetching any execution payload', async () => {
    const f = fixture();
    await f.service.predicate(f.actor);
    f.prisma.member.findFirst.mockResolvedValue(null);
    await expect(
      f.service.assert(f.actor, 'private-execution'),
    ).rejects.toThrow('Workflow execution not found');
    expect(f.prisma.workflowExecution.findFirst).not.toHaveBeenCalled();
  });
  it('denies a freshly revoked key before querying history and preserves opaque missing execution behavior', async () => {
    const f = fixture(MemberRole.ADMIN);
    const keyActor = captureWorkflowActor({
      ...f.actor,
      isApiKey: true,
      apiKeyId: 'key',
      scopes: ['admin'],
    });
    f.prisma.apiKey.findFirst.mockResolvedValue(null);
    await expect(
      f.service.assert(keyActor, 'private-execution'),
    ).rejects.toThrow('Workflow execution not found');
    expect(f.prisma.workflowExecution.findFirst).not.toHaveBeenCalled();
    f.prisma.workflowExecution.findFirst.mockResolvedValue(null);
    await expect(f.service.assert(f.actor, 'missing')).rejects.toThrow(
      'Workflow execution not found',
    );
  });
  it('preserves selfhost tenant/deletion and existing resource policy without requiring a Cloud coverage certificate', async () => {
    runtime.cloud = false;
    const f = fixture();
    expect(await f.service.predicate(f.actor)).toEqual({
      organizationId: 'org',
      isDeleted: false,
    });
    await f.service.assert(f.actor, 'execution', { userId: 'user' });
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
