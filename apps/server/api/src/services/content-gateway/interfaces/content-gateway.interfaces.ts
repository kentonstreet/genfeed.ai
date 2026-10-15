import type { WorkflowInitiatingActor } from '@api/authorization/brand-access/workflow-actor.util';
import type { PostDocument } from '@api/collections/posts/post.schema';
import type { JsonApiCollectionResponse } from '@genfeedai/contracts/interfaces';

export type ContentSignalType =
  | 'cron'
  | 'trend_alert'
  | 'performance_threshold'
  | 'manual'
  | 'webhook';

export interface ContentSignal {
  initiatingActor?: WorkflowInitiatingActor;
  brandId: string;
  organizationId: string;
  payload?: Record<string, unknown>;
  type: ContentSignalType;
  userId?: string;
}

export interface ContentGatewayResult {
  executions: string[];
  posts: PostDocument[];
}

export interface ContentGatewayResponse {
  executions: string[];
  posts: JsonApiCollectionResponse;
}
