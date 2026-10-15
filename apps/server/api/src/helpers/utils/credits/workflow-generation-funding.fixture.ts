import { billableProfile } from '@api/helpers/utils/credits/model-billable-quote.fixture';
import { quoteSnapshotHash } from '@api/helpers/utils/credits/quote-snapshot.util';
import { workflowGenerationOperationId } from '@api/helpers/utils/credits/workflow-generation-evidence.util';
import type {
  WorkflowExecutionGenerationBilling,
  WorkflowGenerationDispatch,
  WorkflowGenerationNodeAllocation,
} from '@genfeedai/contracts/interfaces/billing';
import { quoteModelBillablePricing } from '@genfeedai/pricing';

/** Explicit test tariffs: video 5 credits and stitch 1 credit; never a production fallback. */
export function workflowFundingFixture(
  executionId = 'execution-a',
): WorkflowExecutionGenerationBilling {
  const allocations = [
    ['video', 'videoGen', 5],
    ['stitch', 'videoStitch', 1],
  ].map(([node, action, cost]): WorkflowGenerationNodeAllocation => {
    const nodeId = String(node);
    const actionId = String(action);
    const modelKey = `test/${nodeId}`;
    const provider = nodeId === 'video' ? 'replicate' : 'local';
    const quote = quoteModelBillablePricing(
      billableProfile({ key: modelKey, provider, cost: Number(cost) }),
      { modelKey, provider, requests: 1, outputs: 1 },
      1,
      '2026-09-30T00:00:00.000Z',
    );
    if (quote.status !== 'priced') throw new Error(quote.reason);
    const compiled: Omit<WorkflowGenerationDispatch, 'billableFingerprint'> = {
      contractVersion: 'test-v1',
      modelKey,
      provider,
      target: modelKey,
      credentialRoute: { kind: 'platform' },
      quantities: { requests: 1, outputs: 1 },
    };
    return {
      nodeId,
      actionId,
      operationId: workflowGenerationOperationId(executionId, nodeId, actionId),
      owner: 'workflow-execution',
      billingMode: 'credits',
      dispatch: {
        ...compiled,
        billableFingerprint: quoteSnapshotHash(compiled),
      },
      quote: quote.snapshot,
    };
  });
  const manifest = {
    executionId,
    organizationId: 'org-a',
    actorUserId: 'user-a',
    workflowVersionId: 'version-a',
    selectedNodeIds: ['video', 'stitch'],
    graphFingerprint: quoteSnapshotHash(['video', 'stitch']),
    allocations,
  };
  return {
    version: 1,
    state: 'funded',
    manifest,
    manifestHash: quoteSnapshotHash(manifest),
    holdAmount: '6',
    reservationId: `hold-${executionId}`,
    expiresAt: '2026-10-01T00:00:00.000Z',
    dispatchClosed: false,
    operations: allocations.map((allocation) => ({
      operationId: allocation.operationId,
      phase: 'unclaimed',
    })),
  };
}
