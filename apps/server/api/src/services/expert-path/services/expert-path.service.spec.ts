import { BrandAccessModule } from '@api/authorization/brand-access/brand-access.module';
import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import type { WorkflowInitiatingActor } from '@api/authorization/brand-access/workflow-actor.util';
import type { HarnessProfileDocument } from '@api/collections/harness-profiles/schemas/harness-profile.schema';
import { HarnessProfilesService } from '@api/collections/harness-profiles/services/harness-profiles.service';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import { ExpertCorpusService } from '@api/services/expert-path/services/expert-corpus.service';
import { ExpertFirstSystemService } from '@api/services/expert-path/services/expert-first-system.service';
import { ExpertPathService } from '@api/services/expert-path/services/expert-path.service';
import { ExpertPositioningService } from '@api/services/expert-path/services/expert-positioning.service';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import type { IExpertFirstSystemReadiness } from '@genfeedai/contracts/interfaces';
import type { Prisma } from '@genfeedai/prisma';
import type { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
beforeEach(() => {
  runtime.cloud = false;
});

const READINESS: IExpertFirstSystemReadiness = {
  creditCost: 10,
  isReady: false,
  isUsingInterviewPlatforms: true,
  missing: ['positioning', 'corpus'],
  platforms: [],
};

describe('ExpertPathService', () => {
  let service: ExpertPathService;
  let organizationDelegate: { findFirst: ReturnType<typeof vi.fn> };
  let brandDelegate: { findFirst: ReturnType<typeof vi.fn> };
  let expertCorpusService: { summarize: ReturnType<typeof vi.fn> };
  let expertFirstSystemService: {
    readRecord: ReturnType<typeof vi.fn>;
    getReadiness: ReturnType<typeof vi.fn>;
  };
  let expertPositioningService: { readAnswers: ReturnType<typeof vi.fn> };
  let harnessProfilesService: { getActiveForBrand: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    organizationDelegate = {
      findFirst: vi.fn().mockResolvedValue({ accountType: 'CREATOR' }),
    };
    brandDelegate = {
      findFirst: vi.fn().mockResolvedValue({
        agentConfig: {},
        id: 'brand-1',
      }),
    };
    expertCorpusService = {
      summarize: vi
        .fn()
        .mockResolvedValue({ readySourceIds: [], sourceCount: 0 }),
    };
    expertFirstSystemService = {
      getReadiness: vi.fn().mockResolvedValue(READINESS),
      readRecord: vi.fn().mockResolvedValue({ status: 'none' }),
    };
    expertPositioningService = {
      readAnswers: vi.fn().mockResolvedValue({}),
    };
    harnessProfilesService = {
      getActiveForBrand: vi.fn().mockResolvedValue(null),
    };

    service = new ExpertPathService(
      {
        brand: brandDelegate,
        organization: organizationDelegate,
      } as unknown as PrismaService,
      expertCorpusService as unknown as ExpertCorpusService,
      expertFirstSystemService as unknown as ExpertFirstSystemService,
      expertPositioningService as unknown as ExpertPositioningService,
      harnessProfilesService as unknown as HarnessProfilesService,
      new BrandAccessService({
        brand: brandDelegate,
        organization: organizationDelegate,
      } as unknown as PrismaService),
    );
  });

  it('throws NotFoundException for a missing brand', async () => {
    brandDelegate.findFirst.mockResolvedValue(null);

    await expect(
      service.getStatus('org-1', 'brand-missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports isExpert true only when the organization accountType is EXPERT', async () => {
    organizationDelegate.findFirst.mockResolvedValue({ accountType: 'EXPERT' });

    const status = await service.getStatus('org-1', 'brand-1');

    expect(status.isExpert).toBe(true);
  });

  it('reports isExpert false for a non-expert organization', async () => {
    organizationDelegate.findFirst.mockResolvedValue({
      accountType: 'CREATOR',
    });

    const status = await service.getStatus('org-1', 'brand-1');

    expect(status.isExpert).toBe(false);
  });

  it('reports positioning counts, score and harnessProfileId from the active profile', async () => {
    expertPositioningService.readAnswers.mockResolvedValue({
      bigDomino: 'answer',
      originStory: 'answer',
    });
    const positioning = {
      dimensions: [],
      rating: 'needs_work',
      scoredAt: '2026-01-01T00:00:00.000Z',
      totalScore: 60,
      version: 1,
      weakestDimension: 'bigDomino',
    };
    harnessProfilesService.getActiveForBrand.mockResolvedValue({
      id: 'profile-1',
      positioning,
    } as unknown as HarnessProfileDocument);

    const status = await service.getStatus('org-1', 'brand-1');

    expect(status.positioning).toEqual({
      answeredCount: 2,
      harnessProfileId: 'profile-1',
      isComplete: true,
      score: positioning,
      totalCount: 7,
    });
  });

  it('reports positioning incomplete without a harnessProfileId/score when no profile has positioning', async () => {
    harnessProfilesService.getActiveForBrand.mockResolvedValue(null);

    const status = await service.getStatus('org-1', 'brand-1');

    expect(status.positioning).toEqual({
      answeredCount: 0,
      isComplete: false,
      totalCount: 7,
    });
    expect(status.positioning).not.toHaveProperty('harnessProfileId');
    expect(status.positioning).not.toHaveProperty('score');
  });

  it('reports corpus counts from the corpus summary', async () => {
    expertCorpusService.summarize.mockResolvedValue({
      readySourceIds: ['source-1', 'source-2'],
      sourceCount: 3,
    });

    const status = await service.getStatus('org-1', 'brand-1');

    expect(status.corpus).toEqual({
      isComplete: true,
      readySourceCount: 2,
      sourceCount: 3,
    });
  });

  it('includes the first-system record and readiness verbatim', async () => {
    expertFirstSystemService.readRecord.mockResolvedValue({
      planId: 'plan-1',
      status: 'generated',
    });
    expertFirstSystemService.getReadiness.mockResolvedValue(READINESS);

    const status = await service.getStatus('org-1', 'brand-1');

    expect(status.firstSystem).toEqual({
      planId: 'plan-1',
      readiness: READINESS,
      status: 'generated',
    });
  });

  describe('publishApproval.isRequired', () => {
    it('is true only when autoPublish is { enabled: false, isApprovalRequired: true }', async () => {
      brandDelegate.findFirst.mockResolvedValue({
        agentConfig: {
          autoPublish: { enabled: false, isApprovalRequired: true },
        },
        id: 'brand-1',
      });

      const status = await service.getStatus('org-1', 'brand-1');

      expect(status.publishApproval).toEqual({ isRequired: true });
    });

    it('is false when autoPublish.enabled is true even with isApprovalRequired set', async () => {
      brandDelegate.findFirst.mockResolvedValue({
        agentConfig: {
          autoPublish: { enabled: true, isApprovalRequired: true },
        },
        id: 'brand-1',
      });

      const status = await service.getStatus('org-1', 'brand-1');

      expect(status.publishApproval).toEqual({ isRequired: false });
    });

    it('is false when isApprovalRequired is not set', async () => {
      brandDelegate.findFirst.mockResolvedValue({
        agentConfig: { autoPublish: { enabled: false } },
        id: 'brand-1',
      });

      const status = await service.getStatus('org-1', 'brand-1');

      expect(status.publishApproval).toEqual({ isRequired: false });
    });

    it('is false when there is no autoPublish config at all', async () => {
      brandDelegate.findFirst.mockResolvedValue({
        agentConfig: {},
        id: 'brand-1',
      });

      const status = await service.getStatus('org-1', 'brand-1');

      expect(status.publishApproval).toEqual({ isRequired: false });
    });
  });
});

function statusPolicyFixture() {
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
    member: {
      findFirst: vi.fn().mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [{ id: 'brand-1' }],
      }),
    },
    apiKey: {
      findFirst: vi.fn().mockResolvedValue({ scopes: ['admin', 'read'] }),
    },
    brand: {
      findFirst: vi.fn(async (args: Prisma.BrandFindFirstArgs) => {
        const where = args.where ?? {};
        if (typeof where.id === 'string' && where.id !== 'brand-1') return null;
        const predicates = Array.isArray(where.AND)
          ? where.AND
          : where.AND
            ? [where.AND]
            : [];
        for (const predicate of predicates) {
          if (typeof predicate.id === 'string' && predicate.id !== 'brand-1')
            return null;
          if (
            predicate.id &&
            typeof predicate.id === 'object' &&
            'in' in predicate.id &&
            Array.isArray(predicate.id.in) &&
            !predicate.id.in.includes('brand-1')
          )
            return null;
        }
        return {
          id: 'brand-1',
          agentConfig: { strategy: { platforms: ['linkedin'] } },
        };
      }),
    },
    organization: {
      findFirst: vi.fn().mockResolvedValue({ accountType: 'EXPERT' }),
    },
    credential: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const memory = { listTypedEntries: vi.fn().mockResolvedValue([]) };
  const profiles = {
    getActiveForBrand: vi
      .fn()
      .mockResolvedValue({ id: 'profile-1', positioning: { totalScore: 80 } }),
  };
  const corpus = {
    summarize: vi
      .fn()
      .mockResolvedValue({ sourceCount: 1, readySourceIds: ['source-1'] }),
  };
  const positioning = {
    readAnswers: vi.fn().mockResolvedValue({ bigDomino: 'answer' }),
  };
  const db = prisma as unknown as PrismaService;
  const policy = new BrandAccessService(db);
  const firstSystem = new ExpertFirstSystemService(
    db,
    memory as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    corpus as never,
    {} as never,
    profiles as never,
    {} as never,
    {} as ModuleRef,
    policy,
  );
  const service = new ExpertPathService(
    db,
    corpus as never,
    firstSystem,
    positioning as never,
    profiles as never,
    policy,
  );
  const actor: WorkflowInitiatingActor = {
    userId: 'user-1',
    organizationId: 'org-1',
    isApiKey: false,
    scopes: [],
  };
  const invoke = (
    actingActor: WorkflowInitiatingActor = actor,
    brandId = 'brand-1',
  ) => service.getStatus('org-1', brandId, actingActor);
  return {
    prisma,
    memory,
    profiles,
    corpus,
    positioning,
    firstSystem,
    service,
    actor,
    invoke,
  };
}
describe('ExpertPath status current-reader policy', () => {
  beforeEach(() => {
    runtime.cloud = true;
  });
  it('rejects missing Cloud actor before any private query', async () => {
    const f = statusPolicyFixture();
    await expect(f.service.getStatus('org-1', 'brand-1')).rejects.toThrow(
      'Brand access denied',
    );
    expect(f.prisma.organization.findFirst).not.toHaveBeenCalled();
    expect(f.memory.listTypedEntries).not.toHaveBeenCalled();
  });
  it.each(['zero', 'foreign', 'deleted'] as const)(
    'denies %s before credential/corpus/profile/memory access',
    async (kind) => {
      const f = statusPolicyFixture();
      if (kind === 'zero')
        f.prisma.member.findFirst.mockResolvedValue({
          role: { key: MemberRole.USER },
          brands: [],
        });
      if (kind === 'deleted') f.prisma.brand.findFirst.mockResolvedValue(null);
      await expect(
        f.invoke(f.actor, kind === 'foreign' ? 'foreign' : 'brand-1'),
      ).rejects.toThrow('Brand access denied');
      expect(f.prisma.credential.findMany).not.toHaveBeenCalled();
      expect(f.corpus.summarize).not.toHaveBeenCalled();
      expect(f.profiles.getActiveForBrand).not.toHaveBeenCalled();
      expect(f.memory.listTypedEntries).not.toHaveBeenCalled();
    },
  );
  it('returns the original computed status for a currently assigned reader', async () => {
    const f = statusPolicyFixture();
    const result = await f.invoke();
    expect(result.corpus).toEqual({
      isComplete: true,
      readySourceCount: 1,
      sourceCount: 1,
    });
    expect(result.firstSystem.readiness.platforms).toEqual(['linkedin']);
    expect(result.positioning.answeredCount).toBe(1);
  });
  it.each([MemberRole.OWNER, MemberRole.ADMIN])(
    'retains all-brand status for current canonical %s with no assignments',
    async (role) => {
      const f = statusPolicyFixture();
      f.prisma.member.findFirst.mockResolvedValue({
        role: { key: role },
        brands: [],
      });
      await expect(f.invoke()).resolves.toHaveProperty('brandId', 'brand-1');
    },
  );
  it('keeps a nonadmin current key restricted even for a canonical owner', async () => {
    const f = statusPolicyFixture();
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    f.prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['read'] });
    await expect(
      f.invoke({
        ...f.actor,
        isApiKey: true,
        apiKeyId: 'key-1',
        scopes: ['admin', 'read'],
      }),
    ).rejects.toThrow('Brand access denied');
    expect(f.prisma.credential.findMany).not.toHaveBeenCalled();
  });
  it('retains current admin-key access and pins its live user/org/key lookup', async () => {
    const f = statusPolicyFixture();
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.ADMIN },
      brands: [],
    });
    await f.invoke({
      ...f.actor,
      isApiKey: true,
      apiKeyId: 'key-1',
      scopes: ['admin', 'read'],
    });
    expect(f.prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'key-1',
          userId: 'user-1',
          organizationId: 'org-1',
          isRevoked: false,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
  });
  it.each(['answers', 'profile', 'corpus', 'memory'] as const)(
    'denies revocation during %s before private status is returned',
    async (part) => {
      const f = statusPolicyFixture();
      const revoke = () =>
        f.prisma.member.findFirst.mockResolvedValue(null as never);
      if (part === 'answers')
        f.positioning.readAnswers.mockImplementation(async () => {
          revoke();
          return {};
        });
      if (part === 'profile')
        f.profiles.getActiveForBrand.mockImplementation(async () => {
          revoke();
          return null;
        });
      if (part === 'corpus')
        f.corpus.summarize.mockImplementation(async () => {
          revoke();
          return { sourceCount: 1, readySourceIds: ['source-1'] };
        });
      if (part === 'memory')
        f.memory.listTypedEntries.mockImplementation(async () => {
          revoke();
          return [];
        });
      await expect(f.invoke()).rejects.toThrow('Brand access denied');
    },
  );
  it('denies key scope narrowing during a private read without widening captured authority', async () => {
    const f = statusPolicyFixture();
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    f.positioning.readAnswers.mockImplementation(async () => {
      f.prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['read'] });
      return {};
    });
    await expect(
      f.invoke({
        ...f.actor,
        isApiKey: true,
        apiKeyId: 'key-1',
        scopes: ['admin', 'read'],
      }),
    ).rejects.toThrow('Brand access denied');
  });
  it('denies revoked or expired current key rows before private reads', async () => {
    const f = statusPolicyFixture();
    f.prisma.apiKey.findFirst.mockResolvedValue(null as never);
    await expect(
      f.invoke({
        ...f.actor,
        isApiKey: true,
        apiKeyId: 'key-1',
        scopes: ['read'],
      }),
    ).rejects.toThrow('Brand access denied');
    expect(f.corpus.summarize).not.toHaveBeenCalled();
  });
  it('denies a key revoked or expired during corpus loading before response', async () => {
    const f = statusPolicyFixture();
    f.corpus.summarize.mockImplementation(async () => {
      f.prisma.apiKey.findFirst.mockResolvedValue(null as never);
      return { sourceCount: 1, readySourceIds: ['source-1'] };
    });
    await expect(
      f.invoke({
        ...f.actor,
        isApiKey: true,
        apiKeyId: 'key-1',
        scopes: ['read'],
      }),
    ).rejects.toThrow('Brand access denied');
    expect(f.prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isRevoked: false,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
  });
  it('rechecks credential completion before executing the fallback brand query', async () => {
    const f = statusPolicyFixture();
    f.prisma.credential.findMany.mockImplementation(async () => {
      f.prisma.member.findFirst.mockResolvedValue(null as never);
      return [];
    });
    await expect(
      f.firstSystem.getReadiness('org-1', 'brand-1', f.actor),
    ).rejects.toThrow('Brand access denied');
    expect(
      f.prisma.brand.findFirst.mock.calls.some(
        ([args]) => args.select?.agentConfig === true,
      ),
    ).toBe(false);
  });
  it('denies canonical admin downgrade during profile load before returning status', async () => {
    const f = statusPolicyFixture();
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.ADMIN },
      brands: [],
    });
    f.profiles.getActiveForBrand.mockImplementation(async () => {
      f.prisma.member.findFirst.mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [],
      });
      return null;
    });
    await expect(f.invoke()).rejects.toThrow('Brand access denied');
  });
  it('does not gain current admin scopes that were absent from the captured key', async () => {
    const f = statusPolicyFixture();
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    await expect(
      f.invoke({
        ...f.actor,
        isApiKey: true,
        apiKeyId: 'key-1',
        scopes: ['read'],
      }),
    ).rejects.toThrow('Brand access denied');
    expect(f.corpus.summarize).not.toHaveBeenCalled();
  });
  it('resolves the required real policy through its production module', async () => {
    const f = statusPolicyFixture();
    const module = await Test.createTestingModule({
      imports: [BrandAccessModule],
      providers: [
        ExpertPathService,
        { provide: ExpertCorpusService, useValue: f.corpus },
        { provide: ExpertFirstSystemService, useValue: f.firstSystem },
        { provide: ExpertPositioningService, useValue: f.positioning },
        { provide: HarnessProfilesService, useValue: f.profiles },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(f.prisma)
      .compile();
    try {
      const service = module.get(ExpertPathService);
      await expect(
        service.getStatus('org-1', 'brand-1', f.actor),
      ).resolves.toHaveProperty('brandId', 'brand-1');
      await expect(service.getStatus('org-1', 'brand-1')).rejects.toThrow(
        'Brand access denied',
      );
      expect(module.get(BrandAccessService)).toBeInstanceOf(BrandAccessService);
    } finally {
      await module.close();
    }
  });
  it('preserves actorless selfhost status without a Cloud membership requirement', async () => {
    const f = statusPolicyFixture();
    runtime.cloud = false;
    await expect(
      f.service.getStatus('org-1', 'brand-1'),
    ).resolves.toHaveProperty('brandId', 'brand-1');
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
  });
});
