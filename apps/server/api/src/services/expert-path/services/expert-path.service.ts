import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  denyWorkflowActor,
  refreshWorkflowActor,
  type WorkflowInitiatingActor,
} from '@api/authorization/brand-access/workflow-actor.util';
import { HarnessProfilesService } from '@api/collections/harness-profiles/services/harness-profiles.service';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import { scopedWhere } from '@api/index';
import { ExpertCorpusService } from '@api/services/expert-path/services/expert-corpus.service';
import { ExpertFirstSystemService } from '@api/services/expert-path/services/expert-first-system.service';
import { ExpertPositioningService } from '@api/services/expert-path/services/expert-positioning.service';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { isCloudDeployment } from '@genfeedai/config';
import { OrganizationCategory } from '@genfeedai/contracts';
import {
  EXPERT_POSITIONING_FIELD_KEYS,
  isPublishApprovalRequired,
} from '@genfeedai/contracts/constants';
import type {
  IBrandAgentAutoPublish,
  IExpertPathStatus,
} from '@genfeedai/contracts/interfaces';
import { Injectable } from '@nestjs/common';

function readAutoPublish(agentConfig: unknown): IBrandAgentAutoPublish {
  const config =
    agentConfig &&
    typeof agentConfig === 'object' &&
    !Array.isArray(agentConfig)
      ? (agentConfig as { autoPublish?: unknown })
      : {};
  const autoPublish = config.autoPublish;
  return autoPublish &&
    typeof autoPublish === 'object' &&
    !Array.isArray(autoPublish)
    ? (autoPublish as IBrandAgentAutoPublish)
    : {};
}

/**
 * Aggregated Expert Path state for a brand. Onboarding, the skipped-step
 * workspace tasks, and Settings all read this one view.
 */
@Injectable()
export class ExpertPathService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expertCorpusService: ExpertCorpusService,
    private readonly expertFirstSystemService: ExpertFirstSystemService,
    private readonly expertPositioningService: ExpertPositioningService,
    private readonly harnessProfilesService: HarnessProfilesService,
    private readonly brandAccess: BrandAccessService,
  ) {}

  async getStatus(
    organizationId: string,
    brandId: string,
    initiatingActor?: WorkflowInitiatingActor,
  ): Promise<IExpertPathStatus> {
    const admit = async () => {
      if (!initiatingActor) {
        if (isCloudDeployment()) denyWorkflowActor();
        return;
      }
      const actor = await refreshWorkflowActor(
        this.prisma,
        this.brandAccess,
        initiatingActor,
        organizationId,
      );
      await this.brandAccess.assert(actor, brandId);
    };
    const read = async <T>(work: () => Promise<T>): Promise<T> => {
      await admit();
      const value = await work();
      await admit();
      return value;
    };
    await admit();
    const [organization, brand] = await Promise.all([
      read(() =>
        this.prisma.organization.findFirst({
          select: { accountType: true },
          where: { id: organizationId, isDeleted: false },
        }),
      ),
      read(() =>
        this.prisma.brand.findFirst({
          select: { agentConfig: true, id: true },
          where: scopedWhere(organizationId, { id: brandId }),
        }),
      ),
    ]);
    if (!brand) {
      throw new NotFoundException('Brand', brandId);
    }

    const [answers, profile, corpus, firstSystem, readiness] =
      await Promise.all([
        read(() =>
          this.expertPositioningService.readAnswers(organizationId, brandId),
        ),
        read(() =>
          this.harnessProfilesService.getActiveForBrand(
            organizationId,
            brandId,
          ),
        ),
        read(() => this.expertCorpusService.summarize(organizationId, brandId)),
        read(() =>
          this.expertFirstSystemService.readRecord(
            organizationId,
            brandId,
            initiatingActor,
          ),
        ),
        read(() =>
          this.expertFirstSystemService.getReadiness(
            organizationId,
            brandId,
            initiatingActor,
          ),
        ),
      ]);

    await admit();
    return {
      brandId,
      corpus: {
        isComplete: corpus.readySourceIds.length > 0,
        readySourceCount: corpus.readySourceIds.length,
        sourceCount: corpus.sourceCount,
      },
      firstSystem: {
        ...firstSystem,
        readiness,
      },
      isExpert: organization?.accountType === OrganizationCategory.EXPERT,
      positioning: {
        answeredCount: Object.keys(answers).length,
        isComplete: Boolean(profile?.positioning),
        totalCount: EXPERT_POSITIONING_FIELD_KEYS.length,
        ...(profile?.positioning
          ? { harnessProfileId: profile.id, score: profile.positioning }
          : {}),
      },
      publishApproval: {
        isRequired: isPublishApprovalRequired(
          readAutoPublish(brand.agentConfig),
        ),
      },
    };
  }
}
