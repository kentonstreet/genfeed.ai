import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkflowInitiatingActor } from '@api/authorization/brand-access/workflow-actor.util';
import type { Prisma } from '@genfeedai/prisma';
import { ForbiddenException } from '@nestjs/common';

/** Only an authenticated persisted-run adapter creates these executable closures. */
export interface WorkflowExecutionReadContext {
  readonly executionId: string;
  readonly organizationId: string;
  readonly initiatingActor: WorkflowInitiatingActor;
  readonly admit: (transaction?: Prisma.TransactionClient) => Promise<void>;
  readonly recordBrand: (
    brandId: string,
    transaction?: Prisma.TransactionClient,
  ) => Promise<void>;
  readonly markUnproven: (
    transaction?: Prisma.TransactionClient,
  ) => Promise<void>;
}
const storage = new AsyncLocalStorage<WorkflowExecutionReadContext>();
export function runWithWorkflowExecutionReadScope<T>(
  scope: WorkflowExecutionReadContext,
  work: () => T,
): T {
  return storage.run(scope, work);
}
export function currentWorkflowExecutionReadScope():
  | WorkflowExecutionReadContext
  | undefined {
  return storage.getStore();
}
export async function recordWorkflowExecutionBrand(
  organizationId: string,
  brandId: string,
  transaction?: Prisma.TransactionClient,
): Promise<void> {
  const scope = storage.getStore();
  if (!scope) return;
  if (scope.organizationId !== organizationId)
    throw new ForbiddenException('Brand access denied');
  await scope.recordBrand(brandId, transaction);
}
export async function admitWorkflowExecutionBoundary(
  transaction?: Prisma.TransactionClient,
): Promise<void> {
  await storage.getStore()?.admit(transaction);
}
export async function markWorkflowExecutionScopeUnproven(
  transaction?: Prisma.TransactionClient,
): Promise<void> {
  await storage.getStore()?.markUnproven(transaction);
}
