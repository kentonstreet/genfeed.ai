import { modelBillableQuoteSnapshotSchema } from '@api/helpers/utils/credits/model-billable-quote.schema';
import { z } from 'zod';

const identity = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const dimensions = modelBillableQuoteSnapshotSchema.shape.quantities;
const dispatch = z.object({
  contractVersion: identity,
  provider: identity,
  modelKey: identity,
  target: identity,
  credentialRoute: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('platform') }),
    z.object({ kind: z.literal('byok'), credentialId: identity }),
  ]),
  quantities: dimensions.extend({
    requests: z.literal(1),
    outputs: z.literal(1),
  }),
  billableFingerprint: hash,
});

export const workflowGenerationNodeAllocationSchema = z
  .object({
    nodeId: identity,
    actionId: identity,
    operationId: hash,
    owner: z.literal('workflow-execution'),
    billingMode: z.enum(['credits', 'byok']),
    dispatch,
    quote: modelBillableQuoteSnapshotSchema.optional(),
  })
  .superRefine((allocation, context) => {
    const platform = allocation.billingMode === 'credits';
    if (platform !== (allocation.dispatch.credentialRoute.kind === 'platform'))
      context.addIssue({
        code: 'custom',
        message: 'Allocation credential and billing owner differ',
      });
    if (platform && !allocation.quote)
      context.addIssue({
        code: 'custom',
        message: 'Platform allocation requires authoritative frozen pricing',
      });
    if (!platform && allocation.quote)
      context.addIssue({
        code: 'custom',
        message: 'BYOK allocation cannot reserve platform funding',
      });
    if (
      allocation.quote &&
      (allocation.quote.quantities.outputs !== 1 ||
        allocation.quote.quantities.requests !== 1 ||
        allocation.quote.provider !== allocation.dispatch.provider ||
        allocation.quote.modelKey !== allocation.dispatch.modelKey)
    )
      context.addIssue({
        code: 'custom',
        message: 'Quote must match the exact compiled dispatch',
      });
  });

export const workflowGenerationManifestSchema = z
  .object({
    executionId: identity,
    organizationId: identity,
    actorUserId: identity,
    workflowVersionId: identity,
    selectedNodeIds: z.array(identity),
    graphFingerprint: hash,
    allocations: z.array(workflowGenerationNodeAllocationSchema),
  })
  .superRefine((manifest, context) => {
    for (const ids of [
      manifest.selectedNodeIds,
      manifest.allocations.map((allocation) => allocation.nodeId),
      manifest.allocations.map((allocation) => allocation.operationId),
    ])
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: 'custom',
          message: 'Manifest identities must be unique',
        });
    if (
      manifest.allocations.some(
        (allocation) => !manifest.selectedNodeIds.includes(allocation.nodeId),
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Allocation is outside the frozen selected graph',
      });
  });

const operation = { operationId: hash };
const intent = {
  ...operation,
  intentId: identity,
  observedAt: z.iso.datetime(),
};
const completion = dimensions.extend({
  completedOutputs: z.literal(1),
  successfulRequests: z.literal(1),
});
export const workflowGenerationOperationEvidenceSchema = z.discriminatedUnion(
  'phase',
  [
    z.object({ ...operation, phase: z.literal('unclaimed') }),
    z.object({ ...operation, phase: z.literal('claimed'), claimId: identity }),
    z.object({ ...intent, phase: z.literal('submission-intent') }),
    z.object({
      ...intent,
      phase: z.literal('accepted'),
      providerJobId: identity,
    }),
    z.object({
      ...intent,
      phase: z.literal('completed'),
      providerJobId: identity.optional(),
      proofId: identity,
      artifacts: z
        .array(
          z.object({
            ingredientId: identity,
            assetKey: identity,
            role: z.literal('primary'),
          }),
        )
        .length(1),
      completion,
    }),
    z.object({
      ...intent,
      phase: z.literal('failed'),
      providerJobId: identity.optional(),
      proofId: identity,
      kind: z.enum([
        'submission-rejected',
        'provider-terminal',
        'local-job-terminal',
      ]),
      provider: identity,
    }),
    z.object({
      ...operation,
      phase: z.literal('unsubmitted'),
      observedAt: z.iso.datetime(),
      reason: z.literal('dispatch-closed'),
    }),
  ],
);

export const workflowExecutionGenerationBillingSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(['preparing', 'funded']),
    manifest: workflowGenerationManifestSchema,
    manifestHash: hash,
    holdAmount: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/),
    reservationId: identity.nullable(),
    expiresAt: z.iso.datetime(),
    dispatchClosed: z.boolean(),
    operations: z.array(workflowGenerationOperationEvidenceSchema),
  })
  .superRefine((plan, context) => {
    const expected = new Set(
      plan.manifest.allocations.map((allocation) => allocation.operationId),
    );
    const observed = new Set(
      plan.operations.map((evidence) => evidence.operationId),
    );
    if (
      observed.size !== plan.operations.length ||
      observed.size !== expected.size ||
      [...observed].some((id) => !expected.has(id))
    )
      context.addIssue({
        code: 'custom',
        message: 'Evidence must cover each frozen operation exactly once',
      });
    if (
      !plan.dispatchClosed &&
      plan.operations.some((evidence) => evidence.phase === 'unsubmitted')
    )
      context.addIssue({
        code: 'custom',
        message: 'Unsubmitted proof requires dispatch closure',
      });
  });
