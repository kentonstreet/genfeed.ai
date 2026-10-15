import { describe, expect, it, vi } from 'vitest';
import { BotAccountLinkClient } from './bot-account-link.client';
import {
  type BotAccountLinkEvent,
  verifyBotAccountLinkRequest,
} from './bot-account-link-proof';

const event: BotAccountLinkEvent = {
  integrationId: 'installation-1',
  organizationId: 'org-1',
  platform: 'SLACK',
  remoteUserId: 'remote-1',
  channelId: 'private-1',
  sourceEventId: 'event-1',
  isPrivate: true,
};
const challenge = {
  id: 'a'.repeat(43),
  confirmationUrl:
    'https://app.example/org/~/settings/account/bot-links?challenge=one',
  expiresAt: '2030-01-01T00:00:00.000Z',
};
function fixture() {
  const post = vi
    .fn()
    .mockResolvedValue({ data: { id: challenge.id, attributes: challenge } });
  const client = new BotAccountLinkClient({
    apiUrl: 'https://api.example/',
    apiKey: 'internal-transport-key',
    installation: {
      id: event.integrationId,
      organizationId: event.organizationId,
      platform: event.platform,
      botToken: 'installation-secret',
    },
    http: { get: vi.fn(), post },
  });
  return { client, post };
}
describe('BotAccountLinkClient', () => {
  it('signs the exact private SDK event and returns only confirmation metadata', async () => {
    const { client, post } = fixture();
    expect(
      await client.beginChallenge({
        ...event,
        userId: 'forged',
      } as BotAccountLinkEvent),
    ).toEqual(challenge);
    const [url, body, headers] = post.mock.calls[0];
    expect(url).toBe(
      'https://api.example/v1/internal/orgs/org-1/bot-links/challenges',
    );
    expect(body).toEqual({ event });
    expect(JSON.stringify(body)).not.toContain('installation-secret');
    expect(headers.Authorization).toBe('Bearer internal-transport-key');
    expect(
      await verifyBotAccountLinkRequest(
        'installation-secret',
        {
          method: 'POST',
          path: '/v1/internal/orgs/org-1/bot-links/challenges',
          body,
          event,
          nonce: headers['x-genfeed-bot-nonce'],
          timestamp: Number(headers['x-genfeed-bot-timestamp']),
        },
        headers['x-genfeed-bot-signature'],
      ),
    ).toBe(true);
  });
  it.each([
    { ...event, isPrivate: false },
    { ...event, integrationId: 'other' },
    { ...event, organizationId: 'other' },
    { ...event, platform: 'DISCORD' as const },
  ])(
    'rejects a public or different installation event before transport',
    async (input) => {
      const { client, post } = fixture();
      await expect(client.beginChallenge(input)).rejects.toThrow(
        'private installation event',
      );
      expect(post).not.toHaveBeenCalled();
    },
  );
  it('retains API rejection rather than producing a success URL', async () => {
    const { client, post } = fixture();
    post.mockRejectedValue(new Error('installation revoked'));
    await expect(client.beginChallenge(event)).rejects.toThrow(
      'installation revoked',
    );
  });
  it.each([
    null,
    { data: null },
    { ...challenge, id: 'invalid' },
    { ...challenge, confirmationUrl: 'javascript:alert(1)' },
    { ...challenge, expiresAt: 'invalid' },
  ])('rejects malformed confirmation payloads', async (response) => {
    const { client, post } = fixture();
    post.mockResolvedValue(response);
    await expect(client.beginChallenge(event)).rejects.toThrow(
      'challenge unavailable',
    );
  });
  it('also supports an already normalized confirmation response', async () => {
    const { client, post } = fixture();
    post.mockResolvedValue(challenge);
    expect(await client.beginChallenge(event)).toEqual(challenge);
  });
});
