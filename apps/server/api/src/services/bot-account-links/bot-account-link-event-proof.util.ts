import { createHash } from 'node:crypto';
import type { CredentialCryptoService } from '@api/collections/credentials/services/credential-crypto.service';
import type { CacheService } from '@api/services/cache/cache.service';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import {
  type BotAccountLinkEvent,
  type BotAccountLinkProofRequest,
  parseBotAccountLinkEvent,
  verifyBotAccountLinkRequest,
} from '@genfeedai/integrations';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

export interface VerifiedBotInstallationEvent {
  event: BotAccountLinkEvent;
  installationUpdatedAt: string;
}

export interface BotInstallationRequestProof {
  method: BotAccountLinkProofRequest['method'];
  path: string;
  body: unknown;
  event: unknown;
  nonce: string;
  timestamp: number;
  signature: string;
}

/** Shared admin transport is not identity: also require the actual installation proof. */
export async function verifyBotInstallationEvent(
  prisma: PrismaService,
  credentialCrypto: CredentialCryptoService,
  cache: CacheService,
  organizationId: string,
  request: BotInstallationRequestProof,
  requirePrivate: boolean,
): Promise<VerifiedBotInstallationEvent> {
  const deny = (): never => {
    throw new ForbiddenException('Bot account verification failed');
  };
  let event: BotAccountLinkEvent;
  try {
    event = parseBotAccountLinkEvent(request.event);
  } catch {
    return deny();
  }
  if (
    event.organizationId !== organizationId ||
    (requirePrivate && !event.isPrivate)
  )
    deny();
  const where = {
    id: event.integrationId,
    organizationId,
    platform: event.platform,
    status: 'ACTIVE' as const,
    isDeleted: false,
    organization: { isDeleted: false },
  };
  const installation = await prisma.orgIntegration.findFirst({
    where,
    select: { encryptedToken: true, updatedAt: true },
  });
  if (!installation) deny();
  let verified = false;
  try {
    verified = await verifyBotAccountLinkRequest(
      credentialCrypto.decrypt(installation.encryptedToken),
      {
        method: request.method,
        path: request.path,
        body: request.body,
        event,
        nonce: request.nonce,
        timestamp: request.timestamp,
      },
      request.signature,
    );
  } catch {
    return deny();
  }
  if (!verified) deny();
  const nonceDigest = createHash('sha256').update(request.nonce).digest('hex');
  // Keep the successful SET NX until the proof window expires; never release a replay fence.
  if (
    !(await cache.acquireLock(
      `bot-account-proof:${organizationId}:${event.integrationId}:${nonceDigest}`,
      360,
    ))
  ) {
    throw new ServiceUnavailableException(
      'Bot account proof was already used or verification is unavailable',
    );
  }
  const active = await prisma.orgIntegration.findFirst({
    where: { ...where, updatedAt: installation.updatedAt },
    select: { id: true },
  });
  if (!active) deny();
  return { event, installationUpdatedAt: installation.updatedAt.toISOString() };
}
