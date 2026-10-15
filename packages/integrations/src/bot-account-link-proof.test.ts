import { describe, expect, it } from 'vitest';
import {
  type BotAccountLinkProofRequest,
  parseBotAccountLinkEvent,
  signBotAccountLinkRequest,
  verifyBotAccountLinkRequest,
} from './bot-account-link-proof';

const secret = 'fixture-installation-credential';
const request: BotAccountLinkProofRequest = {
  method: 'POST',
  path: '/v1/internal/orgs/org-1/bot-account-links/challenges',
  event: {
    organizationId: 'org-1',
    integrationId: 'integration-1',
    platform: 'SLACK',
    remoteUserId: 'remote-1',
    channelId: 'dm-1',
    sourceEventId: 'event-1',
    isPrivate: true,
  },
  body: { operation: 'link' },
  nonce: 'fixture-nonce-0001',
  timestamp: 1_000_000,
};
describe('bot installation request proof', () => {
  it('verifies exact private SDK event without claiming canonical user authority', async () => {
    const signature = await signBotAccountLinkRequest(secret, request);
    expect(
      await verifyBotAccountLinkRequest(
        secret,
        request,
        signature,
        request.timestamp,
      ),
    ).toBe(true);
    expect(
      parseBotAccountLinkEvent({
        ...request.event,
        userId: 'forged',
        isApiKey: false,
      }),
    ).toEqual(request.event);
  });
  it.each([
    'organizationId',
    'integrationId',
    'platform',
    'remoteUserId',
    'channelId',
    'sourceEventId',
    'isPrivate',
  ] as const)('rejects altered event %s', async (field) => {
    const signature = await signBotAccountLinkRequest(secret, request);
    const event = {
      ...request.event,
      [field]: field === 'isPrivate' ? false : 'different',
    };
    expect(
      await verifyBotAccountLinkRequest(
        secret,
        { ...request, event } as BotAccountLinkProofRequest,
        signature,
        request.timestamp,
      ),
    ).toBe(false);
  });
  it.each(['method', 'path', 'body', 'nonce', 'timestamp'] as const)(
    'rejects altered request %s',
    async (field) => {
      const signature = await signBotAccountLinkRequest(secret, request);
      const changed = {
        ...request,
        [field]:
          field === 'body'
            ? { operation: 'run' }
            : field === 'timestamp'
              ? request.timestamp + 1
              : field === 'method'
                ? 'PATCH'
                : field === 'path'
                  ? '/v1/internal/orgs/org-1/bot-account-links/resolve'
                  : 'different-nonce-0002',
      };
      expect(
        await verifyBotAccountLinkRequest(
          secret,
          changed as BotAccountLinkProofRequest,
          signature,
          request.timestamp,
        ),
      ).toBe(false);
    },
  );
  it('rejects another installation credential, expired/future proof and malformed signature', async () => {
    const signature = await signBotAccountLinkRequest(secret, request);
    expect(
      await verifyBotAccountLinkRequest(
        'other-credential',
        request,
        signature,
        request.timestamp,
      ),
    ).toBe(false);
    expect(
      await verifyBotAccountLinkRequest(
        secret,
        request,
        signature,
        request.timestamp + 300_001,
      ),
    ).toBe(false);
    expect(
      await verifyBotAccountLinkRequest(
        secret,
        request,
        signature,
        request.timestamp - 30_001,
      ),
    ).toBe(false);
    expect(
      await verifyBotAccountLinkRequest(
        secret,
        request,
        'malformed',
        request.timestamp,
      ),
    ).toBe(false);
  });
  it('binds equivalent JSON body bytes independently of object insertion order', async () => {
    const initial = { ...request, body: { a: 1, b: { c: 2, d: 3 } } };
    const signature = await signBotAccountLinkRequest(secret, initial);
    expect(
      await verifyBotAccountLinkRequest(
        secret,
        { ...request, body: { b: { d: 3, c: 2 }, a: 1 } },
        signature,
        request.timestamp,
      ),
    ).toBe(true);
  });
});
