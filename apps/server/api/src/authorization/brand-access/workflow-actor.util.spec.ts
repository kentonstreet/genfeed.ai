import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  capturePublicWorkflowActorEnvelope,
  captureWorkflowActor,
  captureWorkflowActorEnvelope,
  captureWorkflowScheduleActor,
  parseWorkflowActor,
  readWorkflowScheduleActor,
  refreshWorkflowActor,
  workflowActorKey,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: true }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
function fixture() {
  const actor = captureWorkflowActor({
    organizationId: 'org',
    userId: 'user',
    isApiKey: true,
    apiKeyId: 'key',
    scopes: ['admin', 'read'],
  });
  const prisma = {
    botAccountLink: {
      findFirst: vi.fn().mockResolvedValue({
        capturedIsApiKey: true,
        capturedApiKeyId: 'key',
        capturedScopes: ['read'],
      }),
    },
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user' }) },
    apiKey: { findFirst: vi.fn().mockResolvedValue({ scopes: ['read'] }) },
    member: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ role: { key: MemberRole.OWNER }, brands: [] }),
    },
  };
  const db = prisma as unknown as PrismaService;
  return { actor, prisma, db, policy: new BrandAccessService(db) };
}
describe('server workflow actor capture and fresh admission', () => {
  beforeEach(() => {
    runtime.cloud = true;
  });
  it('normalizes named principal fields without copying client extras or secrets', () => {
    const supplied = {
      organizationId: 'org',
      userId: 'user',
      isApiKey: false,
      scopes: ['read', 'read'],
      role: MemberRole.OWNER,
      token: 'secret',
    };
    expect(captureWorkflowActor(supplied)).toEqual({
      organizationId: 'org',
      userId: 'user',
      isApiKey: false,
      scopes: ['read'],
    });
  });
  it('binds a configured producer identity without copying owner privilege or secrets', () => {
    const envelope = captureWorkflowActorEnvelope({
      organizationId: 'org',
      userId: 'configured-user',
      isApiKey: false,
      scopes: [],
    });
    expect(envelope.inputValues).toEqual({
      initiatingActor: {
        organizationId: 'org',
        userId: 'configured-user',
        isApiKey: false,
        scopes: [],
      },
    });
    expect(envelope.metadata).toEqual({
      initiatingActorKey: workflowActorKey(
        envelope.inputValues.initiatingActor,
      ),
      initiatingRequestKey: workflowRequestKey(envelope.inputValues),
    });
    expect(() =>
      captureWorkflowActorEnvelope({ organizationId: 'org', userId: '' }),
    ).toThrow('Brand access denied');
  });
  it('replaces recursively forged public actor proofs and internal-source metadata with the actual key principal', () => {
    const { actor } = fixture();
    const envelope = capturePublicWorkflowActorEnvelope(
      actor,
      {
        prompt: 'Keep this',
        initiatingActor: { isApiKey: false },
        nested: [{ initiatingActorKey: 'forged', publicValue: 0 }],
      },
      {
        source: 'AgentTurnAcceptanceService.accept',
        canonicalId: 'agent.turn.execute',
        isSystemAction: true,
        agentScope: { role: 'OWNER' },
        debugMode: true,
        nested: { initiatingRequestKey: 'forged', publicValue: false },
      },
    );
    expect(envelope.inputValues).toEqual({
      prompt: 'Keep this',
      nested: [{ publicValue: 0 }],
      initiatingActor: actor,
    });
    expect(envelope.metadata).toEqual({
      debugMode: true,
      nested: { publicValue: false },
      initiatingActorKey: workflowActorKey(actor),
      initiatingRequestKey: workflowRequestKey(envelope.inputValues),
    });
  });
  it.each([
    undefined,
    {},
    {
      organizationId: 'org',
      userId: 'user',
      isApiKey: true,
      scopes: ['admin'],
    },
    { organizationId: 'other', userId: 'user', isApiKey: false, scopes: [] },
    { organizationId: 'org', userId: '', isApiKey: false, scopes: [] },
    { organizationId: 'org', userId: 'user', isApiKey: false, scopes: [1] },
  ])('denies malformed captured actor %j', (value) => {
    expect(() => parseWorkflowActor(value, 'org')).toThrow(
      'Brand access denied',
    );
  });
  it('intersects captured and current key scopes before canonical role policy', async () => {
    const f = fixture();
    const actor = await refreshWorkflowActor(f.db, f.policy, f.actor, 'org');
    expect(actor.scopes).toEqual(['read']);
    expect((await f.policy.resolve(actor)).brandIds).toEqual([]);
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
    expect(f.prisma.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user',
          organizationId: 'org',
          isActive: true,
          isDeleted: false,
          role: { isDeleted: false },
        }),
      }),
    );
  });
  it.each(['user', 'apiKey', 'member'] as const)(
    'denies revoked or missing canonical %s before authority is returned',
    async (delegate) => {
      const f = fixture();
      f.prisma[delegate].findFirst.mockResolvedValueOnce(null);
      await expect(
        refreshWorkflowActor(f.db, f.policy, f.actor, 'org'),
      ).rejects.toThrow('Brand access denied');
    },
  );
  it('does not acquire privileges when a key gains scopes after capture', async () => {
    const f = fixture();
    f.actor.scopes = ['read'];
    f.prisma.apiKey.findFirst.mockResolvedValue({ scopes: ['admin', 'read'] });
    const actor = await refreshWorkflowActor(f.db, f.policy, f.actor, 'org');
    expect(actor.scopes).toEqual(['read']);
    expect((await f.policy.resolve(actor)).brandIds).toEqual([]);
  });
  it('retains immutable verified-link revision and intersects link capture with current key authority', async () => {
    const f = fixture();
    const actor = captureWorkflowActor({
      ...f.actor,
      botAccountLinkId: 'link',
      botAccountLinkRevision: 4,
    });
    const refreshed = await refreshWorkflowActor(f.db, f.policy, actor, 'org');
    expect(refreshed).toEqual({ ...actor, scopes: ['read'] });
    expect(f.prisma.botAccountLink.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'link',
        revision: 4,
        organizationId: 'org',
        userId: 'user',
        isDeleted: false,
        revokedAt: null,
        integration: {
          organizationId: 'org',
          isDeleted: false,
          status: 'ACTIVE',
        },
      },
      select: {
        capturedIsApiKey: true,
        capturedApiKeyId: true,
        capturedScopes: true,
      },
    });
    expect(f.actor.scopes).toEqual(['admin', 'read']);
  });
  it.each([
    null,
    { capturedIsApiKey: false, capturedApiKeyId: null, capturedScopes: [] },
    {
      capturedIsApiKey: true,
      capturedApiKeyId: 'other-key',
      capturedScopes: ['admin'],
    },
  ])(
    'denies revoked/relinked/mismatched mapping %j without treating a key as a session',
    async (mapping) => {
      const f = fixture();
      f.prisma.botAccountLink.findFirst.mockResolvedValue(mapping);
      await expect(
        refreshWorkflowActor(
          f.db,
          f.policy,
          {
            ...f.actor,
            botAccountLinkId: 'link',
            botAccountLinkRevision: 4,
          },
          'org',
        ),
      ).rejects.toThrow('Brand access denied');
      expect(f.prisma.apiKey.findFirst).not.toHaveBeenCalled();
    },
  );
  it.each([
    { botAccountLinkId: 'link' },
    { botAccountLinkRevision: 1 },
    { botAccountLinkId: 'link', botAccountLinkRevision: 0 },
    { botAccountLinkId: 'link', botAccountLinkRevision: 1.5 },
  ])('denies incomplete or malformed link reference %j', (reference) => {
    const f = fixture();
    expect(() => captureWorkflowActor({ ...f.actor, ...reference })).toThrow(
      'Brand access denied',
    );
  });
  it('preserves selfhost policy without querying cloud users, keys, or memberships', async () => {
    runtime.cloud = false;
    const f = fixture();
    await expect(
      refreshWorkflowActor(f.db, f.policy, f.actor, 'org'),
    ).resolves.toEqual(f.actor);
    expect(f.prisma.user.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.apiKey.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.member.findFirst).not.toHaveBeenCalled();
  });
  it('binds authority separately from immutable public request values', () => {
    const f = fixture();
    expect(workflowActorKey(f.actor)).not.toBe(
      workflowActorKey({ ...f.actor, userId: 'other' }),
    );
    const original = {
      request: { brandId: 'one', text: 'draft', initiatingActor: f.actor },
      metadata: {
        public: [1, null],
        initiatingActorKey: 'private',
        initiatingRequestKey: 'private',
      },
    };
    const reordered = {
      metadata: { public: [1, null] },
      request: { text: 'draft', brandId: 'one' },
    };
    expect(workflowRequestKey(original)).toBe(workflowRequestKey(reordered));
    expect(workflowRequestKey(original)).not.toBe(
      workflowRequestKey({
        ...reordered,
        request: { ...reordered.request, brandId: 'other' },
      }),
    );
    expect(original.request.initiatingActor).toEqual(f.actor);
  });
});

