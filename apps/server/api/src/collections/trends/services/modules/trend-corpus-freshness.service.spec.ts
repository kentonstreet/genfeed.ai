import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { captureWorkflowActor } from '@api/authorization/brand-access/workflow-actor.util';
import { TrendCorpusFreshnessService } from '@api/collections/trends/services/modules/trend-corpus-freshness.service';
import { TrendRefreshHealthService } from '@api/collections/trends/services/modules/trend-refresh-health.service';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole, PlatformRole } from '@genfeedai/contracts';
import { Test, TestingModule } from '@nestjs/testing';

type ReferenceDoc = {
  createdAt: Date;
  data: Record<string, unknown>;
  id: string;
  lastSeenAt: Date;
  platform: string;
};

type TrendDoc = {
  expiresAt: Date;
  isCurrent: boolean;
  createdAt: Date;
  data: Record<string, unknown>;
  id: string;
  lastSeenAt: Date;
  organizationId: string | null;
  platform: string;
  updatedAt: Date;
};

const referenceDocs: ReferenceDoc[] = [
  {
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    data: {
      authorHandle: 'creator',
      firstSeenAt: '2026-06-01T00:00:00.000Z',
      lastSeenAt: '2026-06-12T00:00:00.000Z',
      matchedTrendTopics: ['ai tools'],
      platform: 'tiktok',
      sourceClassification: {
        capturedAt: '2026-06-01T00:00:00.000Z',
        confidence: 'medium',
        freshnessWindowDays: 2,
        intendedUse: 'organic_trend_discovery',
        sourceKind: 'public_platform_reference',
        sourceLabel: 'TikTok',
      },
    },
    id: 'ref_tiktok',
    lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
    platform: 'tiktok',
  },
  {
    createdAt: new Date('2026-06-02T00:00:00.000Z'),
    data: {
      authorHandle: 'designer',
      firstSeenAt: '2026-06-02T00:00:00.000Z',
      lastSeenAt: '2026-06-10T00:00:00.000Z',
      matchedTrendTopics: ['design'],
      platform: 'instagram',
      sourceClassification: {
        capturedAt: '2026-06-02T00:00:00.000Z',
        confidence: 'medium',
        freshnessWindowDays: 30,
        intendedUse: 'organic_trend_discovery',
        sourceKind: 'public_platform_reference',
        sourceLabel: 'Instagram',
      },
    },
    id: 'ref_instagram',
    lastSeenAt: new Date('2026-06-10T00:00:00.000Z'),
    platform: 'instagram',
  },
];

const makeTrend = (
  id: string,
  platform: string,
  metadata: Record<string, unknown>,
  organizationId: string | null = null,
): TrendDoc => ({
  createdAt: new Date('2026-06-10T00:00:00.000Z'),
  data: {
    metadata,
    platform,
  },
  expiresAt: new Date('2026-07-01T00:00:00.000Z'),
  isCurrent: true,
  id,
  lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
  organizationId,
  platform,
  updatedAt: new Date('2026-06-12T00:00:00.000Z'),
});

const trendDocs: TrendDoc[] = [
  makeTrend(
    'trend_live',
    'tiktok',
    {
      source: 'apify',
      sourcePreviewCachedAt: '2026-06-12T00:00:00.000Z',
      sourcePreviewState: 'live',
    },
    'org_1',
  ),
  makeTrend('trend_empty', 'youtube', {
    source: 'apify',
    sourcePreviewCachedAt: '2026-06-13T00:00:00.000Z',
    sourcePreviewState: 'empty',
  }),
  makeTrend('trend_fallback', 'instagram', {
    source: 'apify',
    sourcePreviewCachedAt: '2026-06-11T00:00:00.000Z',
    sourcePreviewState: 'fallback',
  }),
  makeTrend('trend_stale', 'twitter', {
    source: 'apify',
    sourcePreviewCachedAt: '2026-06-01T00:00:00.000Z',
    sourcePreviewState: 'live',
  }),
  makeTrend('trend_prelaunch', 'linkedin', {
    prelaunchCorpus: true,
    source: 'public-reference',
    sourcePreviewCachedAt: '2026-06-01T00:00:00.000Z',
    sourcePreviewState: 'fallback',
  }),
];

