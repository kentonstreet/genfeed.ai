import { createHash, randomBytes } from 'node:crypto';
import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  captureWorkflowActor,
  denyWorkflowActor,
  refreshWorkflowActor,
  type WorkflowInitiatingActor,
} from '@api/authorization/brand-access/workflow-actor.util';
import { CredentialCryptoService } from '@api/collections/credentials/services/credential-crypto.service';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import {
  type BotInstallationRequestProof,
  verifyBotInstallationEvent,
} from '@api/services/bot-account-links/bot-account-link-event-proof.util';
import type {
  BotAccountLinkChallengeState,
  VerifiedBotInvocation,
} from '@api/services/bot-account-links/bot-account-links.types';
import { CacheService } from '@api/services/cache/cache.service';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { ConfigService } from '@libs/config/config.service';
import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

const CHALLENGE_TTL_SECONDS = 300;
function challengeKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id))
    throw new NotFoundException('Bot link challenge unavailable');
  return `bot-account-link:challenge:${createHash('sha256').update(id).digest('hex')}`;
}

/** Maps verified installation senders to real account confirmations; never grants a role. */
@Injectable()
export class BotAccountLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: BrandAccessService,
    private readonly cache: CacheService,
    private readonly crypto: CredentialCryptoService,
    private readonly config: ConfigService,
  ) {}

  async beginChallenge(
    organizationId: string,
    proof: BotInstallationRequestProof,
  ) {
    const verified = await verifyBotInstallationEvent(
      this.prisma,
      this.crypto,
      this.cache,
      organizationId,
      proof,
      true,
    );
    const event = verified.event;
    const organization = await this.prisma.organization.findFirst({
      where: { id: organizationId, isDeleted: false },
      select: { slug: true },
    });
    if (!organization?.slug) denyWorkflowActor();
    const appUrl = this.config.get('GENFEEDAI_APP_URL');
    if (!appUrl)
      throw new ServiceUnavailableException(
        'Account confirmation is unavailable',
      );
    const id = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + CHALLENGE_TTL_SECONDS * 1000;
    if (
      !(await this.cache.set(
        challengeKey(id),
        {
          event,
          expiresAt,
          installationUpdatedAt: verified.installationUpdatedAt,
        } satisfies BotAccountLinkChallengeState,
        { ttl: CHALLENGE_TTL_SECONDS },
      ))
    ) {
      throw new ServiceUnavailableException(
        'Account confirmation is unavailable',
      );
    }
    const url = new URL(
      `/${encodeURIComponent(organization.slug)}/~/settings/account/bot-links`,
      appUrl,
    );
    url.searchParams.set('challenge', id);
    return {
      id,
      expiresAt: new Date(expiresAt).toISOString(),
      confirmationUrl: url.toString(),
    };
  }

  async previewChallenge(id: string, capturedActor: WorkflowInitiatingActor) {
    const actor = await refreshWorkflowActor(
      this.prisma,
      this.policy,
      capturedActor,
      capturedActor.organizationId,
    );
    const state = await this.requireChallenge(
      await this.cache.get<BotAccountLinkChallengeState>(challengeKey(id)),
      actor.organizationId,
    );
    await refreshWorkflowActor(
      this.prisma,
      this.policy,
      capturedActor,
      actor.organizationId,
    );
    return {
      id,
      integrationId: state.event.integrationId,
      platform: state.event.platform,
      remoteUserId: state.event.remoteUserId,
      expiresAt: new Date(state.expiresAt).toISOString(),
    };
  }

  async confirmChallenge(id: string, capturedActor: WorkflowInitiatingActor) {
    const actor = await refreshWorkflowActor(
      this.prisma,
      this.policy,
      capturedActor,
      capturedActor.organizationId,
    );
    // GETDEL is the one-time gate: no second account can consume the same sender challenge.
    const state = await this.requireChallenge(
      await this.cache.getdel<BotAccountLinkChallengeState>(challengeKey(id)),
      actor.organizationId,
    );
    const bindingKey = createHash('sha256')
      .update(
        JSON.stringify([
          actor.organizationId,
          state.event.integrationId,
          state.event.platform,
          state.event.remoteUserId,
        ]),
      )
      .digest('hex');
    if (
      !(await this.cache.acquireLock(
        `bot-account-link:binding:${bindingKey}`,
        30,
      ))
    ) {
      throw new ConflictException(
        'Account confirmation is already in progress',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await refreshWorkflowActor(
        tx,
        this.policy,
        actor,
        actor.organizationId,
      );
      const installation = await tx.orgIntegration.findFirst({
        where: {
          id: state.event.integrationId,
          organizationId: current.organizationId,
          platform: state.event.platform,
          status: 'ACTIVE',
          isDeleted: false,
          updatedAt: new Date(state.installationUpdatedAt),
          organization: { isDeleted: false },
        },
        select: { id: true },
      });
      if (!installation) denyWorkflowActor();
      const existing = await tx.botAccountLink.findFirst({
        where: {
          organizationId: current.organizationId,
          integrationId: state.event.integrationId,
          platform: state.event.platform,
          remoteUserId: state.event.remoteUserId,
          isDeleted: false,
        },
        select: { id: true, userId: true, revision: true },
      });
      if (existing && existing.userId !== current.userId) {
        throw new ConflictException(
          'This bot account is already linked to another account',
        );
      }
      const fresh = await refreshWorkflowActor(
        tx,
        this.policy,
        actor,
        actor.organizationId,
      );
      const stillActive = await tx.orgIntegration.findFirst({
        where: {
          id: state.event.integrationId,
          organizationId: fresh.organizationId,
          platform: state.event.platform,
          status: 'ACTIVE',
          isDeleted: false,
          updatedAt: new Date(state.installationUpdatedAt),
          organization: { isDeleted: false },
        },
        select: { id: true },
      });
      if (!stillActive) denyWorkflowActor();
      const data = {
        capturedIsApiKey: fresh.isApiKey,
        capturedApiKeyId: fresh.apiKeyId ?? null,
        capturedScopes: fresh.scopes,
        verifiedAt: new Date(),
        revokedAt: null,
        isDeleted: false,
      };
      const link = existing
        ? await tx.botAccountLink.update({
            where: {
              id: existing.id,
              organizationId: fresh.organizationId,
              userId: fresh.userId,
              revision: existing.revision,
            },
            data: { ...data, revision: { increment: 1 } },
          })
        : await tx.botAccountLink.create({
            data: {
              ...data,
              organizationId: fresh.organizationId,
              userId: fresh.userId,
              integrationId: state.event.integrationId,
              platform: state.event.platform,
              remoteUserId: state.event.remoteUserId,
            },
          });
      await refreshWorkflowActor(tx, this.policy, actor, actor.organizationId);
      const committedInstallation = await tx.orgIntegration.findFirst({
        where: {
          id: state.event.integrationId,
          organizationId: actor.organizationId,
          platform: state.event.platform,
          status: 'ACTIVE',
          isDeleted: false,
          updatedAt: new Date(state.installationUpdatedAt),
          organization: { isDeleted: false },
        },
        select: { id: true },
      });
      if (!committedInstallation) denyWorkflowActor();
      return link;
    });
  }

  async list(capturedActor: WorkflowInitiatingActor) {
    const actor = await refreshWorkflowActor(
      this.prisma,
      this.policy,
      capturedActor,
      capturedActor.organizationId,
    );
    const links = await this.prisma.botAccountLink.findMany({
      where: {
        organizationId: actor.organizationId,
        userId: actor.userId,
        isDeleted: false,
      },
      orderBy: { verifiedAt: 'desc' },
    });
    await refreshWorkflowActor(
      this.prisma,
      this.policy,
      capturedActor,
      actor.organizationId,
    );
    return links;
  }

  async unlink(
    id: string,
    capturedActor: WorkflowInitiatingActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const actor = await refreshWorkflowActor(
        tx,
        this.policy,
        capturedActor,
        capturedActor.organizationId,
      );
      const link = await tx.botAccountLink.findFirst({
        where: {
          id,
          organizationId: actor.organizationId,
          userId: actor.userId,
          isDeleted: false,
        },
        select: { id: true, revision: true },
      });
      if (!link) throw new NotFoundException('Bot account link unavailable');
      await refreshWorkflowActor(
        tx,
        this.policy,
        capturedActor,
        actor.organizationId,
      );
      await tx.botAccountLink.update({
        where: {
          id: link.id,
          organizationId: actor.organizationId,
          userId: actor.userId,
          isDeleted: false,
          revision: link.revision,
        },
        data: { revokedAt: new Date(), revision: { increment: 1 } },
      });
    });
  }

  async resolveInvocation(
    organizationId: string,
    proof: BotInstallationRequestProof,
  ): Promise<VerifiedBotInvocation> {
    const { event } = await verifyBotInstallationEvent(
      this.prisma,
      this.crypto,
      this.cache,
      organizationId,
      proof,
      false,
    );
    const link = await this.prisma.botAccountLink.findFirst({
      where: {
        organizationId,
        integrationId: event.integrationId,
        platform: event.platform,
        remoteUserId: event.remoteUserId,
        isDeleted: false,
        revokedAt: null,
      },
    });
    if (!link)
      throw new NotFoundException('Link your Genfeed account to use this bot');
    const capturedActor = captureWorkflowActor({
      organizationId,
      userId: link.userId,
      isApiKey: link.capturedIsApiKey,
      ...(link.capturedApiKeyId ? { apiKeyId: link.capturedApiKeyId } : {}),
      scopes: link.capturedScopes,
      botAccountLinkId: link.id,
      botAccountLinkRevision: link.revision,
    });
    const initiatingActor = await refreshWorkflowActor(
      this.prisma,
      this.policy,
      capturedActor,
      organizationId,
    );
    return { event, initiatingActor };
  }

  private async requireChallenge(
    state: BotAccountLinkChallengeState | null,
    organizationId: string,
  ): Promise<BotAccountLinkChallengeState> {
    if (
      !state ||
      !Number.isFinite(state.expiresAt) ||
      state.expiresAt <= Date.now() ||
      !state.event ||
      state.event.organizationId !== organizationId ||
      !state.event.isPrivate ||
      !Number.isFinite(Date.parse(state.installationUpdatedAt))
    ) {
      throw new NotFoundException('Bot link challenge unavailable');
    }
    const active = await this.prisma.orgIntegration.findFirst({
      where: {
        id: state.event.integrationId,
        organizationId,
        platform: state.event.platform,
        status: 'ACTIVE',
        isDeleted: false,
        updatedAt: new Date(state.installationUpdatedAt),
        organization: { isDeleted: false },
      },
      select: { id: true },
    });
    if (!active) throw new NotFoundException('Bot link challenge unavailable');
    return state;
  }
}
