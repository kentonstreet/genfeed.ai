import type { IntegrationPlatform } from '@genfeedai/contracts/enums/integration.enum';
/** Account association metadata. Captured authorization proof is never public. */
export interface IBotAccountLink {
  id: string;
  integrationId: string;
  platform: IntegrationPlatform;
  remoteUserId: string;
  revision: number;
  verifiedAt: string;
  revokedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface IBotAccountLinkChallenge {
  id: string;
  confirmationUrl: string;
  expiresAt: string;
}
export interface IBotAccountLinkChallengePreview {
  id: string;
  integrationId: string;
  platform: IntegrationPlatform;
  remoteUserId: string;
  expiresAt: string;
}
