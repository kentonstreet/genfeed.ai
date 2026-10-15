import type { KnowledgeActor } from '@api/collections/contexts/interfaces/knowledge-actor.interface';
import { resolveApiKeyEffectiveMemberRole } from '@api/helpers/utils/auth/api-key-role.util';
import type { PrismaService } from '@api/shared/modules/prisma/prisma.service';
import { MemberRole } from '@genfeedai/contracts';
import { ForbiddenException } from '@nestjs/common';

export async function assertKnowledgeGovernance(
  prisma: PrismaService,
  actor: KnowledgeActor,
): Promise<void> {
  const member = await prisma.member.findFirst({
    select: { role: { select: { key: true } } },
    where: {
      organization: { is: { isDeleted: false } },
      role: { is: { isDeleted: false } },
      isActive: true,
      isDeleted: false,
      organizationId: actor.organizationId,
      userId: actor.userId,
    },
  });
  const canonicalRole = Object.values(MemberRole).find(
    (role) => role === member?.role?.key,
  );
  const role = canonicalRole
    ? resolveApiKeyEffectiveMemberRole(actor, canonicalRole)
    : undefined;
  if (role === MemberRole.OWNER || role === MemberRole.ADMIN) {
    return;
  }

  throw new ForbiddenException(
    'Knowledge governance requires an organization admin',
  );
}
