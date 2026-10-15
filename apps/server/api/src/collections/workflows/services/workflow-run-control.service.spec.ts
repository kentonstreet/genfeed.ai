import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { captureWorkflowActor } from '@api/authorization/brand-access/workflow-actor.util';
import { WorkflowExecutionReadScopeService } from '@api/authorization/brand-access/workflow-execution-read-scope.service';
import type { WorkflowExecutionsService } from '@api/collections/workflow-executions/services/workflow-executions.service';
import type { WorkflowExecutorService } from '@api/collections/workflows/services/workflow-executor.service';
import { WorkflowRunControlService } from '@api/collections/workflows/services/workflow-run-control.service';
import type { WorkflowsService } from '@api/collections/workflows/services/workflows.service';
import { NotFoundException } from '@api/exceptions/not-found.exception';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: true }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
afterEach(() => {
  runtime.cloud = true;
});
function fixture() {
  const actor = captureWorkflowActor({
    userId: 'actual-reader',
    organizationId: 'org',
  });
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: actor.userId }) },
    member: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ role: { key: MemberRole.OWNER }, brands: [] }),
    },
    apiKey: { findFirst: vi.fn().mockResolvedValue({ scopes: ['read'] }) },
  };
  const db = prisma as unknown as PrismaService;
  const scopes = new WorkflowExecutionReadScopeService(
    db,
    new BrandAccessService(db),
  );
  const startedAt = new Date('2026-10-08T00:00:00Z');
  const execution = {
    id: 'run',
    status: 'completed',
    startedAt,
    completedAt: startedAt,
    creditsUsed: 2,
    error: null,
    nodeResults: [
      {
        nodeId: 'node',
        output: {
          publicField: 'kept',
          initiatingActor: { userId: 'private' },
          nested: [
            {
              initiatingActorKey: 'private',
              initiatingRequestKey: 'private',
              citation: 'kept',
            },
          ],
        },
      },
    ],
  };
  const executions = { findOne: vi.fn().mockResolvedValue(execution) };
  const service = new WorkflowRunControlService(
    {} as WorkflowsService,
    {} as WorkflowExecutorService,
    executions as unknown as WorkflowExecutionsService,
    scopes,
  );
  return { actor, prisma, scopes, executions, execution, service };
}
describe('current-reader workflow raw logs', () => {
  it('filters before the private query and strips only reserved proof fields through the public serializer boundary', async () => {
    const f = fixture();
    const result = await f.service.getExecutionLogs(
      'workflow',
      'run',
      'org',
      f.actor,
    );
    expect(f.executions.findOne).toHaveBeenCalledWith({
      id: 'run',
      workflowId: 'workflow',
      organizationId: 'org',
      isDeleted: false,
      AND: [await f.scopes.predicate(f.actor)],
    });
    expect(result).toEqual({
      runId: 'run',
      workflowId: 'workflow',
      status: 'completed',
      startedAt: f.execution.startedAt,
      completedAt: f.execution.completedAt,
      error: null,
      totalCreditsUsed: 2,
      nodeResults: [
        {
          nodeId: 'node',
          output: { publicField: 'kept', nested: [{ citation: 'kept' }] },
        },
      ],
    });
    expect(f.execution.nodeResults[0].output.initiatingActor).toEqual({
      userId: 'private',
    });
  });
  it('denies a foreign actual reader before a private query', async () => {
    const f = fixture();
    await expect(
      f.service.getExecutionLogs('workflow', 'run', 'org', {
        ...f.actor,
        organizationId: 'foreign',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(f.executions.findOne).not.toHaveBeenCalled();
  });
  it('returns an opaque denial if membership is revoked during the payload await', async () => {
    const f = fixture();
    f.executions.findOne.mockImplementation(async () => {
      f.prisma.member.findFirst.mockResolvedValue(null);
      return f.execution;
    });
    await expect(
      f.service.getExecutionLogs('workflow', 'run', 'org', f.actor),
    ).rejects.toThrow(NotFoundException);
    expect(f.executions.findOne).toHaveBeenCalledTimes(1);
  });
  it('applies current API-key caps before query even for a canonical owner', async () => {
    const f = fixture();
    const keyActor = {
      ...f.actor,
      isApiKey: true,
      apiKeyId: 'actual-key',
      scopes: ['admin', 'read'],
    };
    await f.service.getExecutionLogs('workflow', 'run', 'org', keyActor);
    expect(f.executions.findOne.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        AND: [
          expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                readScope: {
                  is: expect.objectContaining({
                    protocolVersion: 1,
                    coverage: 'TRACKED',
                  }),
                },
              }),
            ]),
          }),
        ],
      }),
    );
    expect(f.prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'actual-key',
          userId: 'actual-reader',
          organizationId: 'org',
          isRevoked: false,
        }),
      }),
    );
  });
  it('denies a revoked actual key before query', async () => {
    const f = fixture();
    f.prisma.apiKey.findFirst.mockResolvedValue(null);
    await expect(
      f.service.getExecutionLogs('workflow', 'run', 'org', {
        ...f.actor,
        isApiKey: true,
        apiKeyId: 'actual-key',
        scopes: ['admin'],
      }),
    ).rejects.toThrow(NotFoundException);
    expect(f.executions.findOne).not.toHaveBeenCalled();
  });
  it('keeps the canonical missing execution denial', async () => {
    const f = fixture();
    f.executions.findOne.mockResolvedValue(null);
    await expect(
      f.service.getExecutionLogs('workflow', 'missing', 'org', f.actor),
    ).rejects.toThrow(NotFoundException);
  });
  it('preserves selfhost tenant/deletion scope and public log fields', async () => {
    runtime.cloud = false;
    const f = fixture();
    const result = await f.service.getExecutionLogs(
      'workflow',
      'run',
      'org',
      f.actor,
    );
    expect(f.executions.findOne).toHaveBeenCalledWith({
      id: 'run',
      workflowId: 'workflow',
      organizationId: 'org',
      isDeleted: false,
      AND: [{ organizationId: 'org', isDeleted: false }],
    });
    expect(result.runId).toBe('run');
    expect(result.totalCreditsUsed).toBe(2);
  });
});
