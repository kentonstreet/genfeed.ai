import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  batchProjectAccess,
  captureBatchIdeaAttempt,
  readBatchIdeaAttempt,
} from '@api/collections/batch-projects/services/batch-project-actor.util';
import { BatchProjectsService } from '@api/collections/batch-projects/services/batch-projects.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import {
  BatchProjectKind,
  BatchProjectStatus,
  BatchProjectStep,
  MemberRole,
} from '@genfeedai/contracts';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: true }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));

function fixture() {
  runtime.cloud = true;
  const member = {
    role: { key: MemberRole.USER },
    brands: [{ id: 'brand-a' }],
  };
  const user = vi.fn().mockResolvedValue({ id: 'canonical-user' });
  const key = vi.fn().mockResolvedValue({ scopes: ['read'] });
  const prisma = {
    user: { findFirst: user },
    apiKey: { findFirst: key },
    member: { findFirst: vi.fn().mockImplementation(async () => member) },
    brand: { findFirst: vi.fn().mockResolvedValue({ id: 'brand-a' }) },
  } as unknown as PrismaService;
  const policy = new BrandAccessService(prisma);
  const scope = { organizationId: 'org-a', userId: 'canonical-user' };
  return { member, user, key, prisma, policy, scope };
}

describe('BatchProject actual current-reader admission', () => {
  it('filters assigned brand relations before rows and counts', async () => {
    const f = fixture();
    const admission = await batchProjectAccess(f.prisma, f.policy, f.scope);
    expect(admission.where).toEqual({
      organizationId: 'org-a',
      isDeleted: false,
      brand: {
        is: {
          organizationId: 'org-a',
          isDeleted: false,
          id: { in: ['brand-a'] },
        },
      },
    });
    await admission.assertUnchanged();
  });

  it('keeps explicit zero assignments as an empty query predicate', async () => {
    const f = fixture();
    f.member.brands = [];
    expect(
      (await batchProjectAccess(f.prisma, f.policy, f.scope)).where.brand,
    ).toEqual({
      is: { organizationId: 'org-a', isDeleted: false, id: { in: [] } },
    });
  });

  it.each([MemberRole.OWNER, MemberRole.ADMIN])(
    'preserves unrestricted canonical %s',
    async (role) => {
      const f = fixture();
      f.member.role.key = role;
      f.member.brands = [];
      expect(
        (await batchProjectAccess(f.prisma, f.policy, f.scope)).where.brand,
      ).toEqual({ is: { organizationId: 'org-a', isDeleted: false } });
    },
  );

  it('caps an owner key using captured and current scopes', async () => {
    const f = fixture();
    f.member.role.key = MemberRole.OWNER;
    f.member.brands = [];
    const scope = {
      ...f.scope,
      isApiKey: true,
      apiKeyId: 'key-a',
      scopes: ['read', 'admin'],
    };
    const admission = await batchProjectAccess(f.prisma, f.policy, scope);
    expect(admission.actor.scopes).toEqual(['read']);
    expect(admission.where.brand).toEqual({
      is: { organizationId: 'org-a', isDeleted: false, id: { in: [] } },
    });
    expect(f.key).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'key-a',
          userId: 'canonical-user',
          organizationId: 'org-a',
          isRevoked: false,
        }),
      }),
    );
  });

  it('denies missing API-key identity instead of upgrading it into a session', async () => {
    const f = fixture();
    await expect(
      batchProjectAccess(f.prisma, f.policy, {
        ...f.scope,
        isApiKey: true,
        scopes: ['admin'],
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(f.user).not.toHaveBeenCalled();
  });

  it('denies assignment narrowing during a private await before returning data', async () => {
    const f = fixture();
    const admission = await batchProjectAccess(f.prisma, f.policy, f.scope);
    f.member.brands = [];
    await expect(admission.assertUnchanged()).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('makes mid-read key revocation opaque for an ID route', async () => {
    const f = fixture();
    const admission = await batchProjectAccess(
      f.prisma,
      f.policy,
      { ...f.scope, isApiKey: true, apiKeyId: 'key-a', scopes: ['read'] },
      'project-a',
    );
    f.key.mockResolvedValue(null);
    await expect(admission.assertUnchanged()).rejects.toThrow('Batch project');
  });

  it('rechecks actual brand deletion for an unrestricted admin after a private await', async () => {
    const f = fixture();
    f.member.role.key = MemberRole.ADMIN;
    const admission = await batchProjectAccess(
      f.prisma,
      f.policy,
      f.scope,
      'project-a',
    );
    vi.mocked(f.prisma.brand.findFirst).mockResolvedValue(null);
    await expect(admission.assertBrands(['brand-a'])).rejects.toThrow(
      'Batch project',
    );
  });

  it('retains selfhost tenant predicates without assignment or key lookups', async () => {
    const f = fixture();
    runtime.cloud = false;
    const admission = await batchProjectAccess(f.prisma, f.policy, f.scope);
    expect(admission.where).toEqual({
      organizationId: 'org-a',
      isDeleted: false,
    });
    await admission.assertUnchanged();
    expect(f.user).not.toHaveBeenCalled();
    expect(f.key).not.toHaveBeenCalled();
  });
});

function serviceFixture() {
  const f = fixture();
  const row = {
    id: 'project-a',
    brandId: 'brand-a',
    organizationId: 'org-a',
    userId: 'different-attribution-user',
    kind: BatchProjectKind.IDEAS,
    status: BatchProjectStatus.REVIEWING,
    step: BatchProjectStep.REVIEW,
    name: 'Persisted batch',
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
  };
  const findMany = vi.fn().mockResolvedValue([row]);
  const findFirst = vi.fn().mockResolvedValue(row);
  const count = vi.fn().mockResolvedValue(1);
  const prisma = Object.assign(f.prisma, {
    batchProject: { findMany, findFirst, count },
  });
  const reconcile = { syncReviewState: vi.fn(), reconcileProject: vi.fn() };
  const service = new BatchProjectsService(
    prisma,
    { log: vi.fn() } as never,
    reconcile as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    f.policy,
  );
  return { ...f, row, prisma, service, findMany, findFirst, count, reconcile };
}

describe('BatchProjectsService production current-reader entrypoints', () => {
  it('shares the pre-execution brand predicate for rows/counts and performs no GET reconciliation', async () => {
    const f = serviceFixture();
    const result = await f.service.list(f.scope, {
      page: 1,
      limit: 20,
    } as never);
    const where = f.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      organizationId: 'org-a',
      isDeleted: false,
      brand: {
        is: {
          organizationId: 'org-a',
          isDeleted: false,
          id: { in: ['brand-a'] },
        },
      },
    });
    expect(f.count).toHaveBeenCalledWith({ where });
    expect(result.docs[0].status).toBe(BatchProjectStatus.REVIEWING);
    expect(f.reconcile.syncReviewState).not.toHaveBeenCalled();
    expect(f.reconcile.reconcileProject).not.toHaveBeenCalled();
  });

  it('denies a role/assignment revoked during the actual private row await', async () => {
    const f = serviceFixture();
    f.findMany.mockImplementation(async () => {
      f.member.brands = [];
      return [f.row];
    });
    await expect(f.service.list(f.scope, {} as never)).rejects.toThrow(
      ForbiddenException,
    );
    expect(f.reconcile.syncReviewState).not.toHaveBeenCalled();
  });

  it('makes deletion during an admin detail read opaque and performs no reconciliation', async () => {
    const f = serviceFixture();
    f.member.role.key = MemberRole.ADMIN;
    f.findFirst.mockImplementation(async () => {
      vi.mocked(f.prisma.brand.findFirst).mockResolvedValue(null);
      return f.row;
    });
    await expect(f.service.findOne('project-a', f.scope)).rejects.toThrow(
      'Batch project',
    );
    expect(f.reconcile.reconcileProject).not.toHaveBeenCalled();
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'project-a',
          organizationId: 'org-a',
          isDeleted: false,
          brand: { is: { organizationId: 'org-a', isDeleted: false } },
        },
      }),
    );
  });
});

