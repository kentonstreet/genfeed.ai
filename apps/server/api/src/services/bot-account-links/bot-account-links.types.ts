import type { WorkflowInitiatingActor } from '@api/authorization/brand-access/workflow-actor.util';
import type { BotAccountLinkEvent } from '@genfeedai/integrations';

export interface BotAccountLinkChallengeState {
  event: BotAccountLinkEvent;
  expiresAt: number;
  installationUpdatedAt: string;
}
export interface VerifiedBotInvocation {
  event: BotAccountLinkEvent;
  initiatingActor: WorkflowInitiatingActor;
}
