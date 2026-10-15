import type { AuthenticatedUser } from '@api/auth/interfaces/authenticated-user.interface';
import { BotAccountLinksController } from '@api/services/bot-account-links/bot-account-links.controller';
import type { BotAccountLinksService } from '@api/services/bot-account-links/bot-account-links.service';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

function fixture() {
  const row = {
    id: 'link',
    integrationId: 'installation',
    platform: 'SLACK',
    remoteUserId: 'native-user',
    revision: 1,
    verifiedAt: '2026-10-09T00:00:00Z',
    revokedAt: null,
    userId: 'private-user',
    capturedApiKeyId: 'private-key',
    capturedScopes: ['admin'],
    encryptedToken: 'private-secret',
    initiatingActor: { userId: 'private-user' },
  };
  const links = {
    list: vi.fn().mockResolvedValue([row]),
    previewChallenge: vi.fn().mockResolvedValue(row),
    confirmChallenge: vi.fn().mockResolvedValue(row),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new BotAccountLinksController(
    links as unknown as BotAccountLinksService,
  );
  const user: AuthenticatedUser = {
    id: 'legacy-display-id',
    userId: 'canonical-user',
    organizationId: 'org',
    brandId: 'preference',
    isApiKey: true,
    apiKeyId: 'actual-key',
    scopes: ['read', 'read'],
  };
  const request = { originalUrl: '/v1/bot-account-links' } as Request;
  const actor = {
    userId: 'canonical-user',
    organizationId: 'org',
    isApiKey: true,
    apiKeyId: 'actual-key',
    scopes: ['read'],
  };
  return { links, controller, user, request, actor };
}
describe('BotAccountLinksController authenticated capture', () => {
  it('captures only the current canonical caller and preserves actual key identity on every account route', async () => {
    const f = fixture();
    await f.controller.list(f.request, f.user);
    await f.controller.preview(f.request, 'challenge', f.user);
    await f.controller.confirm(f.request, { challengeId: 'challenge' }, f.user);
    await f.controller.unlink('link', f.user);
    expect(f.links.list).toHaveBeenCalledWith(f.actor);
    expect(f.links.previewChallenge).toHaveBeenCalledWith('challenge', f.actor);
    expect(f.links.confirmChallenge).toHaveBeenCalledWith('challenge', f.actor);
    expect(f.links.unlink).toHaveBeenCalledWith('link', f.actor);
  });
  it('does not allow confirmation body authority to override the authenticated account', async () => {
    const f = fixture();
    const supplied = {
      challengeId: 'challenge',
      userId: 'forged',
      organizationId: 'foreign',
      initiatingActor: { isApiKey: false },
    };
    await f.controller.confirm(f.request, supplied, f.user);
    expect(f.links.confirmChallenge).toHaveBeenCalledWith('challenge', f.actor);
  });
  it('uses the production serializer for all read/confirmation responses without exposing captured authority', async () => {
    const f = fixture();
    const responses = [
      await f.controller.list(f.request, f.user),
      await f.controller.preview(f.request, 'challenge', f.user),
      await f.controller.confirm(
        f.request,
        { challengeId: 'challenge' },
        f.user,
      ),
    ];
    for (const response of responses) {
      const wire = JSON.stringify(response);
      expect(wire).toContain('native-user');
      expect(wire).not.toContain('private-');
      expect(wire).not.toContain('capturedScopes');
      expect(wire).not.toContain('initiatingActor');
    }
  });
  it('propagates live admission denial instead of serializing an empty list or a confirmation success', async () => {
    const f = fixture();
    const denial = new ForbiddenException('Brand access denied');
    f.links.list.mockRejectedValue(denial);
    f.links.confirmChallenge.mockRejectedValue(denial);
    await expect(f.controller.list(f.request, f.user)).rejects.toBe(denial);
    await expect(
      f.controller.confirm(f.request, { challengeId: 'challenge' }, f.user),
    ).rejects.toBe(denial);
  });
});