describe('TrendCorpusFreshnessService', () => {
  let service: TrendCorpusFreshnessService;
  const refreshHealth = { getHealth: vi.fn().mockResolvedValue([]) };
  let prisma: {
    trend: { findMany: ReturnType<typeof vi.fn> };
    trendSourceReference: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    prisma = {
      trend: {
        findMany: vi.fn(({ where }) =>
          Promise.resolve(
            where.platform
              ? trendDocs.filter((doc) => doc.platform === where.platform)
              : trendDocs,
          ),
        ),
      },
      trendSourceReference: {
        findMany: vi.fn(({ where }) =>
          Promise.resolve(
            where.platform
              ? referenceDocs.filter((doc) => doc.platform === where.platform)
              : referenceDocs,
          ),
        ),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrandAccessService,
        TrendCorpusFreshnessService,
        {
          provide: TrendRefreshHealthService,
          useValue: refreshHealth,
        },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(TrendCorpusFreshnessService);
  });

  it('reports freshness segments and every live provider failure class', async () => {
    const result = await service.getCorpusFreshnessHealth({
      isPlatformAdmin: true,
      now: new Date('2026-06-14T00:00:00.000Z'),
    });

    expect(result.status).toBe('stale');
    expect(result.summary).toMatchObject({
      activeTrends: 5,
      failingProviders: 3,
      freshSegments: 2,
      referenceRecords: 2,
      staleSegments: 0,
      totalSegments: 2,
    });
    expect(result.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'tiktok',
          provider: 'TikTok',
          status: 'healthy',
        }),
        expect.objectContaining({
          platform: 'instagram',
          provider: 'Instagram',
          status: 'healthy',
        }),
      ]),
    );
    expect(result.providerFailures.map((failure) => failure.reason)).toEqual([
      'fallback_source_preview',
      'stale_source_preview',
      'empty_source_preview',
    ]);
    expect(
      result.providerFailures.some(
        (failure) => failure.provider === 'public-reference',
      ),
    ).toBe(false);
  });

  it('ignores stale JSON flags when canonical columns mark a trend inactive', async () => {
    prisma.trend.findMany.mockResolvedValue([
      {
        ...trendDocs[1],
        isCurrent: false,
        data: {
          ...trendDocs[1].data,
          isCurrent: true,
          expiresAt: '2026-07-01T00:00:00.000Z',
        },
      },
    ]);
    const result = await service.getCorpusFreshnessHealth({
      now: new Date('2026-06-14T00:00:00.000Z'),
    });
    expect(result.summary.activeTrends).toBe(0);
    expect(result.providerFailures).toEqual([]);
  });

  it('marks segments stale when their source windows expire', async () => {
    const result = await service.getCorpusFreshnessHealth({
      isPlatformAdmin: true,
      now: new Date('2026-07-20T00:00:00.000Z'),
      sourcePreviewStaleAfterDays: 100,
    });

    expect(result.status).toBe('stale');
    expect(result.summary.staleSegments).toBe(2);
    expect(result.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'tiktok',
          staleReferenceCount: 1,
          status: 'stale',
        }),
        expect.objectContaining({
          platform: 'instagram',
          staleReferenceCount: 1,
          status: 'stale',
        }),
      ]),
    );
  });

  it('filters both corpus queries by platform and preserves record caps', async () => {
    const result = await service.getCorpusFreshnessHealth({
      isPlatformAdmin: true,
      now: new Date('2026-06-14T00:00:00.000Z'),
      platform: 'tiktok',
    });

    expect(result.summary.platforms).toEqual(['tiktok']);
    expect(result.summary.referenceRecords).toBe(1);
    expect(result.summary.failingProviders).toBe(0);
    expect(prisma.trendSourceReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5000,
        where: { isDeleted: false, platform: 'tiktok' },
      }),
    );
    expect(prisma.trend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2000,
        where: { isDeleted: false, platform: 'tiktok' },
      }),
    );
  });

  it('scopes non-admin trend health to the caller organization and global rows', async () => {
    await service.getCorpusFreshnessHealth({
      now: new Date('2026-06-14T00:00:00.000Z'),
      organizationId: 'org_1',
    });

    expect(prisma.trend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ organizationId: 'org_1' }, { organizationId: null }],
          isDeleted: false,
        },
      }),
    );
  });

  it('restricts non-admin callers without an organization to global trends', async () => {
    await service.getCorpusFreshnessHealth({
      now: new Date('2026-06-14T00:00:00.000Z'),
    });

    expect(prisma.trend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: null,
          isDeleted: false,
        },
      }),
    );
  });

  it('keeps the platform-admin trend aggregate cross-organization', async () => {
    await service.getCorpusFreshnessHealth({
      isPlatformAdmin: true,
      now: new Date('2026-06-14T00:00:00.000Z'),
      organizationId: 'org_1',
    });

    const trendWhere = prisma.trend.findMany.mock.calls.at(-1)?.[0]?.where;
    expect(trendWhere).toEqual({ isDeleted: false });
    expect(trendWhere).not.toHaveProperty('OR');
  });
  it('returns refresh receipts without fetching and projects failed refreshes into health', async () => {
    const receipt = {
      completedAt: '2026-06-13T12:16:00Z',
      dataset: 'trends',
      lastAttemptAt: '2026-06-13T12:15:00Z',
      lastSuccessfulRefreshAt: '2026-06-12T12:16:00Z',
      outcome: 'native_failed',
      platform: 'youtube',
      reason: 'native_failed',
      scope: 'global',
    };
    refreshHealth.getHealth.mockResolvedValue([receipt]);
    const result = await service.getCorpusFreshnessHealth({
      organizationId: 'org-1',
      platform: 'youtube',
    });
    expect(result.refreshHealth).toEqual([receipt]);
    expect(refreshHealth.getHealth).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', platform: 'youtube' }),
    );
    expect(result.providerFailures).toContainEqual(
      expect.objectContaining({
        platform: 'youtube',
        reason: 'refresh_failed',
        latestObservedAt: receipt.lastAttemptAt,
      }),
    );
  });
});

