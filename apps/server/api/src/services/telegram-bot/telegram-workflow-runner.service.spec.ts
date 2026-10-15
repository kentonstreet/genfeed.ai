import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  workflowActorKey,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import type { SystemWorkflowRunnerService } from '@api/collections/workflows/system-workflow-runner.service';
import type {
  ChatAuthContext,
  ConversationState,
} from '@api/services/telegram-bot/telegram-bot.types';
import { TelegramWorkflowRunnerService } from '@api/services/telegram-bot/telegram-workflow-runner.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import type { LoggerService } from '@libs/logger/logger.service';
import type { Context } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: true }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
function fixture() {
  const member = {
    currentBrandId: 'brand',
    role: { key: MemberRole.OWNER },
    brands: [{ id: 'brand' }],
  };
  const db = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user' }) },
    apiKey: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ scopes: ['read'], defaultBrandId: 'brand' }),
    },
    member: { findFirst: vi.fn().mockImplementation(async () => member) },
    brand: {
      findFirst: vi
        .fn()
        .mockImplementation(
          async ({
            where,
          }: {
            where: { AND?: Array<{ id?: { in: string[] } }> };
          }) => {
            const ids = where.AND?.[0].id?.in;
            return ids && !ids.includes('brand') ? null : { id: 'brand' };
          },
        ),
    },
  };
  const prisma = db as unknown as PrismaService;
  const runWorkflow = vi.fn().mockResolvedValue({
    provenance: { executionId: 'execution' },
    result: { images: ['https://example.test/image.png'] },
  });
  const auth: ChatAuthContext = {
    authType: 'api_key',
    apiKeyId: 'key',
    organizationId: 'org',
    userId: 'user',
    scopes: ['read'],
  };
  const resolve = vi.fn().mockResolvedValue(auth);
  const service = new TelegramWorkflowRunnerService(
    { error: vi.fn() } as unknown as LoggerService,
    { runWorkflow } as unknown as SystemWorkflowRunnerService,
    prisma,
    new BrandAccessService(prisma),
    resolve,
  );
  const reply = vi.fn().mockResolvedValue({ message_id: 1 });
  const replyWithPhoto = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    reply,
    replyWithPhoto,
    from: { id: 999 },
  } as unknown as Context;
  const state: ConversationState = {
    step: 'confirming',
    workflowId: 'single-image',
    workflowName: 'Image',
    workflow: {
      version: 1,
      name: 'Image',
      description: '',
      nodes: [],
      edges: [],
    },
    requiredInputs: [],
    currentInputIndex: 0,
    collectedInputs: new Map([
      ['prompt', 'hello'],
      ['initiatingActor', 'forged'],
      ['initiatingActorKey', 'forged'],
    ]),
    startedAt: 0,
  };
  return {
    service,
    db,
    member,
    runWorkflow,
    auth,
    resolve,
    reply,
    replyWithPhoto,
    ctx,
    state,
  };
}
describe('Telegram verified-key recipe admission with real brand policy', () => {
  beforeEach(() => {
    runtime.cloud = true;
  });
  it.each([
    'single-image',
    'image-series',
    'image-to-video',
    'single-video',
    'full-pipeline',
  ])('captures the actual key for fixed recipe %s', async (recipe) => {
    const f = fixture();
    f.state.workflowId = recipe;
    await f.service.execute(f.ctx, 42, f.state);
    expect(f.runWorkflow).toHaveBeenCalledOnce();
    const input = f.runWorkflow.mock.calls[0][0];
    expect(input.canonicalId).toBe(`telegram.${recipe}`);
    expect(input.userId).toBe('user');
    expect(input.inputValues.initiatingActor).toEqual({
      organizationId: 'org',
      userId: 'user',
      isApiKey: true,
      apiKeyId: 'key',
      scopes: ['read'],
    });
    expect(input.metadata.initiatingActorKey).toBe(
      workflowActorKey(input.inputValues.initiatingActor),
    );
    expect(input.metadata.initiatingRequestKey).toBe(
      workflowRequestKey(input.inputValues),
    );
    expect(input.inputValues).not.toHaveProperty('initiatingActorKey');
    expect(input.inputValues.initiatingActor).not.toHaveProperty('token');
    expect(f.replyWithPhoto).toHaveBeenCalledOnce();
  });
  it('denies environment-default Cloud identity before private lookup', async () => {
    const f = fixture();
    f.resolve.mockResolvedValue({
      authType: 'better_auth',
      organizationId: 'org',
      userId: 'user',
    });
    await f.service.execute(f.ctx, 42, f.state);
    expect(f.db.member.findFirst).not.toHaveBeenCalled();
    expect(f.db.apiKey.findFirst).not.toHaveBeenCalled();
    expect(f.runWorkflow).not.toHaveBeenCalled();
  });
  it('denies arbitrary recipe canonicals before private lookup', async () => {
    const f = fixture();
    f.state.workflowId = 'custom';
    await f.service.execute(f.ctx, 42, f.state);
    expect(f.db.member.findFirst).not.toHaveBeenCalled();
    expect(f.runWorkflow).not.toHaveBeenCalled();
  });
  it('does not turn an owner read key or selected default brand into a grant', async () => {
    const f = fixture();
    f.member.brands = [];
    await f.service.execute(f.ctx, 42, f.state);
    expect(f.runWorkflow).not.toHaveBeenCalled();
    expect(f.replyWithPhoto).not.toHaveBeenCalled();
  });
  it('denies revoked or expired key before reading a brand', async () => {
    const f = fixture();
    f.db.apiKey.findFirst.mockResolvedValue(null);
    await f.service.execute(f.ctx, 42, f.state);
    expect(f.db.brand.findFirst).not.toHaveBeenCalled();
    expect(f.runWorkflow).not.toHaveBeenCalled();
  });
  it('denies key revocation during preference lookup before dispatch', async () => {
    const f = fixture();
    f.db.apiKey.findFirst
      .mockResolvedValueOnce({ scopes: ['read'], defaultBrandId: 'brand' })
      .mockResolvedValueOnce({ scopes: ['read'], defaultBrandId: 'brand' })
      .mockResolvedValue(null);
    await f.service.execute(f.ctx, 42, f.state);
    expect(f.runWorkflow).not.toHaveBeenCalled();
  });
  it('rechecks current assignment before exposing completed private output', async () => {
    const f = fixture();
    f.runWorkflow.mockImplementation(async () => {
      f.member.brands = [];
      return {
        provenance: { executionId: 'execution' },
        result: { images: ['https://example.test/private.png'] },
      };
    });
    await f.service.execute(f.ctx, 42, f.state);
    expect(f.runWorkflow).toHaveBeenCalledOnce();
    expect(f.replyWithPhoto).not.toHaveBeenCalled();
    expect(
      f.reply.mock.calls
        .flat()
        .some(
          (value) =>
            typeof value === 'string' && value.includes('Workflow completed'),
        ),
    ).toBe(false);
  });
  it('preserves selfhost configured current-brand execution', async () => {
    runtime.cloud = false;
    const f = fixture();
    f.resolve.mockResolvedValue({
      authType: 'better_auth',
      organizationId: 'org',
      userId: 'user',
    });
    f.db.member.findFirst.mockResolvedValue({
      ...f.member,
      currentBrandId: 'brand',
    });
    await f.service.execute(f.ctx, 42, f.state);
    expect(f.runWorkflow).toHaveBeenCalledOnce();
    expect(f.db.user.findFirst).not.toHaveBeenCalled();
  });
});