describe('server schedule configuration binding', () => {
  const configuration = {
    workflowId: 'workflow',
    organizationId: 'org',
    schedule: '0 9 * * *',
    timezone: 'UTC',
    isScheduleEnabled: true,
  };
  beforeEach(() => {
    runtime.cloud = true;
  });
  it('retains the actual configuring key without owner privilege or secrets', () => {
    const { actor } = fixture();
    const capture = captureWorkflowScheduleActor(actor, configuration);
    expect(readWorkflowScheduleActor(capture, configuration)).toEqual(actor);
    expect(capture.initiatingActor).toEqual({
      userId: 'user',
      organizationId: 'org',
      isApiKey: true,
      apiKeyId: 'key',
      scopes: ['admin', 'read'],
    });
  });
  it.each([
    { schedule: '0 10 * * *' },
    { timezone: 'Europe/Malta' },
    { isScheduleEnabled: false },
    { workflowId: 'foreign-workflow' },
    { organizationId: 'foreign-org' },
  ])('rejects a capture reused for a different configuration %j', (change) => {
    const capture = captureWorkflowScheduleActor(
      fixture().actor,
      configuration,
    );
    expect(() =>
      readWorkflowScheduleActor(capture, { ...configuration, ...change }),
    ).toThrow('Brand access denied');
  });
  it('holds unbound old Cloud history and a forged session upgrade', () => {
    expect(() => readWorkflowScheduleActor(null, configuration)).toThrow(
      'Brand access denied',
    );
    const capture = captureWorkflowScheduleActor(
      fixture().actor,
      configuration,
    );
    expect(() =>
      readWorkflowScheduleActor(
        {
          ...capture,
          initiatingActor: { ...capture.initiatingActor, isApiKey: false },
        },
        configuration,
      ),
    ).toThrow('Brand access denied');
  });
});
