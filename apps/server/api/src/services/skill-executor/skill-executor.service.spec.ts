import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  workflowActorKey,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import { BUILT_IN_SKILL_CATALOG } from '@api/collections/skills/constants/skill-validation.constant';
import { SkillLibraryService } from '@api/collections/skills/services/skill-library.service';
import { SkillsService } from '@api/collections/skills/services/skills.service';
import {
  buildHiddenSystemWorkflowMetadata,
  SYSTEM_WORKFLOW_PRINCIPAL_ID,
} from '@api/collections/workflows/system-workflow.contract';
import type { SystemWorkflowActionRequest } from '@api/collections/workflows/system-workflow-runner.service';
import { SystemWorkflowRunnerService } from '@api/collections/workflows/system-workflow-runner.service';
import { buildWorkflowVersionDefinition } from '@api/collections/workflows/workflow-version-definition';
import { ContentGeoOptimizerHandler } from '@api/services/skill-executor/handlers/content-geo-optimizer.handler';
import { ContentWritingHandler } from '@api/services/skill-executor/handlers/content-writing.handler';
import { ImageGenerationHandler } from '@api/services/skill-executor/handlers/image-generation.handler';
import { TrendDiscoveryHandler } from '@api/services/skill-executor/handlers/trend-discovery.handler';
import { TrendRemixHandler } from '@api/services/skill-executor/handlers/trend-remix.handler';
import { SkillWorkflowService } from '@api/services/skill-executor/skill-executor.service';
import { buildSkillWorkflowDefinition } from '@api/services/skill-executor/skill-workflow-definition';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { sha256Hex, stableStringify } from '@libs/utils/canonical-hash.util';
import { Test, type TestingModule } from '@nestjs/testing';

const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));

