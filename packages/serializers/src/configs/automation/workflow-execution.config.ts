import { workflowExecutionAttributes } from '@serializers/attributes/automation/workflow-execution.attributes';
import { publicWorkflowExecutionValue } from '@serializers/helpers/workflow-authorization-proof.helper';
import {
  ORGANIZATION_MINIMAL_REL,
  USER_REL,
  WORKFLOW_MINIMAL_REL,
} from '@serializers/relationships';

export const workflowExecutionSerializerConfig = {
  attributes: workflowExecutionAttributes,
  attributeTransforms: {
    inputValues: (record: Record<string, unknown>) =>
      publicWorkflowExecutionValue(record.inputValues),
    nodeResults: (record: Record<string, unknown>) =>
      publicWorkflowExecutionValue(record.nodeResults),
    metadata: (record: Record<string, unknown>) =>
      publicWorkflowExecutionValue(record.metadata),
    result: (record: Record<string, unknown>) =>
      publicWorkflowExecutionValue(record.result),
  },
  organization: ORGANIZATION_MINIMAL_REL,
  type: 'workflow-execution',
  user: USER_REL,
  workflow: WORKFLOW_MINIMAL_REL,
};
