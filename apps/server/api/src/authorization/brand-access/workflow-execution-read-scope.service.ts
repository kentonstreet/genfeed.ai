import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import {
  refreshWorkflowActor,
  type WorkflowInitiatingActor,
  workflowRequestKey,
} from '@api/authorization/brand-access/workflow-actor.util';
import { currentWorkflowExecutionReadScope } from '@api/authorization/brand-access/workflow-execution-read-scope-context.util';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { isCloudDeployment } from '@genfeedai/config';
import { SYSTEM_WORKFLOW_PRINCIPAL_ID } from '@genfeedai/contracts/interfaces';
import { Prisma } from '@genfeedai/prisma';
import { ForbiddenException, Injectable } from '@nestjs/common';

/** Current-reader admission. Stored initiating authority never grants history access. */
@Injectable()
export class WorkflowExecutionReadScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: BrandAccessService,
  ) {}

  async predicate(
    capturedReader: WorkflowInitiatingActor,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.WorkflowExecutionWhereInput> {
    const organizationId = capturedReader.organizationId;
    const base = { organizationId, isDeleted: false };
    if (!isCloudDeployment()) return base;
    const reader = await refreshWorkflowActor(
      tx,
      this.policy,
      capturedReader,
      organizationId,
    );
    const access = await this.policy.resolve(reader, tx);
    const invalidDependency: Prisma.WorkflowExecutionReadBrandDependencyWhereInput =
      {
        OR: [
          { organizationId: { not: organizationId } },
          { brand: { isNot: access.where } },
        ],
      };
    const tenantRoot: Prisma.WorkflowExecutionWhereInput = {
      workflow: {
        is: {
          organizationId,
          isDeleted: false,
          OR: [{ brandId: null }, { brand: { is: access.where } }],
        },
      },
    };
    // These are the existing customer-history SYSTEM arms, not a generic
    // SYSTEM/null-brand grant. The actual caller's existing resource policy
    // remains an additional AND; new TRACKED binding is producer-owned.
    const proactiveRoot: Prisma.WorkflowExecutionWhereInput = {
      workflow: {
        is: {
          organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
          isDeleted: false,
          metadata: {
            path: ['systemWorkflow', 'canonicalId'],
            equals: 'agent.turn.execute',
          },
        },
      },
      AND: [
        { result: { path: ['metadata', 'source'], equals: 'proactive' } },
        {
          result: {
            path: ['metadata', 'canonicalId'],
            equals: 'agent.turn.execute',
          },
        },
        {
          NOT: {
            result: {
              path: ['metadata', 'strategyId'],
              equals: Prisma.AnyNull,
            },
          },
        },
      ],
    };
    const batchRoot: Prisma.WorkflowExecutionWhereInput = {
      workflow: {
        is: {
          organizationId: SYSTEM_WORKFLOW_PRINCIPAL_ID,
          isDeleted: false,
          metadata: {
            path: ['systemWorkflow', 'canonicalId'],
            equals: 'workflow.batch.execute',
          },
        },
      },
    };
    const knownRoot: Prisma.WorkflowExecutionWhereInput = {
      OR: [tenantRoot, proactiveRoot, batchRoot],
    };
    if (access.brandIds === undefined) {
      // Unrestricted OWNER/ADMIN retains unbound history. Known foreign/deleted
      // dependencies and lifecycle denials still apply; this is not a grant
      // of personal secrets or a bypass of the caller's existing resource policy.
      return {
        ...base,
        AND: [
          knownRoot,
          {
            OR: [
              { readScope: { is: null } },
              {
                readScope: {
                  is: {
                    organizationId,
                    isDeleted: false,
                    dependencies: { none: invalidDependency },
                  },
                },
              },
            ],
          },
        ],
      };
    }
    // TRACKED is established only at trusted producer creation with full adapter
    // coverage, atomic dependencies and verified lineage. Arbitrary null brand
    // or JSON metadata cannot establish this certificate; legacy remains opaque.
    return {
      ...base,
      AND: [
        knownRoot,
        {
          readScope: {
            is: {
              organizationId,
              isDeleted: false,
              protocolVersion: 1,
              coverage: 'TRACKED',
              OR: [
                { scopeClass: 'ORG_ONLY', dependencies: { none: {} } },
                {
                  scopeClass: 'BRAND_BOUND',
                  dependencies: { some: {}, none: invalidDependency },
                },
              ],
            },
          },
        },
      ],
    };
  }

  /** Lock a child before discovering ancestors, preventing concurrent append from losing a union. */
  private async lockedAncestors(
    tx: Prisma.TransactionClient,
    organizationId: string,
    executionId: string,
  ): Promise<string[]> {
    const pending = [executionId];
    const locked = new Set<string>();
    while (pending.length) {
      const current = pending.shift();
      if (!current || locked.has(current)) continue;
      const result = await tx.workflowExecutionReadScope.updateMany({
        where: {
          executionId: current,
          organizationId,
          isDeleted: false,
          protocolVersion: 1,
        },
        data: { protocolVersion: 1 },
      });
      if (result.count !== 1)
        throw new ForbiddenException('Execution read binding unavailable');
      locked.add(current);
      const edges = await tx.workflowExecutionReadLineage.findMany({
        where: { childExecutionId: current, organizationId },
        select: { parentExecutionId: true },
      });
      pending.push(...edges.map((edge) => edge.parentExecutionId).sort());
    }
    return [...locked];
  }

  /** Append private brands before payload visibility, including every real ancestor. */
  async recordBrand(
    reader: WorkflowInitiatingActor,
    executionId: string,
    brandId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const append = async (tx: Prisma.TransactionClient) => {
      const fresh = await refreshWorkflowActor(
        tx,
        this.policy,
        reader,
        reader.organizationId,
      );
      const access = await this.policy.resolve(fresh, tx);
      const brand = await tx.brand.findFirst({
        where: {
          organizationId: reader.organizationId,
          isDeleted: false,
          AND: [access.where, { id: brandId }],
        },
        select: { id: true },
      });
      if (!brand) throw new ForbiddenException('Brand access denied');
      const ancestors = await this.lockedAncestors(
        tx,
        reader.organizationId,
        executionId,
      );
      await tx.workflowExecutionReadBrandDependency.createMany({
        data: ancestors.map((id) => ({
          executionId: id,
          organizationId: reader.organizationId,
          brandId,
        })),
        skipDuplicates: true,
      });
      await tx.workflowExecutionReadScope.updateMany({
        where: {
          organizationId: reader.organizationId,
          isDeleted: false,
          executionId: { in: ancestors },
        },
        data: { scopeClass: 'BRAND_BOUND' },
      });
      const committedActor = await refreshWorkflowActor(
        tx,
        this.policy,
        reader,
        reader.organizationId,
      );
      const committedAccess = await this.policy.resolve(committedActor, tx);
      const committedBrand = await tx.brand.findFirst({
        where: {
          organizationId: reader.organizationId,
          isDeleted: false,
          AND: [committedAccess.where, { id: brandId }],
        },
        select: { id: true },
      });
      if (!committedBrand) throw new ForbiddenException('Brand access denied');
    };
    if (transaction) await append(transaction);
    else await this.prisma.$transaction(append);
  }

  /** Unknown adapter coverage poisons dependent history permanently. */
  async markUnproven(
    organizationId: string,
    executionId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const mark = async (tx: Prisma.TransactionClient) => {
      const ancestors = await this.lockedAncestors(
        tx,
        organizationId,
        executionId,
      );
      await tx.workflowExecutionReadScope.updateMany({
        where: {
          organizationId,
          isDeleted: false,
          executionId: { in: ancestors },
        },
        data: { coverage: 'UNPROVEN' },
      });
    };
    if (transaction) await mark(transaction);
    else await this.prisma.$transaction(mark);
  }

  async admitContext(
    transaction: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const context = currentWorkflowExecutionReadScope();
    if (!context) {
      if (isCloudDeployment())
        throw new ForbiddenException(
          'Execution authorization context unavailable',
        );
      return;
    }
    await context.admit(transaction);
  }

  async snapshot(reader: WorkflowInitiatingActor) {
    const currentReader = await refreshWorkflowActor(
      this.prisma,
      this.policy,
      reader,
      reader.organizationId,
    );
    const where = await this.predicate(currentReader);
    return { where, key: workflowRequestKey({ where, reader: currentReader }) };
  }

  /** Awaited private reads cannot return a snapshot admitted before revocation. */
  async assertUnchanged(
    reader: WorkflowInitiatingActor,
    key: string,
  ): Promise<void> {
    try {
      if ((await this.snapshot(reader)).key !== key) {
        throw new NotFoundException('Workflow execution not found');
      }
    } catch (error) {
      if (error instanceof ForbiddenException)
        throw new NotFoundException('Workflow execution not found');
      throw error;
    }
  }

  async assert(
    reader: WorkflowInitiatingActor,
    executionId: string,
    existingResourcePolicy: Prisma.WorkflowExecutionWhereInput = {},
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    try {
      const where = await this.predicate(reader, tx);
      const row = await tx.workflowExecution.findFirst({
        where: {
          organizationId: reader.organizationId,
          isDeleted: false,
          id: executionId,
          AND: [existingResourcePolicy, where],
        },
        select: { id: true },
      });
      if (!row) throw new NotFoundException('Workflow execution not found');
    } catch (error) {
      if (error instanceof ForbiddenException)
        throw new NotFoundException('Workflow execution not found');
      throw error;
    }
  }
}
