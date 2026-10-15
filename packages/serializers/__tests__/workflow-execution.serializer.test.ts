import { testId } from '@genfeedai/helpers/testing/test-id.helper';
import { WorkflowExecutionSerializer } from '@serializers/server/automation/workflow-execution.serializer';
import { describe, expect, it } from 'vitest';

const WORKFLOW_ID = testId('workflow');

type SerializedDocument = {
  data: {
    attributes: Record<string, unknown>;
    id: string;
    relationships?: Record<string, { data: unknown }>;
  };
  included?: Array<{
    attributes: Record<string, unknown>;
    id: string;
    type: string;
  }>;
};

function makeExecution(): Record<string, unknown> {
  return {
    createdAt: '2026-09-03T10:00:00.000Z',
    creditsUsed: 4,
    id: 'cmexec00000000000000000001',
    isDeleted: false,
    organizationId: 'cmorg000000000000000000001',
    status: 'FAILED',
    trigger: 'agent',
    updatedAt: '2026-09-03T10:00:05.000Z',
    userId: 'cmuser00000000000000000001',
    workflowId: WORKFLOW_ID,
  };
}

describe('WorkflowExecutionSerializer', () => {
  it('emits the hydrated workflow as a relationship with its label included', () => {
    const output = WorkflowExecutionSerializer.serialize({
      ...makeExecution(),
      workflow: {
        description: 'Generates an image from an agent tool call',
        id: WORKFLOW_ID,
        label: 'Agent Tool: generate',
      },
    }) as SerializedDocument;

    expect(output.data.attributes.workflowId).toBe(WORKFLOW_ID);
    expect(output.data.relationships?.workflow.data).toEqual({
      id: WORKFLOW_ID,
      type: 'workflow',
    });
    expect(output.included).toEqual([
      {
        attributes: {
          description: 'Generates an image from an agent tool call',
          label: 'Agent Tool: generate',
        },
        id: WORKFLOW_ID,
        type: 'workflow',
      },
    ]);
  });

  it('keeps the scalar workflowId when the relation is not hydrated', () => {
    const output = WorkflowExecutionSerializer.serialize(
      makeExecution(),
    ) as SerializedDocument;

    expect(output.data.attributes.workflowId).toBe(WORKFLOW_ID);
    expect(output.included ?? []).toEqual([]);
  });
  it.each(['inputValues', 'nodeResults', 'metadata', 'result'] as const)(
    'recursively removes only reserved server authorization proof from %s',
    (field) => {
      const source = {
        initiatingActor: { userId: 'private-actor', scopes: ['admin'] },
        initiatingActorKey: 'private-actor-proof',
        initiatingRequestKey: 'private-request-proof',
        publicCount: 0,
        publicFlag: false,
        publicNull: null,
        actor: { label: 'Public attribution' },
        items: [
          {
            citation: 'Source citation',
            nested: {
              initiatingActor: { apiKeyId: 'private-key' },
              text: 'Public result',
            },
          },
        ],
      };
      const output = WorkflowExecutionSerializer.serialize({
        ...makeExecution(),
        [field]: source,
      }) as SerializedDocument;
      expect(output.data.attributes[field]).toEqual({
        publicCount: 0,
        publicFlag: false,
        publicNull: null,
        actor: { label: 'Public attribution' },
        items: [
          { citation: 'Source citation', nested: { text: 'Public result' } },
        ],
      });
      expect(source.initiatingActor.userId).toBe('private-actor');
      expect(source.items[0].nested.initiatingActor.apiKeyId).toBe(
        'private-key',
      );
    },
  );

  it('preserves execution JSON scalars and nested arrays', () => {
    const output = WorkflowExecutionSerializer.serialize({
      ...makeExecution(),
      inputValues: 0,
      nodeResults: [['public', null, false]],
      metadata: null,
      result: 'Public result',
    }) as SerializedDocument;
    expect(output.data.attributes).toMatchObject({
      inputValues: 0,
      nodeResults: [['public', null, false]],
      metadata: null,
      result: 'Public result',
    });
  });

  it.each(['inputValues', 'nodeResults', 'metadata', 'result'] as const)(
    'preserves similarly named public proof labels and values while stripping only exact reserved keys in %s',
    (field) => {
      const source = {
        initiatingActorLabel: 'Public author label',
        initiatingActorKeyLabel: 'Public receipt label',
        initiatingRequestKeyLabel: 'Public request label',
        citation: {
          title: 'initiatingActor',
          url: 'https://example.test/initiatingRequestKey',
        },
        groups: [
          [
            {
              initiatingActor: { userId: 'private' },
              initiatingActorKey: 'private',
              initiatingRequestKey: 'private',
              value: 'initiatingActorKey',
            },
          ],
        ],
      };
      const output = WorkflowExecutionSerializer.serialize({
        ...makeExecution(),
        [field]: source,
      }) as SerializedDocument;
      expect(output.data.attributes[field]).toEqual({
        initiatingActorLabel: source.initiatingActorLabel,
        initiatingActorKeyLabel: source.initiatingActorKeyLabel,
        initiatingRequestKeyLabel: source.initiatingRequestKeyLabel,
        citation: source.citation,
        groups: [[{ value: 'initiatingActorKey' }]],
      });
      expect(source.groups[0][0].initiatingActor.userId).toBe('private');
    },
  );
});
