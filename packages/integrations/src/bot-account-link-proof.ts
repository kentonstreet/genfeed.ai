/** Installation proof authenticates daemon transport, never a Genfeed user role. */
export type BotAccountLinkPlatform = 'SLACK' | 'DISCORD' | 'TELEGRAM';
export interface BotAccountLinkEvent {
  integrationId: string;
  organizationId: string;
  platform: BotAccountLinkPlatform;
  remoteUserId: string;
  channelId: string;
  sourceEventId: string;
  isPrivate: boolean;
}
export interface BotAccountLinkProofRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  event: BotAccountLinkEvent;
  body: unknown;
  nonce: string;
  timestamp: number;
}
export const BOT_ACCOUNT_LINK_PROOF_WINDOW_MS = 5 * 60 * 1000;
const DOMAIN = 'genfeed.bot-account-link.installation.v1';
const encoder = new TextEncoder();
function text(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}
export function parseBotAccountLinkEvent(value: unknown): BotAccountLinkEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid bot installation event');
  const event = value as Record<string, unknown>;
  if (
    !['SLACK', 'DISCORD', 'TELEGRAM'].includes(String(event.platform)) ||
    !text(event.integrationId) ||
    !text(event.organizationId) ||
    !text(event.remoteUserId) ||
    !text(event.channelId) ||
    !text(event.sourceEventId) ||
    typeof event.isPrivate !== 'boolean'
  )
    throw new Error('Invalid bot installation event');
  return {
    integrationId: event.integrationId,
    organizationId: event.organizationId,
    platform: event.platform as BotAccountLinkPlatform,
    remoteUserId: event.remoteUserId,
    channelId: event.channelId,
    sourceEventId: event.sourceEventId,
    isPrivate: event.isPrivate,
  };
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function payload(
  request: BotAccountLinkProofRequest,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !['GET', 'POST', 'PATCH'].includes(request.method) ||
    !text(request.path) ||
    !request.path.startsWith('/v1/internal/orgs/') ||
    request.path.includes('?') ||
    request.path.includes('#') ||
    !text(request.nonce) ||
    request.nonce.length < 16 ||
    !Number.isSafeInteger(request.timestamp)
  )
    throw new Error('Invalid bot installation proof');
  const event = parseBotAccountLinkEvent(request.event);
  const bodyDigest = hex(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(JSON.stringify(canonical(request.body ?? null))),
    ),
  );
  return encoder.encode(
    JSON.stringify({
      domain: DOMAIN,
      method: request.method,
      path: request.path,
      event,
      bodyDigest,
      nonce: request.nonce,
      timestamp: request.timestamp,
    }),
  );
}
async function signingKey(secret: string): Promise<CryptoKey> {
  if (!text(secret)) throw new Error('Bot installation credential unavailable');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`${DOMAIN}\0${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function signBotAccountLinkRequest(
  secret: string,
  request: BotAccountLinkProofRequest,
): Promise<string> {
  return hex(
    await crypto.subtle.sign(
      'HMAC',
      await signingKey(secret),
      await payload(request),
    ),
  );
}
/** The server additionally requires active installation identity and an atomic nonce fence. */
export async function verifyBotAccountLinkRequest(
  secret: string,
  request: BotAccountLinkProofRequest,
  signature: unknown,
  now = Date.now(),
): Promise<boolean> {
  if (
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(request.timestamp) ||
    request.timestamp > now + 30_000 ||
    now - request.timestamp > BOT_ACCOUNT_LINK_PROOF_WINDOW_MS
  )
    return false;
  try {
    const bytes = Uint8Array.from(signature.match(/../g) ?? [], (part) =>
      Number.parseInt(part, 16),
    );
    return await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret),
      bytes,
      await payload(request),
    );
  } catch {
    return false;
  }
}