describe('SkillWorkflowService', () => {
  const handler = { execute: vi.fn() };
  const skills = {
    assertBrandSkillEnabled: vi.fn(),
    getSkillById: vi.fn(),
  };
  const runner = {
    registerAction: vi.fn(),
    registerWorkflow: vi.fn(),
    runWorkflow: vi.fn(),
  };
  const skillLibrary = {
    authorizeResolved: vi.fn(),
    recordResolution: vi.fn(),
  };
  let service: SkillWorkflowService;
  const prisma = {
    user: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    brand: { findFirst: vi.fn() },
    apiKey: { findFirst: vi.fn() },
    workflowExecution: { findFirst: vi.fn() },
  };

  beforeEach(async () => {
    runtime.cloud = false;
    vi.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [{ id: 'brand-1' }],
    });
    prisma.brand.findFirst.mockImplementation(async ({ where }) => {
      const ids = where.AND[0].id?.in;
      const id = where.AND[1].id;
      return id === 'brand-1' && (ids === undefined || ids.includes(id))
        ? { id }
        : null;
    });
    prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['read'] });
    const builtIn = BUILT_IN_SKILL_CATALOG.find(
      (skill) => skill.slug === 'content-writing',
    );
    if (!builtIn) throw new Error('Missing content-writing fixture');
    skills.getSkillById.mockResolvedValue({
      ...builtIn,
      isEnabled: true,
      status: 'published',
    });
    skillLibrary.authorizeResolved.mockResolvedValue({
      excluded: [],
      included: [],
      versions: [],
    });
    runner.runWorkflow.mockResolvedValue({
      provenance: { executionId: 'execution-1' },
      result: {
        content: 'Generated content',
        metadata: {},
        platforms: ['instagram'],
        skillSlug: 'content-writing',
        type: 'text',
      },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillWorkflowService,
        BrandAccessService,
        { provide: PrismaService, useValue: prisma },
        { provide: SkillsService, useValue: skills },
        { provide: SystemWorkflowRunnerService, useValue: runner },
        { provide: ContentGeoOptimizerHandler, useValue: handler },
        { provide: ContentWritingHandler, useValue: handler },
        { provide: ImageGenerationHandler, useValue: handler },
        { provide: TrendDiscoveryHandler, useValue: handler },
        { provide: TrendRemixHandler, useValue: handler },
        { provide: SkillLibraryService, useValue: skillLibrary },
      ],
    }).compile();
    service = module.get(SkillWorkflowService);
  });

  it('registers every exact skill action and immutable workflow', () => {
    service.onModuleInit();
    expect(runner.registerAction).toHaveBeenCalledTimes(5);
    expect(runner.registerWorkflow).toHaveBeenCalledTimes(5);
  });

  it('runs the selected canonical workflow and returns its provenance', async () => {
    const result = await service.execute(
      'content-writing',
      {
        brandId: 'brand-1',
        brandVoice: 'Direct',
        organizationId: 'org-1',
        platforms: ['instagram'],
      },
      { topic: 'launch' },
      'user-1',
    );
    expect(runner.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: 'skill.content-writing',
        organizationId: 'org-1',
        userId: 'user-1',
      }),
    );
    expect(result).toMatchObject({ executionId: 'execution-1' });
  });

  it('stores the authorized version on the workflow input before execution', async () => {
    const builtIn = BUILT_IN_SKILL_CATALOG.find(
      (entry) => entry.slug === 'content-writing',
    );
    if (!builtIn) throw new Error('Missing content-writing fixture');
    skillLibrary.authorizeResolved.mockResolvedValue({
      excluded: [],
      included: [
        {
          ...builtIn,
          defaultInstructions: 'version one',
          systemPromptTemplate: 'version one',
        },
      ],
      versions: [
        {
          contentHash: 'hash-v1',
          skillId: builtIn.id,
          skillVersionId: 'sv-1',
        },
      ],
    });
    await service.execute(
      'content-writing',
      {
        brandId: 'brand-1',
        brandVoice: 'Direct',
        organizationId: 'org-1',
        platforms: ['instagram'],
      },
      { topic: 'launch' },
      'user-1',
    );
    expect(runner.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        inputValues: expect.objectContaining({
          context: expect.objectContaining({
            pinnedSkills: [
              expect.objectContaining({
                contentHash: 'hash-v1',
                slug: 'content-writing',
                versionId: 'sv-1',
              }),
            ],
          }),
        }),
      }),
    );
  });

  it('pins the authorized version onto the workflow input and reuses it', async () => {
    service.onModuleInit();
    const registration = runner.registerAction.mock.calls.find((call) =>
      String(call[0]).includes('content-writing'),
    );
    const action = registration?.[1] as
      | ((request: {
          context: { organizationId: string; userId: string };
          input: {
            context: Record<string, unknown>;
            params: Record<string, unknown>;
          };
        }) => Promise<unknown>)
      | undefined;
    if (!action) throw new Error('content-writing action was not registered');
    skillLibrary.authorizeResolved.mockImplementation(
      async (
        _actor: unknown,
        docs: Array<{ id: string }>,
        pins: Array<{ skillVersionId?: string }>,
      ) => ({
        excluded: [],
        included: docs.map((doc) => ({
          ...doc,
          defaultInstructions: 'version one',
          systemPromptTemplate: 'version one',
        })),
        versions: [
          {
            contentHash: 'hash-v1',
            skillId: String(docs[0]?.id),
            skillVersionId: pins[0]?.skillVersionId ?? 'sv-1',
          },
        ],
      }),
    );
    const context: Record<string, unknown> = {
      brandId: 'brand-1',
      brandVoice: 'Direct',
      organizationId: 'org-1',
      platforms: ['instagram'],
    };
    const request = {
      context: { organizationId: 'org-1', userId: 'user-1' },
      input: { context, params: { topic: 'launch' } },
    };

    await action(request);
    await action(request);

    expect(skills.getSkillById).toHaveBeenCalledWith(
      'org-1',
      'content-writing',
      'user-1',
    );
    expect(context.pinnedSkills).toEqual([
      expect.objectContaining({
        contentHash: 'hash-v1',
        slug: 'content-writing',
        versionId: 'sv-1',
      }),
    ]);
    expect(skillLibrary.authorizeResolved).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.any(Array),
      [
        expect.objectContaining({
          contentHash: 'hash-v1',
          skillVersionId: 'sv-1',
        }),
      ],
    );
    expect(skillLibrary.recordResolution).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      [expect.objectContaining({ skillVersionId: 'sv-1' })],
      [],
    );
  });

  it('rejects a slug outside the reviewed action catalog', async () => {
    await expect(
      service.execute('custom-skill', {
        brandId: 'brand-1',
        brandVoice: '',
        organizationId: 'org-1',
        platforms: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(runner.runWorkflow).not.toHaveBeenCalled();
  });
  function persistedAction() {
    skillLibrary.authorizeResolved.mockImplementation(
      async (_actor: unknown, docs: unknown[]) => ({
        included: docs,
        excluded: [],
        versions: [],
      }),
    );
    const actor = captureWorkflowActor({
      organizationId: 'org-1',
      userId: 'user-1',
    });
    const input = {
      context: {
        organizationId: 'org-1',
        brandId: 'brand-1',
        brandVoice: 'Direct',
        platforms: ['instagram'],
        initiatingActor: actor,
      },
      params: { topic: 'launch' },
    };
    const execution = {
      id: 'run',
      userId: 'user-1',
      workflowId: 'mirror',
      workflowVersionId: 'pinned',
      workflow: {
        organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
        userId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
        isDeleted: false,
        metadata: {
          sourceType: 'hidden-system-workflow',
          systemWorkflow: buildHiddenSystemWorkflowMetadata({
            canonicalId: 'skill.content-writing',
          }),
        },
      },
      workflowVersion: {
        id: 'pinned',
        ...buildWorkflowVersionDefinition(
          buildSkillWorkflowDefinition('content-writing').definition,
        ),
        workflowId: 'mirror',
        organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
        userId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
      },
      result: {
        inputValues: input,
        metadata: {
          canonicalId: 'skill.content-writing',
          source: 'SkillWorkflowService.execute',
          initiatingActorKey: workflowActorKey(actor),
          initiatingRequestKey: workflowRequestKey(input),
        },
      },
    };
    const action = {
      context: {
        organizationId: 'org-1',
        userId: 'user-1',
        workflowId: 'mirror',
        workflowVersionId: 'pinned',
        runId: 'run',
      },
      provenance: {
        executionId: 'run',
        workflowId: 'mirror',
        workflowLabel: 'Writing',
        nodeId: 'execute-skill',
      },
      input: structuredClone(input),
    } satisfies SystemWorkflowActionRequest;
    prisma.workflowExecution.findFirst.mockResolvedValue(execution);
    service.onModuleInit();
    const registration = runner.registerAction.mock.calls.find((call) =>
      String(call[0]).includes('content-writing'),
    );
    if (!registration)
      throw new Error('Missing actual registered writing action');
    return {
      actor,
      input,
      execution,
      action,
      execute: registration[1] as (
        request: SystemWorkflowActionRequest,
      ) => Promise<unknown>,
    };
  }
  it('denies missing Cloud initiating authority before library or workflow reads', async () => {
    runtime.cloud = true;
    await expect(
      service.execute(
        'content-writing',
        {
          organizationId: 'org-1',
          brandId: 'brand-1',
          brandVoice: '',
          platforms: [],
        },
        {},
        'user-1',
      ),
    ).rejects.toThrow('Brand access denied');
    expect(skills.getSkillById).not.toHaveBeenCalled();
    expect(runner.runWorkflow).not.toHaveBeenCalled();
  });
  it('admits actual pinned server capture and supplies a separate consequential boundary callback', async () => {
    runtime.cloud = true;
    const f = persistedAction();
    handler.execute.mockResolvedValue({ content: 'Draft' });
    await f.execute(f.action);
    expect(handler.execute).toHaveBeenCalledWith(
      expect.objectContaining({ initiatingActor: f.actor, brandId: 'brand-1' }),
      { topic: 'launch' },
      expect.any(Function),
    );
    const context = handler.execute.mock.calls[0][0];
    expect(context).not.toHaveProperty('admission');
    const admission = handler.execute.mock.calls[0][2] as () => Promise<void>;
    prisma.member.findFirst.mockResolvedValueOnce(null);
    await expect(admission()).rejects.toThrow('Brand access denied');
  });
  it.each([
    'actor',
    'input',
    'hidden',
    'version',
    'source',
    'hash',
    'node',
    'action',
  ] as const)('denies forged %s before handler dispatch', async (kind) => {
    runtime.cloud = true;
    const f = persistedAction();
    if (kind === 'actor')
      f.execution.result.inputValues.context.initiatingActor.userId = 'other';
    if (kind === 'input') f.action.input.params.topic = 'tampered';
    if (kind === 'hidden') f.execution.workflow.isDeleted = true;
    if (kind === 'version') f.action.context.workflowVersionId = 'unbound';
    if (kind === 'hash') f.execution.workflowVersion.contentHash = 'tampered';
    if (kind === 'node') f.action.provenance.nodeId = 'foreign-node';
    if (kind === 'action') {
      const version = f.execution.workflowVersion;
      version.graph.nodes[0].data.config.actionId = 'foreign-action';
      version.contentHash = `sha256:v1:${sha256Hex(stableStringify({ graph: version.graph, inputSchema: version.inputSchema }))}`;
    }
    if (kind === 'source') f.execution.result.metadata.source = 'client';
    await expect(f.execute(f.action)).rejects.toThrow('Brand access denied');
    expect(handler.execute).not.toHaveBeenCalled();
  });
  it('denies canonical downgrade and empty assignments before private skill/library reads', async () => {
    runtime.cloud = true;
    const f = persistedAction();
    prisma.member.findFirst.mockResolvedValue({
      role: { key: MemberRole.USER },
      brands: [],
    });
    await expect(f.execute(f.action)).rejects.toThrow('Brand access denied');
    expect(skills.getSkillById).not.toHaveBeenCalled();
    expect(handler.execute).not.toHaveBeenCalled();
  });
});
