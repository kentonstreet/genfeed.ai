import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { BrandsService } from '@api/collections/brands/services/brands.service';
import { ReviewablePostsService } from '@api/collections/posts/services/reviewable-posts.service';
import { SkillsService } from '@api/collections/skills/services/skills.service';
import { ContentGatewayService } from '@api/services/content-gateway/content-gateway.service';
import { SkillWorkflowService } from '@api/services/skill-executor/skill-executor.service';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { testId } from '@helpers/testing/test-id.helper';
import { LoggerService } from '@libs/logger/logger.service';
import { Test, type TestingModule } from '@nestjs/testing';

const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));

describe('ContentGatewayService', () => {
  let service: ContentGatewayService;
  let brandsService: { findOne: ReturnType<typeof vi.fn> };
  let skillsService: { getEnabledSkillSlugs: ReturnType<typeof vi.fn> };
  let skillWorkflowService: { execute: ReturnType<typeof vi.fn> };
  let reviewablePostsService: {
    createFromSkillExecution: ReturnType<typeof vi.fn>;
  };

  const actor = {
    organizationId: testId('org'),
    userId: 'user-1',
    isApiKey: false,
    scopes: [] as string[],
  };
  const prisma = {
    user: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    brand: { findFirst: vi.fn() },
    apiKey: { findFirst: vi.fn() },
  };
  beforeEach(async () => {
    runtime.cloud = false;
    prisma.user.findFirst.mockResolvedValue({ id: actor.userId });
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [{ id: testId('brand') }],
    });
    prisma.brand.findFirst.mockImplementation(async ({ where }) => {
      const id = where.AND[1].id;
      const ids = where.AND[0].id?.in;
      return id === testId('brand') && (ids === undefined || ids.includes(id))
        ? { id }
        : null;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContentGatewayService,
        BrandAccessService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: BrandsService,
          useValue: { findOne: vi.fn().mockResolvedValue({ id: 'brand' }) },
        },
        {
          provide: SkillsService,
          useValue: {
            getEnabledSkillSlugs: vi
              .fn()
              .mockResolvedValue(['content-writing']),
          },
        },
        {
          provide: SkillWorkflowService,
          useValue: {
            execute: vi.fn().mockResolvedValue({
              draft: {
                content: 'hello',
                metadata: {},
                platforms: [],
                skillSlug: 'content-writing',
                type: 'text',
              },
              executionId: 'execution-1',
            }),
          },
        },
        {
          provide: ReviewablePostsService,
          useValue: {
            createFromSkillExecution: vi
              .fn()
              .mockResolvedValue([{ id: 'post-1', description: 'hello' }]),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            debug: vi.fn(),
            error: vi.fn(),
            log: vi.fn(),
            warn: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(ContentGatewayService);
    brandsService = module.get(BrandsService);
    skillsService = module.get(SkillsService);
    skillWorkflowService = module.get(SkillWorkflowService);
    reviewablePostsService = module.get(ReviewablePostsService);
  });

  afterEach(() => vi.clearAllMocks());

  it('routes a signal and returns posts with workflow executions', async () => {
    const result = await service.routeSignal({
      brandId: testId('brand'),
      organizationId: testId('org'),
      payload: { campaignId: 'ccampaign0001', skillSlugs: ['content-writing'] },
      type: 'cron',
    });

    expect(brandsService.findOne).toHaveBeenCalled();
    expect(skillsService.getEnabledSkillSlugs).toHaveBeenCalled();
    expect(skillWorkflowService.execute).toHaveBeenCalled();
    expect(
      reviewablePostsService.createFromSkillExecution,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'ccampaign0001',
        executionId: 'execution-1',
      }),
    );
    expect(result.executions).toEqual(['execution-1']);
    expect(result.posts).toHaveLength(1);
  });

  it('processes a manual request through the canonical skill workflow', async () => {
    const organizationId = testId('org');
    const brandId = testId('brand');
    const result = await service.processManualRequest(
      organizationId,
      brandId,
      'content-writing',
      { prompt: 'hello' },
      'user-1',
    );

    expect(skillWorkflowService.execute).toHaveBeenCalledWith(
      'content-writing',
      expect.objectContaining({ brandId, organizationId }),
      { prompt: 'hello' },
      'user-1',
      undefined,
    );
    expect(result.executions).toEqual(['execution-1']);
  });

  it('rejects a missing brand before workflow execution', async () => {
    brandsService.findOne.mockResolvedValue(null);
    await expect(
      service.processManualRequest(
        testId('org'),
        testId('brand', 2),
        'content-writing',
      ),
    ).rejects.toThrow();
    expect(skillWorkflowService.execute).not.toHaveBeenCalled();
  });

  it('returns no executions when no skills are enabled', async () => {
    skillsService.getEnabledSkillSlugs.mockResolvedValue([]);
    const result = await service.routeSignal({
      brandId: testId('brand'),
      organizationId: testId('org'),
      payload: {},
      type: 'cron',
    });
    expect(result).toEqual({ executions: [], posts: [] });
    expect(skillWorkflowService.execute).not.toHaveBeenCalled();
  });
  describe('fresh Cloud gateway admission', () => {
    beforeEach(() => {
      runtime.cloud = true;
    });
    it('denies missing actor before brand, skill or post reads', async () => {
      await expect(
        service.processManualRequest(
          actor.organizationId,
          testId('brand'),
          'content-writing',
          {},
          actor.userId,
        ),
      ).rejects.toThrow('Brand access denied');
      expect(brandsService.findOne).not.toHaveBeenCalled();
      expect(skillWorkflowService.execute).not.toHaveBeenCalled();
      expect(
        reviewablePostsService.createFromSkillExecution,
      ).not.toHaveBeenCalled();
    });
    it('denies zero assignments before skill admission and post creation', async () => {
      prisma.member.findFirst.mockResolvedValue({
        role: { key: MemberRole.USER },
        brands: [],
      });
      await expect(
        service.routeSignal({
          organizationId: actor.organizationId,
          brandId: testId('brand'),
          userId: actor.userId,
          initiatingActor: actor,
          type: 'cron',
          payload: {},
        }),
      ).rejects.toThrow('Brand access denied');
      expect(brandsService.findOne).not.toHaveBeenCalled();
      expect(skillsService.getEnabledSkillSlugs).not.toHaveBeenCalled();
      expect(skillWorkflowService.execute).not.toHaveBeenCalled();
    });
    it('passes only the authenticated actor into skill execution and omits proof from posts', async () => {
      await service.processManualRequest(
        actor.organizationId,
        testId('brand'),
        'content-writing',
        { prompt: 'hello' },
        actor.userId,
        actor,
      );
      expect(skillWorkflowService.execute).toHaveBeenCalledWith(
        'content-writing',
        expect.objectContaining({
          organizationId: actor.organizationId,
          brandId: testId('brand'),
        }),
        { prompt: 'hello' },
        actor.userId,
        actor,
      );
      const payload =
        reviewablePostsService.createFromSkillExecution.mock.calls[0][0];
      expect(payload.userId).toBe(actor.userId);
      expect(payload).not.toHaveProperty('initiatingActor');
      expect(payload).not.toHaveProperty('scopes');
      expect(payload).not.toHaveProperty('apiKeyId');
    });
    it('denies revocation after skill execution before creating reviewable posts', async () => {
      skillWorkflowService.execute.mockImplementationOnce(async () => {
        prisma.member.findFirst.mockResolvedValue(null);
        return {
          executionId: 'execution-1',
          draft: {
            content: 'hello',
            metadata: {},
            platforms: [],
            skillSlug: 'content-writing',
            type: 'text',
          },
        };
      });
      await expect(
        service.processManualRequest(
          actor.organizationId,
          testId('brand'),
          'content-writing',
          {},
          actor.userId,
          actor,
        ),
      ).rejects.toThrow('Brand access denied');
      expect(skillWorkflowService.execute).toHaveBeenCalledTimes(1);
      expect(
        reviewablePostsService.createFromSkillExecution,
      ).not.toHaveBeenCalled();
    });
  });
});
