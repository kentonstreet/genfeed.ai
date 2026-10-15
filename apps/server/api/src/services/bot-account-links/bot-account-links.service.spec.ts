import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  refreshWorkflowActor,
} from '@api/authorization/brand-access/workflow-actor.util';
import type { CredentialCryptoService } from '@api/collections/credentials/services/credential-crypto.service';
import type { BotInstallationRequestProof } from '@api/services/bot-account-links/bot-account-link-event-proof.util';
import { BotAccountLinksService } from '@api/services/bot-account-links/bot-account-links.service';
import type { CacheService } from '@api/services/cache/cache.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { signBotAccountLinkRequest } from '@genfeedai/integrations';
import type { ConfigService } from '@libs/config/config.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: true }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
function fixture(isApiKey = false) {
  const values = new Map<string, unknown>();
  const installation = {
    id: 'installation',
    encryptedToken: 'encrypted',
    updatedAt: new Date('2026-10-09T00:00:00Z'),
  };
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'canonical-user' }) },
    member: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ role: { key: MemberRole.OWNER }, brands: [] }),
    },
    apiKey: { findFirst: vi.fn().mockResolvedValue({ scopes: ['read'] }) },
    organization: {
      findFirst: vi.fn().mockResolvedValue({ slug: 'organization' }),
    },
    orgIntegration: { findFirst: vi.fn().mockResolvedValue(installation) },
    botAccountLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: 'link',
        revision: 1,
        ...data,
      })),
      update: vi
        .fn()
        .mockImplementation(async ({ data }) => ({ id: 'link', ...data })),
    },
    $transaction: vi.fn(async (work: (tx: PrismaService) => Promise<unknown>) =>
      work(db),
    ),
  };
  const db = prisma as unknown as PrismaService;
  const policy = new BrandAccessService(db);
  const cache = {
    acquireLock: vi.fn().mockResolvedValue(true),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      return true;
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    }),
  };
  const service = new BotAccountLinksService(
    db,
    policy,
    cache as unknown as CacheService,
    {
      decrypt: vi.fn().mockReturnValue('installation-secret'),
    } as unknown as CredentialCryptoService,
    {
      get: vi.fn().mockReturnValue('https://app.example.test'),
    } as unknown as ConfigService,
  );
  const actor = captureWorkflowActor({
    userId: 'canonical-user',
    organizationId: 'org',
    isApiKey,
    scopes: isApiKey ? ['admin', 'read'] : [],
    ...(isApiKey ? { apiKeyId: 'key' } : {}),
  });
  const event = {
    integrationId: 'installation',
    organizationId: 'org',
    platform: 'SLACK' as const,
    remoteUserId: 'sdk-user',
    channelId: 'private-channel',
    sourceEventId: 'native-event',
    isPrivate: true,
  };
  const begin = async () => {
    const request = {
      method: 'POST' as const,
      path: '/v1/internal/orgs/org/bot-links/challenges',
      event,
      body: { event },
      nonce: 'fixture-single-use-nonce',
      timestamp: Date.now(),
    };
    const proof: BotInstallationRequestProof = {
      ...request,
      signature: await signBotAccountLinkRequest(
        'installation-secret',
        request,
      ),
    };
    return service.beginChallenge('org', proof);
  };
  return { service, actor, event, prisma, db, policy, cache, values, begin };
}
describe('verified account confirmation core', () => {
  beforeEach(() => {
    runtime.cloud = true;
  });
  it('binds a private native sender to the actual authenticated canonical account with a single-use challenge', async () => {
    const f = fixture();
    const challenge = await f.begin();
    expect(new URL(challenge.confirmationUrl).pathname).toBe(
      '/organization/~/settings/account/bot-links',
    );
    expect([...f.values.keys()][0]).not.toContain(challenge.id);
    expect([...f.values.values()][0]).not.toHaveProperty('initiatingActor');
    const preview = await f.service.previewChallenge(challenge.id, f.actor);
    expect(preview.remoteUserId).toBe('sdk-user');
    const link = await f.service.confirmChallenge(challenge.id, f.actor);
    expect(link).toEqual(
      expect.objectContaining({
        userId: 'canonical-user',
        organizationId: 'org',
        integrationId: 'installation',
        remoteUserId: 'sdk-user',
        capturedIsApiKey: false,
        capturedApiKeyId: null,
        capturedScopes: [],
      }),
    );
    await expect(
      f.service.confirmChallenge(challenge.id, f.actor),
    ).rejects.toThrow('challenge unavailable');
    expect(f.prisma.botAccountLink.create).toHaveBeenCalledTimes(1);
  });
  it('keeps a key confirmation as a key and captures only the current intersection', async () => {
    const f = fixture(true);
    const challenge = await f.begin();
    const link = await f.service.confirmChallenge(challenge.id, f.actor);
    expect(link).toEqual(
      expect.objectContaining({
        capturedIsApiKey: true,
        capturedApiKeyId: 'key',
        capturedScopes: ['read'],
      }),
    );
    expect(f.actor.scopes).toEqual(['admin', 'read']);
  });
  it('does not silently rebind a native account already associated with a different canonical user', async () => {
    const f = fixture();
    const challenge = await f.begin();
    f.prisma.botAccountLink.findFirst.mockResolvedValue({
      id: 'other-link',
      userId: 'other-user',
      revision: 1,
    });
    await expect(
      f.service.confirmChallenge(challenge.id, f.actor),
    ).rejects.toThrow('already linked');
    expect(f.prisma.botAccountLink.create).not.toHaveBeenCalled();
    expect(f.prisma.botAccountLink.update).not.toHaveBeenCalled();
  });
  it('reauthorizes after the private mapping await and denies canonical membership revocation before persistence', async () => {
    const f = fixture();
    const challenge = await f.begin();
    f.prisma.botAccountLink.findFirst.mockImplementation(async () => {
      f.prisma.member.findFirst.mockResolvedValue(null);
      return null;
    });
    await expect(
      f.service.confirmChallenge(challenge.id, f.actor),
    ).rejects.toThrow('Brand access denied');
    expect(f.prisma.botAccountLink.create).not.toHaveBeenCalled();
  });
  it('holds a confirmation when its original installation rotates before account confirmation', async () => {
    const f = fixture();
    const challenge = await f.begin();
    f.prisma.orgIntegration.findFirst.mockResolvedValue(null);
    await expect(
      f.service.confirmChallenge(challenge.id, f.actor),
    ).rejects.toThrow('challenge unavailable');
    expect(f.prisma.botAccountLink.create).not.toHaveBeenCalled();
  });
  it('fails closed if the one-time cache cannot persist a challenge', async () => {
    const f = fixture();
    f.cache.set.mockResolvedValue(false);
    await expect(f.begin()).rejects.toThrow('confirmation is unavailable');
  });
  it('lists only the current canonical account and tenant and rechecks after rows are read', async () => {
    const f = fixture();
    await f.service.list(f.actor);
    expect(f.prisma.botAccountLink.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org',
        userId: 'canonical-user',
        isDeleted: false,
      },
      orderBy: { verifiedAt: 'desc' },
    });
    f.prisma.botAccountLink.findMany.mockImplementation(async () => {
      f.prisma.member.findFirst.mockResolvedValue(null);
      return [];
    });
    await expect(f.service.list(f.actor)).rejects.toThrow(
      'Brand access denied',
    );
  });
  it('unlink revokes the original queued link revision without deleting its historical binding', async () => {
    const f = fixture();
    f.prisma.botAccountLink.findFirst.mockResolvedValue({
      id: 'link',
      revision: 3,
    });
    await f.service.unlink('link', f.actor);
    expect(f.prisma.botAccountLink.update).toHaveBeenCalledWith({
      where: {
        id: 'link',
        organizationId: 'org',
        userId: 'canonical-user',
        isDeleted: false,
        revision: 3,
      },
      data: { revokedAt: expect.any(Date), revision: { increment: 1 } },
    });
    f.prisma.botAccountLink.findFirst.mockResolvedValue(null);
    await expect(
      refreshWorkflowActor(
        f.db,
        f.policy,
        { ...f.actor, botAccountLinkId: 'link', botAccountLinkRevision: 3 },
        'org',
      ),
    ).rejects.toThrow('Brand access denied');
  });
});
