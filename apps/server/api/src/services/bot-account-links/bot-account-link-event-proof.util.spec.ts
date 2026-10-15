import type { CredentialCryptoService } from '@api/collections/credentials/services/credential-crypto.service';
import {
  type BotInstallationRequestProof,
  verifyBotInstallationEvent,
} from '@api/services/bot-account-links/bot-account-link-event-proof.util';
import type { CacheService } from '@api/services/cache/cache.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { signBotAccountLinkRequest } from '@genfeedai/integrations';
import { describe, expect, it, vi } from 'vitest';

async function fixture() {
  const event = {
    integrationId: 'installation',
    organizationId: 'org',
    platform: 'SLACK' as const,
    remoteUserId: 'slack-user',
    channelId: 'dm',
    sourceEventId: 'sdk-event',
    isPrivate: true,
  };
  const request = {
    method: 'POST' as const,
    path: '/v1/internal/orgs/org/bot-links/challenges',
    event,
    body: { event },
    nonce: 'random-proof-nonce-123456',
    timestamp: Date.now(),
  };
  const proof: BotInstallationRequestProof = {
    ...request,
    signature: await signBotAccountLinkRequest('installation-secret', request),
  };
  const updatedAt = new Date('2026-10-09T00:00:00Z');
  const prisma = {
    orgIntegration: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({
          encryptedToken: 'encrypted-secret',
          updatedAt,
        })
        .mockResolvedValue({ id: 'installation' }),
    },
  };
  const crypto = { decrypt: vi.fn().mockReturnValue('installation-secret') };
  const cache = { acquireLock: vi.fn().mockResolvedValue(true) };
  const verify = (value = proof, privateOnly = true) =>
    verifyBotInstallationEvent(
      prisma as unknown as PrismaService,
      crypto as unknown as CredentialCryptoService,
      cache as unknown as CacheService,
      'org',
      value,
      privateOnly,
    );
  return { event, proof, prisma, crypto, cache, updatedAt, verify };
}
describe('installation-bound native bot sender proof', () => {
  it('accepts the real installation HMAC with a single-use fence and active installation recheck', async () => {
    const f = await fixture();
    await expect(f.verify()).resolves.toEqual({
      event: f.event,
      installationUpdatedAt: f.updatedAt.toISOString(),
    });
    expect(f.prisma.orgIntegration.findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'installation',
        organizationId: 'org',
        platform: 'SLACK',
        status: 'ACTIVE',
        isDeleted: false,
        organization: { isDeleted: false },
      },
      select: { encryptedToken: true, updatedAt: true },
    });
    expect(f.prisma.orgIntegration.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'installation',
        organizationId: 'org',
        platform: 'SLACK',
        status: 'ACTIVE',
        isDeleted: false,
        organization: { isDeleted: false },
        updatedAt: f.updatedAt,
      },
      select: { id: true },
    });
    expect(f.cache.acquireLock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^bot-account-proof:org:installation:[a-f0-9]{64}$/,
      ),
      360,
    );
  });
  it.each([
    'foreign-org',
    'public-channel',
    'tampered-sender',
    'tampered-body',
    'expired',
  ])(
    'rejects %s before consuming a nonce or returning a principal',
    async (kind) => {
      const f = await fixture();
      const proof = { ...f.proof, event: { ...f.event } };
      if (kind === 'foreign-org') proof.event.organizationId = 'other';
      if (kind === 'public-channel') proof.event.isPrivate = false;
      if (kind === 'tampered-sender') proof.event.remoteUserId = 'other';
      if (kind === 'tampered-body')
        proof.body = { userId: 'forged-canonical-user' };
      if (kind === 'expired') proof.timestamp -= 360_000;
      await expect(f.verify(proof)).rejects.toThrow(
        'Bot account verification failed',
      );
      expect(f.cache.acquireLock).not.toHaveBeenCalled();
    },
  );
  it('rejects installation revocation or rotation during proof verification', async () => {
    const f = await fixture();
    f.prisma.orgIntegration.findFirst.mockResolvedValue(null);
    await expect(f.verify()).rejects.toThrow('Bot account verification failed');
    expect(f.cache.acquireLock).toHaveBeenCalledTimes(1);
  });
  it('fails closed on nonce replay or unavailable cache without returning the sender', async () => {
    const f = await fixture();
    f.cache.acquireLock.mockResolvedValue(false);
    await expect(f.verify()).rejects.toThrow(
      'already used or verification is unavailable',
    );
    expect(f.prisma.orgIntegration.findFirst).toHaveBeenCalledTimes(1);
  });
});
