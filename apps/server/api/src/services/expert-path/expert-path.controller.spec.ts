import type { AuthenticatedUser } from '@api/auth/interfaces/authenticated-user.interface';
import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { SystemWorkflowRunnerService } from '@api/collections/workflows/system-workflow-runner.service';
import { ExpertPathController } from '@api/services/expert-path/expert-path.controller';
import { ExpertFirstSystemService } from '@api/services/expert-path/services/expert-first-system.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { ContentPlanItemStatus, MemberRole } from '@genfeedai/contracts';
import { EXPERT_FIRST_SYSTEM_PLAN_SOURCE } from '@genfeedai/contracts/constants';
import type { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: true }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
vi.mock('@api/helpers/utils/response/response.util', () => ({
  serializeCollection: (
    _request: unknown,
    _serializer: unknown,
    result: { docs: unknown },
  ) => result.docs,
  serializeSingle: (_request: unknown, _serializer: unknown, item: unknown) =>
    item,
}));
function fixture() {
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user' }) },
    member: {
      findFirst: vi.fn().mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [{ id: 'brand' }],
      }),
    },
    apiKey: { findFirst: vi.fn().mockResolvedValue({ scopes: ['read'] }) },
    brand: { findFirst: vi.fn() },
  };
  prisma.brand.findFirst.mockImplementation(async ({ where }) => {
    const ids = where.AND[0].id?.in;
    const id = where.AND[1].id;
    return id === 'brand' && (ids === undefined || ids.includes(id))
      ? { id }
      : null;
  });
  const plans = {
    getByIdOrFail: vi.fn().mockResolvedValue({
      id: 'plan',
      provenance: { source: EXPERT_FIRST_SYSTEM_PLAN_SOURCE },
    }),
  };
  const items = {
    getByIdOrFail: vi.fn().mockResolvedValue({
      id: 'item',
      planId: 'plan',
      status: ContentPlanItemStatus.PENDING,
    }),
    listByPlan: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn(),
    updateContent: vi.fn(),
  };
  const runner = { runWorkflow: vi.fn().mockResolvedValue({}) };
  const moduleRef = {
    get: vi.fn((token: unknown) => {
      if (token !== SystemWorkflowRunnerService)
        throw new Error('Unexpected module lookup');
      return runner;
    }),
  } as unknown as ModuleRef;
  const db = prisma as unknown as PrismaService;
  const memory = {
    listTypedEntries: vi
      .fn()
      .mockResolvedValue([{ metadata: { planId: 'plan' } }]),
  };
  const firstSystem = new ExpertFirstSystemService(
    db,
    memory as never,
    items as never,
    {} as never,
    plans as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    moduleRef,
    new BrandAccessService(db),
  );
  const statusService = { getStatus: vi.fn().mockResolvedValue({}) };
  const positioningService = {
    generateDraft: vi
      .fn()
      .mockResolvedValue({ profile: { id: 'profile' }, score: 1 }),
  };
  const currentPlan = vi
    .spyOn(firstSystem, 'getCurrentPlan')
    .mockResolvedValue(null);
  const generate = vi
    .spyOn(firstSystem, 'generate')
    .mockResolvedValue({ items: [], plan: {}, provenance: {} } as never);
  const controller = new ExpertPathController(
    statusService as never,
    positioningService as never,
    firstSystem,
    new BrandAccessService(db),
    db,
  );
  const user = {
    id: 'user',
    userId: 'user',
    organizationId: 'org',
    isApiKey: false,
    scopes: [],
  } as AuthenticatedUser;
  const invoke = (actingUser: AuthenticatedUser = user, brandId = 'brand') =>
    controller.reviewFirstSystemItem(
      {} as Request,
      brandId,
      'plan',
      'item',
      { action: 'approve' },
      actingUser,
    );
  const privateEndpoint = (endpoint: string, actingUser = user) => {
    if (endpoint === 'status') return controller.getStatus('brand', actingUser);
    if (endpoint === 'positioning')
      return controller.regeneratePositioning('brand', actingUser);
    if (endpoint === 'generate')
      return controller.generateFirstSystem({} as Request, 'brand', actingUser);
    return controller.getFirstSystem({} as Request, 'brand', actingUser);
  };
  return {
    prisma,
    plans,
    items,
    runner,
    user,
    invoke,
    privateEndpoint,
    statusService,
    positioningService,
    currentPlan,
    generate,
    memory,
    firstSystem,
  };
}
describe('ExpertPath authenticated item producer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.cloud = true;
  });
  it.each(['status', 'positioning', 'generate', 'current-plan'])(
    'denies an unassigned brand before the %s private service call',
    async (endpoint) => {
      const f = fixture();
      f.prisma.member.findFirst.mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [],
      });
      await expect(f.privateEndpoint(endpoint)).rejects.toThrow(
        'Brand access denied',
      );
      expect(f.statusService.getStatus).not.toHaveBeenCalled();
      expect(f.positioningService.generateDraft).not.toHaveBeenCalled();
      expect(f.currentPlan).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
    },
  );
  it('denies missing Cloud reader authority before current-plan memory access', async () => {
    const f = fixture();
    f.currentPlan.mockRestore();
    await expect(f.firstSystem.getCurrentPlan('org', 'brand')).rejects.toThrow(
      'Brand access denied',
    );
    expect(f.memory.listTypedEntries).not.toHaveBeenCalled();
    expect(f.plans.getByIdOrFail).not.toHaveBeenCalled();
  });
  it('rechecks before returning an empty current-plan result after memory access', async () => {
    const f = fixture();
    f.currentPlan.mockRestore();
    f.memory.listTypedEntries.mockImplementation(async () => {
      f.prisma.member.findFirst.mockResolvedValue(null as never);
      return [];
    });
    await expect(f.privateEndpoint('current-plan')).rejects.toThrow(
      'Brand access denied',
    );
    expect(f.plans.getByIdOrFail).not.toHaveBeenCalled();
    expect(f.items.listByPlan).not.toHaveBeenCalled();
  });
  it('denies a role/assignment revoked after the plan read before item-query execution', async () => {
    const f = fixture();
    f.currentPlan.mockRestore();
    f.plans.getByIdOrFail.mockImplementation(async () => {
      f.prisma.member.findFirst.mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [],
      });
      return {
        id: 'plan',
        provenance: { source: EXPERT_FIRST_SYSTEM_PLAN_SOURCE },
      };
    });
    await expect(f.privateEndpoint('current-plan')).rejects.toThrow(
      'Brand access denied',
    );
    expect(f.items.listByPlan).not.toHaveBeenCalled();
  });
  it('denies a live key revoked while loading items before returning private results', async () => {
    const f = fixture();
    f.currentPlan.mockRestore();
    f.items.listByPlan.mockImplementation(async () => {
      f.prisma.apiKey.findFirst.mockResolvedValue(null as never);
      return [{ id: 'item' }];
    });
    await expect(
      f.privateEndpoint('current-plan', {
        ...f.user,
        isApiKey: true,
        apiKeyId: 'key',
        scopes: ['read'],
      } as AuthenticatedUser),
    ).rejects.toThrow('Brand access denied');
    expect(f.items.listByPlan).toHaveBeenCalledWith('org', 'plan');
  });
  it('returns the currently admitted plan and items using the actual reader', async () => {
    const f = fixture();
    f.currentPlan.mockRestore();
    await expect(f.privateEndpoint('current-plan')).resolves.toEqual({
      items: [],
      plan: {
        id: 'plan',
        provenance: { source: EXPERT_FIRST_SYSTEM_PLAN_SOURCE },
      },
    });
    expect(f.memory.listTypedEntries).toHaveBeenCalled();
    expect(f.plans.getByIdOrFail).toHaveBeenCalledWith('org', 'plan', 'brand');
    expect(f.items.listByPlan).toHaveBeenCalledWith('org', 'plan');
  });
  it('preserves unrestricted canonical owner admission without brand assignments', async () => {
    const f = fixture();
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    await f.privateEndpoint('status');
    expect(f.statusService.getStatus).toHaveBeenCalledWith(
      'org',
      'brand',
      expect.objectContaining({ organizationId: 'org', userId: 'user' }),
    );
  });
  it('retains selfhost brand admission without a Cloud membership requirement', async () => {
    const f = fixture();
    runtime.cloud = false;
    f.prisma.member.findFirst.mockResolvedValue(null as never);
    await f.privateEndpoint('status');
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
    expect(f.statusService.getStatus).toHaveBeenCalledWith(
      'org',
      'brand',
      expect.objectContaining({ organizationId: 'org', userId: 'user' }),
    );
  });
  it('preserves an assigned current reader and checks its live key before private status', async () => {
    const f = fixture();
    await f.privateEndpoint('status', {
      ...f.user,
      isApiKey: true,
      apiKeyId: 'key',
      scopes: ['read'],
    } as AuthenticatedUser);
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
    expect(f.statusService.getStatus).toHaveBeenCalledWith(
      'org',
      'brand',
      expect.objectContaining({ organizationId: 'org', userId: 'user' }),
    );
  });
  it('denies a revoked current reader key before private status', async () => {
    const f = fixture();
    f.prisma.apiKey.findFirst.mockResolvedValue(null as never);
    await expect(
      f.privateEndpoint('status', {
        ...f.user,
        isApiKey: true,
        apiKeyId: 'key',
        scopes: ['admin', 'read'],
      } as AuthenticatedUser),
    ).rejects.toThrow('Brand access denied');
    expect(f.statusService.getStatus).not.toHaveBeenCalled();
  });
  it('captures the actual authenticated principal and exact item request before the existing native workflow', async () => {
    const f = fixture();
    await f.invoke();
    expect(f.plans.getByIdOrFail).toHaveBeenCalledWith('org', 'plan', 'brand');
    expect(f.runner.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: 'content.production.engine.plan-item',
        organizationId: 'org',
        userId: 'user',
        source: 'api:expert-path.first-system.approve-item',
        inputValues: {
          brandId: 'brand',
          item: { id: 'item' },
          userId: 'user',
          initiatingActor: {
            organizationId: 'org',
            userId: 'user',
            isApiKey: false,
            scopes: [],
          },
        },
        metadata: {
          initiatingActorKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          initiatingRequestKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }),
    );
  });
  it.each(['zero', 'foreign', 'revoked'] as const)(
    'denies %s admission before private plan/item reads or execution',
    async (kind) => {
      const f = fixture();
      if (kind === 'zero')
        f.prisma.member.findFirst.mockResolvedValue({
          role: { key: MemberRole.USER },
          brands: [],
        });
      if (kind === 'revoked')
        f.prisma.member.findFirst.mockResolvedValue(null as never);
      await expect(
        f.invoke(f.user, kind === 'foreign' ? 'unassigned' : 'brand'),
      ).rejects.toThrow('Brand access denied');
      expect(f.plans.getByIdOrFail).not.toHaveBeenCalled();
      expect(f.items.getByIdOrFail).not.toHaveBeenCalled();
      expect(f.runner.runWorkflow).not.toHaveBeenCalled();
    },
  );
  it('preserves the current API-key cap instead of promoting its owner before workflow admission', async () => {
    const f = fixture();
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    await expect(
      f.invoke({
        ...f.user,
        isApiKey: true,
        apiKeyId: 'key',
        scopes: ['admin', 'read'],
      } as AuthenticatedUser),
    ).rejects.toThrow('Brand access denied');
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
    expect(f.plans.getByIdOrFail).not.toHaveBeenCalled();
    expect(f.runner.runWorkflow).not.toHaveBeenCalled();
  });
  it('rechecks canonical assignment after plan reads before item writes or workflow dispatch', async () => {
    const f = fixture();
    f.plans.getByIdOrFail.mockImplementation(async () => {
      f.prisma.member.findFirst.mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [],
      });
      return {
        id: 'plan',
        provenance: { source: EXPERT_FIRST_SYSTEM_PLAN_SOURCE },
      };
    });
    await expect(f.invoke()).rejects.toThrow('Brand access denied');
    expect(f.items.getByIdOrFail).not.toHaveBeenCalled();
    expect(f.items.updateContent).not.toHaveBeenCalled();
    expect(f.items.updateStatus).not.toHaveBeenCalled();
    expect(f.runner.runWorkflow).not.toHaveBeenCalled();
  });
});
