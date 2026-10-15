import type { IBotAccountLinkChallenge } from '@genfeedai/contracts/interfaces/integrations/bot-account-link.interface';
import {
  type BotAccountLinkEvent,
  type BotAccountLinkPlatform,
  parseBotAccountLinkEvent,
  signBotAccountLinkRequest,
} from './bot-account-link-proof';
import type { BotHttpAdapter } from './bot-internal-api-client';

export interface BotAccountLinkClientOptions {
  apiUrl: string;
  apiKey: string;
  installation: {
    id: string;
    organizationId: string;
    platform: BotAccountLinkPlatform;
    botToken: string;
  };
  http: BotHttpAdapter;
}

function readChallenge(value: unknown): IBotAccountLinkChallenge {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Account link challenge unavailable.');
  const document = value as Record<string, unknown>;
  const data = document.data;
  const resource =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : document;
  const attributes = resource.attributes;
  const fields =
    attributes && typeof attributes === 'object' && !Array.isArray(attributes)
      ? (attributes as Record<string, unknown>)
      : resource;
  if (
    typeof resource.id !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(resource.id) ||
    typeof fields.confirmationUrl !== 'string' ||
    typeof fields.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(fields.expiresAt))
  )
    throw new Error('Account link challenge unavailable.');
  const url = new URL(fields.confirmationUrl);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Account link challenge unavailable.');
  return {
    id: resource.id,
    confirmationUrl: fields.confirmationUrl,
    expiresAt: fields.expiresAt,
  };
}

/** Installation credentials authenticate transport, never the remote sender as a Genfeed user. */
export class BotAccountLinkClient {
  constructor(private readonly options: BotAccountLinkClientOptions) {}

  async beginChallenge(
    nativeEvent: BotAccountLinkEvent,
  ): Promise<IBotAccountLinkChallenge> {
    const event = parseBotAccountLinkEvent(nativeEvent);
    const installation = this.options.installation;
    if (
      !event.isPrivate ||
      event.integrationId !== installation.id ||
      event.organizationId !== installation.organizationId ||
      event.platform !== installation.platform ||
      !this.options.apiKey ||
      !installation.botToken
    )
      throw new Error('Account linking requires a private installation event.');
    const path = `/v1/internal/orgs/${encodeURIComponent(installation.organizationId)}/bot-links/challenges`;
    const body = { event };
    const nonce = crypto.randomUUID();
    const timestamp = Date.now();
    const signature = await signBotAccountLinkRequest(installation.botToken, {
      method: 'POST',
      path,
      body,
      event,
      nonce,
      timestamp,
    });
    const response = await this.options.http.post<unknown>(
      `${this.options.apiUrl.replace(/\/$/, '')}${path}`,
      body,
      {
        Authorization: `Bearer ${this.options.apiKey}`,
        'x-genfeed-bot-nonce': nonce,
        'x-genfeed-bot-timestamp': String(timestamp),
        'x-genfeed-bot-signature': signature,
      },
    );
    return readChallenge(response);
  }
}