describe('immutable Batch idea attempt capture', () => {
  const job = {
    itemId: 'item-1',
    key: 'attempt-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    userId: 'user-1',
  };
  const actor = {
    organizationId: 'org-1',
    userId: 'user-1',
    isApiKey: true,
    apiKeyId: 'key-1',
    scopes: ['brand:read'],
  };
  const dispatch = {
    attempt: 1,
    key: 'attempt-1',
    model: 'model-1',
    credits: 4,
    billingMode: 'platform',
    state: 'queued',
  } as const;
  it('retains the true key actor through reserved-state transitions without binding mutable accounting state', () => {
    runtime.cloud = true;
    const captured = captureBatchIdeaAttempt(dispatch, job, 'brand-a', actor, {
      text: 'prompt',
    });
    expect(
      readBatchIdeaAttempt(
        captured,
        { ...dispatch, state: 'reserved', reservationId: 'reservation-1' },
        job,
        'brand-a',
        { text: 'prompt' },
      ),
    ).toEqual(actor);
  });
  it('rejects changed model, brand or initiating identity rather than inferring authority from attribution', () => {
    runtime.cloud = true;
    const captured = captureBatchIdeaAttempt(dispatch, job, 'brand-a', actor, {
      text: 'prompt',
    });
    expect(() =>
      readBatchIdeaAttempt(
        captured,
        { ...dispatch, model: 'changed' },
        job,
        'brand-a',
        { text: 'prompt' },
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      readBatchIdeaAttempt(captured, dispatch, job, 'brand-other', {
        text: 'prompt',
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      readBatchIdeaAttempt(
        captured,
        dispatch,
        { ...job, userId: 'creator' },
        'brand-a',
        { text: 'prompt' },
      ),
    ).toThrow(ForbiddenException);
  });
});
