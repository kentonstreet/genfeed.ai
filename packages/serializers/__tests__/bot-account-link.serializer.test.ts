import { botAccountLinkSerializerConfig } from '@serializers/configs/integrations/bot-account-link.config';
import { BotAccountLinkSerializer } from '@serializers/server/integrations/bot-account-link.serializer';
import { describe, expect, it } from 'vitest';

describe('bot account link public boundary', () => {
  it('retains account metadata and omits all server authorization capture', () => {
    const row = {
      id: 'link-1',
      integrationId: 'integration-1',
      platform: 'SLACK',
      remoteUserId: 'remote-1',
      revision: 2,
      verifiedAt: '2026-10-09T00:00:00.000Z',
      revokedAt: null,
      userId: 'private-user',
      organizationId: 'private-org',
      capturedIsApiKey: true,
      capturedApiKeyId: 'private-key',
      capturedScopes: ['admin'],
      initiatingActor: { userId: 'private-user' },
      encryptedToken: 'private-token',
    };
    const serialized = JSON.parse(
      JSON.stringify(BotAccountLinkSerializer.serialize(row)),
    );
    expect(serialized.data.id).toBe('link-1');
    expect(serialized.data.attributes).toMatchObject({
      integrationId: 'integration-1',
      platform: 'SLACK',
      remoteUserId: 'remote-1',
      revision: 2,
      revokedAt: null,
    });
    for (const field of [
      'userId',
      'organizationId',
      'capturedIsApiKey',
      'capturedApiKeyId',
      'capturedScopes',
      'initiatingActor',
      'encryptedToken',
    ]) {
      expect(botAccountLinkSerializerConfig.attributes).not.toContain(field);
      expect(serialized.data.attributes).not.toHaveProperty(field);
    }
    expect(JSON.stringify(serialized)).not.toContain('private-');
  });
});
