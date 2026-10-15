import { AdminApiKeyGuard } from '@api/helpers/guards/admin-api-key/admin-api-key.guard';
import { BotAccountLinksInternalController } from '@api/services/bot-account-links/bot-account-links.internal.controller';
import type { BotAccountLinksService } from '@api/services/bot-account-links/bot-account-links.service';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

function fixture(headers: Record<string, string> = {}) {
  const links = {
    beginChallenge: vi
      .fn()
      .mockResolvedValue({
        id: 'challenge',
        confirmationUrl:
          'https://app.example.test/org/~/settings/account/bot-links?challenge=challenge',
        expiresAt: '2026-10-09T00:05:00Z',
        encryptedToken: 'private-secret',
        initiatingActor: { userId: 'private-user' },
      }),
  };
  const controller = new BotAccountLinksInternalController(
    links as unknown as BotAccountLinksService,
  );
  const request = {
    originalUrl: '/v1/internal/orgs/org/bot-links/challenges',
    get: (name: string) => headers[name],
  } as Request;
  const body = {
    event: {
      integrationId: 'installation',
      organizationId: 'org',
      platform: 'SLACK',
      remoteUserId: 'native-user',
      channelId: 'private-channel',
      sourceEventId: 'native-event',
      isPrivate: true,
    },
  };
  return { links, controller, request, body };
}
describe('BotAccountLinksInternalController installation proof envelope', () => {
  it('retains the real server transport guard rather than treating a public decorator as installation authorization', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, BotAccountLinksInternalController),
    ).toEqual([AdminApiKeyGuard]);
  });
  it('forwards the original signed path, exact body and installation proof without inventing a Genfeed principal', async () => {
    const f = fixture({
      'x-genfeed-bot-nonce': 'nonce',
      'x-genfeed-bot-timestamp': '1234',
      'x-genfeed-bot-signature': 'signature',
    });
    const response = await f.controller.begin(f.request, 'org', f.body);
    expect(f.links.beginChallenge).toHaveBeenCalledWith('org', {
      method: 'POST',
      path: f.request.originalUrl,
      body: f.body,
      event: f.body.event,
      nonce: 'nonce',
      timestamp: 1234,
      signature: 'signature',
    });
    expect(JSON.stringify(response)).toContain('confirmationUrl');
    expect(JSON.stringify(response)).not.toContain('private-');
  });
  it('does not generate missing signatures or nonces on behalf of an unverified installation', async () => {
    const f = fixture();
    const denial = new ForbiddenException('Installation proof unavailable');
    f.links.beginChallenge.mockRejectedValue(denial);
    await expect(f.controller.begin(f.request, 'org', f.body)).rejects.toBe(
      denial,
    );
    expect(f.links.beginChallenge).toHaveBeenCalledWith(
      'org',
      expect.objectContaining({
        nonce: '',
        signature: '',
        timestamp: Number.NaN,
      }),
    );
  });
});
