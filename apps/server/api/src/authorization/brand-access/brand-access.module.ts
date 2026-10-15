import { BrandAccessService } from '@api/authorization/brand-access/brand-access.service';
import { WorkflowExecutionReadScopeService } from '@api/authorization/brand-access/workflow-execution-read-scope.service';
import { PrismaModule } from '@api/shared/modules/prisma/prisma.module';
import { Module } from '@nestjs/common';

@Module({
  imports: [PrismaModule],
  providers: [BrandAccessService, WorkflowExecutionReadScopeService],
  exports: [BrandAccessService, WorkflowExecutionReadScopeService],
})
export class BrandAccessModule {}
