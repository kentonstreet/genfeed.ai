import type { BrandAccessActor } from '@api/authorization/brand-access/brand-access.service';
import type {
  ISourcePost,
  NativeSocialAction,
  SocialTimelineAccount,
} from '@genfeedai/contracts/interfaces';

export type TimelineScope = BrandAccessActor & {
  apiKeyId?: string;
  organizationId: string;
  brandId: string;
  userId: string;
};
export type TimelineCollectedPost = Omit<
  ISourcePost,
  | 'id'
  | 'organizationId'
  | 'brandId'
  | 'sourceId'
  | 'createdAt'
  | 'updatedAt'
  | 'isDeleted'
>;
export type TimelineCapability = Pick<
  SocialTimelineAccount,
  'kind' | 'actions' | 'message'
>;
export type NativeActionRequest = {
  action: NativeSocialAction;
  text?: string;
  externalId: string;
};
