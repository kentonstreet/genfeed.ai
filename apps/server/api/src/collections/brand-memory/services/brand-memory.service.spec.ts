const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isCloudDeployment: () => runtime.cloud,
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@genfeedai/prisma', async () => {
  const { canonicalPrismaMock } = await import(
    '@api/shared/testing/prisma-mock'
  );
  return canonicalPrismaMock();
});

import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { BrandMemoryService } from '@api/collections/brand-memory/services/brand-memory.service';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { expectCloudGuardPasses } from '@api/shared/testing/cloud-guard-assertions';
import { MemberRole } from '@genfeedai/contracts';
import { LoggerService } from '@libs/logger/logger.service';
import { runWithTenantContext } from '@libs/prisma/tenant-context';

describe('BrandMemoryService typed entries', () => {
  const brandMemory = {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  };
  const transaction = vi.fn(
    async (work: (tx: PrismaService) => Promise<unknown>) => work(prisma),
  );
  const member = { findFirst: vi.fn() };
  const brand = { findFirst: vi.fn() };
  const prisma = {
    brandMemory,
    member,
    brand,
    $transaction: transaction,
  } as unknown as PrismaService;
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  } as unknown as LoggerService;
  let service: BrandMemoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.cloud = false;
    member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [{ id: 'brand-1' }],
    });
    brand.findFirst.mockImplementation(async ({ where }) => {
      const predicate = where.AND?.[0];
      return predicate?.id?.in?.length === 0 ? null : { id: 'brand-1' };
    });
    brandMemory.findMany.mockResolvedValue([]);
    service = new BrandMemoryService(prisma, logger);
  });

  it('creates a typed row scoped to the organization and brand', async () => {
    brandMemory.findFirst.mockResolvedValue(null);
    brandMemory.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'memory-1', ...data }),
    );

    await service.upsertTypedEntry('org-1', 'brand-1', {
      content: 'I ran finance at a startup.',
      metadata: { fieldKey: 'originStory' },
      type: 'positioning.originStory',
    });

    expect(brandMemory.findFirst).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      where: {
        brandId: 'brand-1',
        isDeleted: false,
        organizationId: 'org-1',
        type: 'positioning.originStory',
      },
    });
    expect(brandMemory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        brandId: 'brand-1',
        content: 'I ran finance at a startup.',
        isDeleted: false,
        organizationId: 'org-1',
        type: 'positioning.originStory',
      }),
    });
  });

  it('overwrites the same typed row when the answer changes', async () => {
    brandMemory.findFirst.mockResolvedValue({
      content: 'First version',
      id: 'memory-1',
    });
    brandMemory.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'memory-1', ...data }),
    );

    await service.upsertTypedEntry('org-1', 'brand-1', {
      content: 'Second version',
      type: 'positioning.originStory',
    });

    expect(brandMemory.create).not.toHaveBeenCalled();
    expect(brandMemory.update).toHaveBeenCalledWith({
      data: expect.objectContaining({ content: 'Second version' }),
      where: { id: 'memory-1', isDeleted: false, organizationId: 'org-1' },
    });
  });

  it('lists typed rows by prefix, newest first', async () => {
    await service.listTypedEntries('org-1', 'brand-1', 'positioning.');

    expect(brandMemory.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      where: {
        brandId: 'brand-1',
        isDeleted: false,
        organizationId: 'org-1',
        type: { startsWith: 'positioning.' },
      },
    });
  });
  it('replaces a replayed analytics insight while preserving other insights', async () => {
    const source = 'analytics-threshold:engagementRate:2026-09-24';
    brandMemory.findFirst.mockResolvedValue({
      id: 'memory-1',
      insights: [
        { source: 'preference', insight: 'Keep my voice' },
        { source, insight: 'Old measurement' },
      ],
    });
    await service.addInsight('org-1', 'brand-1', {
      category: 'performance',
      confidence: 0.8,
      insight: 'Updated measurement',
      source,
    });
    expect(brandMemory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          insights: [
            { source: 'preference', insight: 'Keep my voice' },
            expect.objectContaining({ source, insight: 'Updated measurement' }),
          ],
        },
      }),
    );
  });
  it('scopes the daily-row writes to the organization in CLOUD mode', async () => {
    brandMemory.findFirst.mockResolvedValue({
      entries: [],
      id: 'memory-1',
      metrics: {},
    });
    brandMemory.update.mockResolvedValue({ id: 'memory-1' });

    await runWithTenantContext({ organizationId: 'org-1' }, async () => {
      await service.logEntry('org-1', 'brand-1', {
        content: 'note',
        type: 'note',
      } as never);
      await service.updateMetrics('org-1', 'brand-1', {
        postsPublished: 3,
      } as never);
    });

    expect(brandMemory.update).toHaveBeenCalledTimes(2);
    expectCloudGuardPasses('BrandMemory', 'findFirst', brandMemory.findFirst);
    expectCloudGuardPasses('BrandMemory', 'update', brandMemory.update);
  });
  it('denies a Cloud typed write without server admission before any private lookup', async () => {
    runtime.cloud = true;
    await expect(
      service.upsertTypedEntry('org-1', 'brand-1', {
        type: 'positioning.originStory',
        content: 'private',
      }),
    ).rejects.toThrow('Brand access denied');
    expect(brandMemory.findFirst).not.toHaveBeenCalled();
    expect(brandMemory.create).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([null, { id: 'memory-1' }])(
    'denies revocation during the typed lookup before the %s write',
    async (existing) => {
      runtime.cloud = true;
      const policy = new BrandAccessService(prisma);
      brandMemory.findFirst.mockImplementation(async () => {
        member.findFirst.mockResolvedValue({
          role: { key: MemberRole.USER },
          brands: [],
        });
        return existing;
      });
      await expect(
        service.upsertTypedEntry(
          'org-1',
          'brand-1',
          {
            type: 'positioning.originStory',
            content: 'private',
          },
          (tx) =>
            policy.assert(
              { organizationId: 'org-1', userId: 'user-1' },
              'brand-1',
              tx,
            ),
        ),
      ).rejects.toThrow('Brand access denied');
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(brandMemory.findFirst).toHaveBeenCalledTimes(1);
      expect(brandMemory.update).not.toHaveBeenCalled();
      expect(brandMemory.create).not.toHaveBeenCalled();
    },
  );

  it('writes an assigned Cloud brand using the transaction for fresh admission and persistence', async () => {
    runtime.cloud = true;
    const policy = new BrandAccessService(prisma);
    brandMemory.findFirst.mockResolvedValue(null);
    brandMemory.create.mockResolvedValue({ id: 'memory-1' });
    await service.upsertTypedEntry(
      'org-1',
      'brand-1',
      {
        type: 'positioning.originStory',
        content: 'private',
      },
      (tx) =>
        policy.assert(
          { organizationId: 'org-1', userId: 'user-1' },
          'brand-1',
          tx,
        ),
    );
    expect(member.findFirst).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(brandMemory.create).toHaveBeenCalledTimes(1);
  });
});
