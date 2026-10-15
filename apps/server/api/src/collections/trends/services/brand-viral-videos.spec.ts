import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { captureWorkflowActor } from '@api/authorization/brand-access/workflow-actor.util';
import { TrendFilteringService } from '@api/collections/trends/services/modules/trend-filtering.service';
import { TrendsService } from '@api/collections/trends/services/trends.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));

function setup(description: string) {
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
    member: {
      findFirst: vi.fn().mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [{ id: 'brand-1' }],
      }),
    },
    apiKey: { findFirst: vi.fn().mockResolvedValue({ scopes: ['read'] }) },
    brand: { findFirst: vi.fn() },
  };
  prisma.brand.findFirst.mockImplementation(async ({ where }) => {
    const predicate = where.AND[0];
    const id = where.AND[1].id;
    return id === 'brand-1' &&
      (predicate.id?.in === undefined || predicate.id.in.includes(id))
      ? { id }
      : null;
  });
  const credentials = { findAll: vi.fn().mockResolvedValue({ docs: [] }) };
  const brands = { findOne: vi.fn().mockResolvedValue({ description }) };
  const preferences = {
    getPreferences: vi.fn().mockResolvedValue({
      keywords: [],
      categories: [],
      hashtags: [],
      platforms: [],
    }),
  };
  const videos = {
    getViralVideos: vi.fn().mockResolvedValue([
      { id: 'music', title: 'Popular official music video', viralScore: 99 },
      { id: 'agents', title: 'AI agents automate marketing', viralScore: 75 },
    ]),
  };
  const filtering = new TrendFilteringService({} as never, {} as never);
  const service = new TrendsService(
    {} as never,
    brands as never,
    credentials as never,
    preferences as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    filtering,
    videos as never,
    {} as never,
    {} as never,
    new BrandAccessService(prisma as unknown as PrismaService),
    prisma as unknown as PrismaService,
  );
  return { service, brands, videos, preferences, credentials, prisma };
}

describe('Brand viral videos', () => {
  beforeEach(() => {
    runtime.cloud = false;
  });
  it('filters before limiting and resolves the brand within its organization', async () => {
    const { service, brands, videos } = setup('AI marketing automation');
    expect(
      await service.getBrandViralVideos('org-1', 'brand-1', { limit: 1 }),
    ).toEqual([
      { id: 'agents', title: 'AI agents automate marketing', viralScore: 75 },
    ]);
    expect(brands.findOne).toHaveBeenCalledWith({
      id: 'brand-1',
      organizationId: 'org-1',
      isDeleted: false,
    });
    expect(videos.getViralVideos).toHaveBeenCalledWith({ limit: 100 });
  });
  it('does not substitute a global music chart when nothing matches', async () => {
    expect(
      await setup('fitness nutrition').service.getBrandViralVideos(
        'org-1',
        'brand-1',
        { limit: 12 },
      ),
    ).toEqual([]);
  });
  it('does not fetch global videos without usable brand context', async () => {
    const { service, videos } = setup('');
    expect(await service.getBrandViralVideos('org-1', 'brand-1', {})).toEqual(
      [],
    );
    expect(videos.getViralVideos).not.toHaveBeenCalled();
  });
  it('uses explicit brand discovery preferences', async () => {
    const { service, preferences } = setup('fitness nutrition');
    preferences.getPreferences.mockResolvedValue({
      keywords: ['AI agents'],
      categories: [],
      hashtags: [],
      platforms: [],
    });
    expect(
      await service.getBrandViralVideos('org-1', 'brand-1', {}),
    ).toHaveLength(1);
  });
  it('rejects nonexistent brand scope before looking up the content cache', async () => {
    const { service, brands } = setup('AI marketing');
    brands.findOne.mockResolvedValue(null as never);
    await expect(
      service.getTrendContent('org-1', 'foreign-brand', {}),
    ).rejects.toThrow('Brand not found');
  });

  it('does not expose videos when brand lookup fails', async () => {
    const { service, brands, videos } = setup('AI marketing');
    brands.findOne.mockResolvedValue(null as never);
    await expect(
      service.getBrandViralVideos('org-1', 'foreign-brand', {}),
    ).rejects.toThrow('Brand not found');
    expect(videos.getViralVideos).not.toHaveBeenCalled();
  });
  it('denies ordinary zero assignments before private brand context or video reads', async () => {
    runtime.cloud = true;
    const f = setup('AI');
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [],
    });
    await expect(
      f.service.getBrandViralVideos(
        'org-1',
        'brand-1',
        {},
        captureWorkflowActor({ organizationId: 'org-1', userId: 'user-1' }),
      ),
    ).rejects.toThrow('Brand access denied');
    expect(f.brands.findOne).not.toHaveBeenCalled();
    expect(f.preferences.getPreferences).not.toHaveBeenCalled();
    expect(f.videos.getViralVideos).not.toHaveBeenCalled();
  });
  it('filters connected credential metadata with explicit empty assignments before querying', async () => {
    runtime.cloud = true;
    const f = setup('AI');
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [],
    });
    await expect(
      f.service.getConnectedPlatforms(
        'org-1',
        captureWorkflowActor({ organizationId: 'org-1', userId: 'user-1' }),
      ),
    ).resolves.toEqual([]);
    expect(f.credentials.findAll).toHaveBeenCalledWith(
      {
        where: {
          organizationId: 'org-1',
          isDeleted: false,
          isConnected: true,
          brandId: { in: [] },
        },
      },
      { limit: 100 },
    );
  });
  it('uses current effective key scopes before selecting organization credential metadata', async () => {
    runtime.cloud = true;
    const f = setup('AI');
    f.prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.OWNER },
      brands: [],
    });
    await f.service.getConnectedPlatforms(
      'org-1',
      captureWorkflowActor({
        organizationId: 'org-1',
        userId: 'user-1',
        isApiKey: true,
        apiKeyId: 'key',
        scopes: ['admin', 'read'],
      }),
    );
    expect(f.credentials.findAll).toHaveBeenCalledWith(
      { where: expect.objectContaining({ brandId: { in: [] } }) },
      { limit: 100 },
    );
  });
  it('denies fresh membership revocation before a repeated private read', async () => {
    runtime.cloud = true;
    const f = setup('AI');
    const actor = captureWorkflowActor({
      organizationId: 'org-1',
      userId: 'user-1',
    });
    await f.service.getBrandViralVideos('org-1', 'brand-1', {}, actor);
    f.prisma.member.findFirst.mockResolvedValue(null as never);
    f.brands.findOne.mockClear();
    f.videos.getViralVideos.mockClear();
    await expect(
      f.service.getBrandViralVideos('org-1', 'brand-1', {}, actor),
    ).rejects.toThrow('Brand access denied');
    expect(f.brands.findOne).not.toHaveBeenCalled();
    expect(f.videos.getViralVideos).not.toHaveBeenCalled();
  });
});