const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
beforeEach(() => {
  runtime.cloud = false;
});

function cloudHealthFixture() {
  runtime.cloud = true;
  const state = {
    platformRole: PlatformRole.SUPERADMIN,
    role: MemberRole.USER,
    brands: ['brand-a'],
    scopes: ['admin', 'read'],
    userActive: true,
    keyActive: true,
  };
  const prisma = {
    user: {
      findFirst: vi
        .fn()
        .mockImplementation(async () =>
          state.userActive ? { platformRole: state.platformRole } : null,
        ),
    },
    apiKey: {
      findFirst: vi
        .fn()
        .mockImplementation(async () =>
          state.keyActive ? { scopes: state.scopes } : null,
        ),
    },
    member: {
      findFirst: vi.fn().mockImplementation(async () => ({
        role: { key: state.role },
        brands: state.brands.map((id) => ({ id })),
      })),
    },
    trendSourceReference: { findMany: vi.fn().mockResolvedValue([]) },
    trend: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const db = prisma as unknown as PrismaService;
  const refresh = { getHealth: vi.fn().mockResolvedValue([]) };
  const service = new TrendCorpusFreshnessService(
    db,
    refresh as unknown as TrendRefreshHealthService,
    new BrandAccessService(db),
  );
  const actor = captureWorkflowActor({
    organizationId: 'org',
    userId: 'user',
    isApiKey: true,
    apiKeyId: 'key',
    scopes: ['admin', 'read'],
  });
  return { state, prisma, refresh, service, actor };
}
describe('Cloud freshness current-reader policy', () => {
  it('requires an actual actor before any tenant private query', async () => {
    const f = cloudHealthFixture();
    await expect(
      f.service.getCorpusFreshnessHealth({ organizationId: 'org' }),
    ).rejects.toThrow('Brand access denied');
    expect(f.prisma.trend.findMany).not.toHaveBeenCalled();
    expect(f.prisma.trendSourceReference.findMany).not.toHaveBeenCalled();
    expect(f.refresh.getHealth).not.toHaveBeenCalled();
  });
  it('does not accept a platform flag without a proven current principal', async () => {
    const f = cloudHealthFixture();
    await expect(
      f.service.getCorpusFreshnessHealth({ isPlatformAdmin: true }),
    ).rejects.toThrow('Brand access denied');
    expect(f.prisma.trend.findMany).not.toHaveBeenCalled();
  });
  it('retains fresh platform operator cross-organization health with explicit admin key caps', async () => {
    const f = cloudHealthFixture();
    await f.service.getCorpusFreshnessHealth({
      organizationId: 'org',
      isPlatformAdmin: true,
      initiatingActor: f.actor,
    });
    expect(f.prisma.trend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isDeleted: false } }),
    );
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'key',
          userId: 'user',
          organizationId: 'org',
          isRevoked: false,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
  });
  it('caps an operator read key to current tenant assigned-brand health', async () => {
    const f = cloudHealthFixture();
    f.state.scopes = ['read'];
    await f.service.getCorpusFreshnessHealth({
      organizationId: 'org',
      isPlatformAdmin: true,
      initiatingActor: f.actor,
    });
    const where = f.prisma.trend.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { organizationId: 'org' },
      { organizationId: null },
    ]);
    expect(where.AND[0].OR).toEqual([
      { organizationId: null },
      { organizationId: 'org', brandId: null },
      {
        organizationId: 'org',
        brand: {
          organizationId: 'org',
          isDeleted: false,
          id: { in: ['brand-a'] },
        },
      },
    ]);
  });
  it('does not turn a stale superadmin flag into current operator authority', async () => {
    const f = cloudHealthFixture();
    f.state.platformRole = PlatformRole.USER;
    await f.service.getCorpusFreshnessHealth({
      organizationId: 'org',
      isPlatformAdmin: true,
      initiatingActor: f.actor,
    });
    expect(f.prisma.trend.findMany.mock.calls[0][0].where).toHaveProperty(
      'AND',
    );
  });
  it('retains public and genuine org-only rows with zero assigned brands', async () => {
    const f = cloudHealthFixture();
    f.state.brands = [];
    await f.service.getCorpusFreshnessHealth({
      organizationId: 'org',
      initiatingActor: f.actor,
    });
    expect(
      f.prisma.trend.findMany.mock.calls[0][0].where.AND[0].OR[2].brand.id.in,
    ).toEqual([]);
    expect(f.refresh.getHealth).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org' }),
    );
  });
  it.each([MemberRole.OWNER, MemberRole.ADMIN])(
    'retains canonical %s all active tenant brands',
    async (role) => {
      const f = cloudHealthFixture();
      f.state.role = role;
      f.state.brands = [];
      await f.service.getCorpusFreshnessHealth({
        organizationId: 'org',
        initiatingActor: f.actor,
      });
      expect(
        f.prisma.trend.findMany.mock.calls[0][0].where.AND[0].OR[2].brand,
      ).toEqual({ organizationId: 'org', isDeleted: false });
    },
  );
  it.each(['keyActive', 'userActive'] as const)(
    'denies missing/revoked current %s before private reads',
    async (field) => {
      const f = cloudHealthFixture();
      f.state[field] = false;
      await expect(
        f.service.getCorpusFreshnessHealth({
          organizationId: 'org',
          isPlatformAdmin: true,
          initiatingActor: f.actor,
        }),
      ).rejects.toThrow('Brand access denied');
      expect(f.prisma.trend.findMany).not.toHaveBeenCalled();
    },
  );
  it('denies key cap loss while private reads await', async () => {
    const f = cloudHealthFixture();
    f.refresh.getHealth.mockImplementation(async () => {
      f.state.scopes = ['read'];
      return [];
    });
    await expect(
      f.service.getCorpusFreshnessHealth({
        organizationId: 'org',
        isPlatformAdmin: true,
        initiatingActor: f.actor,
      }),
    ).rejects.toThrow('Brand access denied');
  });
  it('denies canonical platform-role revocation before returning private health', async () => {
    const f = cloudHealthFixture();
    f.refresh.getHealth.mockImplementation(async () => {
      f.state.platformRole = PlatformRole.USER;
      return [];
    });
    await expect(
      f.service.getCorpusFreshnessHealth({
        organizationId: 'org',
        isPlatformAdmin: true,
        initiatingActor: f.actor,
      }),
    ).rejects.toThrow('Brand access denied');
  });
  it('denies assignment removal before returning already-read tenant health', async () => {
    const f = cloudHealthFixture();
    f.refresh.getHealth.mockImplementation(async () => {
      f.state.brands = [];
      return [];
    });
    await expect(
      f.service.getCorpusFreshnessHealth({
        organizationId: 'org',
        initiatingActor: f.actor,
      }),
    ).rejects.toThrow('Brand access denied');
  });
  it('denies a foreign target organization before querying', async () => {
    const f = cloudHealthFixture();
    await expect(
      f.service.getCorpusFreshnessHealth({
        organizationId: 'other',
        initiatingActor: f.actor,
      }),
    ).rejects.toThrow('Brand access denied');
    expect(f.prisma.trend.findMany).not.toHaveBeenCalled();
  });
  it('keeps actorless global corpus isolated from ambient tenant private rows', async () => {
    const f = cloudHealthFixture();
    await f.service.getCorpusFreshnessHealth();
    expect(f.prisma.trend.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: null,
      isDeleted: false,
    });
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
  });
});
