import { quoteSnapshotHash } from '@api/helpers/utils/credits/quote-snapshot.util';
import { workflowExecutionGenerationBillingSchema as fundingSchema } from '@api/helpers/utils/credits/workflow-generation-billing.schema';
import {
  applyWorkflowOperationEvidence,
  assertWorkflowFundingIdentity,
  closeWorkflowDispatch,
  parseWorkflowGenerationProviderEvidence,
} from '@api/helpers/utils/credits/workflow-generation-evidence.util';
import { workflowFundingFixture } from '@api/helpers/utils/credits/workflow-generation-funding.fixture';
import { calculateWorkflowGenerationSettlement } from '@api/helpers/utils/credits/workflow-generation-settlement.util';
import type {
  WorkflowExecutionGenerationBilling,
  WorkflowGenerationOperationEvidence,
} from '@genfeedai/contracts/interfaces/billing';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('@genfeedai/prisma');
const now = new Date('2026-09-30T00:01:00.000Z');
function submit(
  plan: WorkflowExecutionGenerationBilling,
  index = 0,
): WorkflowExecutionGenerationBilling {
  const operationId = plan.manifest.allocations[index].operationId;
  plan = applyWorkflowOperationEvidence(
    plan,
    { operationId, phase: 'claimed', claimId: 'claim-a' },
    now,
  );
  return applyWorkflowOperationEvidence(
    plan,
    {
      operationId,
      phase: 'submission-intent',
      intentId: operationId,
      observedAt: now.toISOString(),
    },
    now,
  );
}
function completed(
  plan: WorkflowExecutionGenerationBilling,
  index = 0,
): Extract<WorkflowGenerationOperationEvidence, { phase: 'completed' }> {
  const operationId = plan.manifest.allocations[index].operationId;
  return {
    operationId,
    phase: 'completed',
    intentId: operationId,
    proofId: `artifact-${index}`,
    observedAt: now.toISOString(),
    artifacts: [
      {
        ingredientId: `asset-${index}`,
        assetKey: `durable/video-${index}.mp4`,
        role: 'primary',
      },
    ],
    completion: { completedOutputs: 1, successfulRequests: 1 },
  };
}

