import { createEntityAttributes } from '@genfeedai/helpers';
export const botAccountLinkAttributes = createEntityAttributes([
  'confirmationUrl',
  'expiresAt',
  'integrationId',
  'platform',
  'remoteUserId',
  'revision',
  'verifiedAt',
  'revokedAt',
]);