describe('workflow immutable financial evidence', () => {
  it.each(['claimed', 'submission-intent'] as const)(
    'rejects %s evidence through the callback proof boundary',
    (phase) => {
      const operationId =
        workflowFundingFixture().manifest.allocations[0].operationId;
      expect(() =>
        parseWorkflowGenerationProviderEvidence({
          operationId,
          phase,
          claimId: 'stale-claim',
          intentId: operationId,
          observedAt: now.toISOString(),
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            detail: expect.stringContaining(
              'cannot authorize provider dispatch',
            ),
          }),
        }),
      );
    },
  );

  it('uses stable retry identity and isolates a fresh execution', () => {
    const first = workflowFundingFixture();
    expect(workflowFundingFixture().manifestHash).toBe(first.manifestHash);
    expect(
      workflowFundingFixture('execution-b').manifest.allocations[0].operationId,
    ).not.toBe(first.manifest.allocations[0].operationId);
  });
  it('reserves test video 5 plus stitch 1, settles completed video 5 and releases the failed stitch share', () => {
    let plan = submit(submit(workflowFundingFixture()), 1);
    plan = applyWorkflowOperationEvidence(plan, completed(plan), now);
    const operationId = plan.manifest.allocations[1].operationId;
    plan = applyWorkflowOperationEvidence(
      plan,
      {
        operationId,
        phase: 'failed',
        intentId: operationId,
        proofId: 'confirmed-job-failure',
        observedAt: now.toISOString(),
        kind: 'local-job-terminal',
        provider: 'local',
      },
      now,
    );
    expect(plan.holdAmount).toBe('6');
    expect(
      calculateWorkflowGenerationSettlement(closeWorkflowDispatch(plan, now)),
    ).toMatchObject({
      actualAmount: 5,
      operations: [
        { credits: 5, phase: 'completed' },
        { credits: 0, phase: 'failed' },
      ],
    });
  });
  it.each(['unclaimed', 'claimed'] as const)(
    'closure proves only %s work unsubmitted',
    (phase) => {
      let plan = workflowFundingFixture();
      if (phase === 'claimed')
        plan = applyWorkflowOperationEvidence(
          plan,
          {
            operationId: plan.manifest.allocations[0].operationId,
            phase,
            claimId: 'claim-a',
          },
          now,
        );
      plan = closeWorkflowDispatch(plan, now);
      expect(
        plan.operations.every((evidence) => evidence.phase === 'unsubmitted'),
      ).toBe(true);
      expect(calculateWorkflowGenerationSettlement(plan)?.actualAmount).toBe(0);
    },
  );
  it('retains an ambiguous submission after closure and settles an actual late output', () => {
    let plan = closeWorkflowDispatch(submit(workflowFundingFixture()), now);
    expect(plan.operations[0].phase).toBe('submission-intent');
    expect(calculateWorkflowGenerationSettlement(plan)).toBeNull();
    plan = applyWorkflowOperationEvidence(
      plan,
      completed(plan),
      new Date('2026-10-02'),
    );
    expect(calculateWorkflowGenerationSettlement(plan)?.actualAmount).toBe(5);
  });
  it('denies intent replay after closure even for the identical operation', () => {
    const plan = closeWorkflowDispatch(submit(workflowFundingFixture()), now);
    expect(() =>
      applyWorkflowOperationEvidence(plan, plan.operations[0], now),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('admission is closed'),
        }),
      }),
    );
  });
  it('denies a provider intent after a claimed-but-unsubmitted node loses the closure race', () => {
    const initial = workflowFundingFixture();
    const operationId = initial.manifest.allocations[0].operationId;
    const claimed = applyWorkflowOperationEvidence(
      initial,
      { operationId, phase: 'claimed', claimId: 'claim-a' },
      now,
    );
    const closed = closeWorkflowDispatch(claimed, now);
    expect(() =>
      applyWorkflowOperationEvidence(
        closed,
        {
          operationId,
          phase: 'submission-intent',
          intentId: operationId,
          observedAt: now.toISOString(),
        },
        now,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('admission is closed'),
        }),
      }),
    );
  });
  it('denies admission after expiry and while preparation is unfinished', () => {
    const plan = workflowFundingFixture();
    const claim: WorkflowGenerationOperationEvidence = {
      operationId: plan.manifest.allocations[0].operationId,
      phase: 'claimed',
      claimId: 'claim-a',
    };
    expect(() =>
      applyWorkflowOperationEvidence(plan, claim, new Date('2026-10-02')),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('admission is closed'),
        }),
      }),
    );
    expect(() =>
      applyWorkflowOperationEvidence(
        { ...plan, state: 'preparing' },
        claim,
        now,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('admission is closed'),
        }),
      }),
    );
  });
  it('replays identical completion but rejects conflicting failure or artifact proof', () => {
    let plan = submit(workflowFundingFixture());
    const proof = completed(plan);
    plan = applyWorkflowOperationEvidence(plan, proof, now);
    expect(
      applyWorkflowOperationEvidence(
        plan,
        { ...proof, observedAt: '2026-10-02T00:00:00.000Z' },
        now,
      ),
    ).toBe(plan);
    if (proof.phase !== 'completed') throw new Error('Invalid fixture');
    expect(() =>
      applyWorkflowOperationEvidence(
        plan,
        {
          ...proof,
          artifacts: [{ ...proof.artifacts[0], assetKey: 'different.mp4' }],
        },
        now,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('Conflicting terminal'),
        }),
      }),
    );
    expect(() =>
      applyWorkflowOperationEvidence(
        plan,
        {
          operationId: proof.operationId,
          phase: 'failed',
          intentId: proof.intentId,
          provider: 'replicate',
          proofId: 'failure',
          kind: 'provider-terminal',
          observedAt: now.toISOString(),
        },
        now,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('Conflicting terminal'),
        }),
      }),
    );
  });
  it('does not permit a generic projection to create completion without provider intent', () => {
    const plan = workflowFundingFixture();
    expect(() =>
      applyWorkflowOperationEvidence(plan, completed(plan), now),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('existing provider intent'),
        }),
      }),
    );
  });
  it('requires a completed artifact and successful request cardinality', () => {
    const plan = submit(workflowFundingFixture());
    const proof = completed(plan);
    if (proof.phase !== 'completed') throw new Error('Invalid fixture');
    expect(() =>
      applyWorkflowOperationEvidence(plan, { ...proof, artifacts: [] }, now),
    ).toThrow();
    expect(() =>
      applyWorkflowOperationEvidence(
        plan,
        {
          ...proof,
          completion: { completedOutputs: 0, successfulRequests: 1 },
        },
        now,
      ),
    ).toThrow();
  });
  it('rejects changed dispatch targets, quote selectors and provider identities', () => {
    let plan = submit(workflowFundingFixture());
    const mutated = structuredClone(plan);
    mutated.manifest.allocations[0].dispatch.target = 'another/endpoint';
    expect(() => assertWorkflowFundingIdentity(mutated)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('manifest changed'),
        }),
      }),
    );
    expect(() =>
      applyWorkflowOperationEvidence(
        plan,
        {
          operationId: plan.manifest.allocations[0].operationId,
          phase: 'failed',
          intentId: plan.manifest.allocations[0].operationId,
          proofId: 'foreign-provider',
          observedAt: now.toISOString(),
          kind: 'provider-terminal',
          provider: 'heygen',
        },
        now,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining(
            'differs from its submitted operation',
          ),
        }),
      }),
    );
    const operationId = plan.manifest.allocations[0].operationId;
    plan = applyWorkflowOperationEvidence(
      plan,
      {
        operationId,
        phase: 'accepted',
        intentId: operationId,
        providerJobId: 'job-a',
        observedAt: now.toISOString(),
      },
      now,
    );
    expect(() =>
      applyWorkflowOperationEvidence(
        plan,
        {
          ...completed(plan),
          providerJobId: 'job-b',
        },
        now,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('provider identity changed'),
        }),
      }),
    );
  });
  it('requires actual duration for a frozen per-second tariff', () => {
    let initial = workflowFundingFixture();
    const quote = initial.manifest.allocations[0].quote;
    if (!quote) throw new Error('Invalid fixture');
    quote.pricingProfile.pricingType = 'per-second';
    quote.quantities.duration = 1;
    initial.manifest.allocations[0].dispatch.quantities.duration = 1;
    const dispatch = initial.manifest.allocations[0].dispatch;
    dispatch.billableFingerprint = quoteSnapshotHash({
      ...dispatch,
      billableFingerprint: undefined,
    });
    initial.manifestHash = quoteSnapshotHash(initial.manifest);
    initial = submit(initial);
    expect(() =>
      applyWorkflowOperationEvidence(initial, completed(initial), now),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          detail: expect.stringContaining('actual output duration'),
        }),
      }),
    );
  });
  it('rejects missing explicit output counts and incomplete operation coverage', () => {
    const plan = workflowFundingFixture();
    const invalid = structuredClone(plan);
    if (!invalid.manifest.allocations[0].quote)
      throw new Error('Invalid fixture');
    delete invalid.manifest.allocations[0].quote.quantities.outputs;
    expect(fundingSchema.safeParse(invalid).success).toBe(false);
    expect(fundingSchema.safeParse({ ...plan, operations: [] }).success).toBe(
      false,
    );
  });
});
