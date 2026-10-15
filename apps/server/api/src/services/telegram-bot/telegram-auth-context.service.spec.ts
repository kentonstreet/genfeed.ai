import type { ApiKeysService } from '@api/collections/api-keys/services/api-keys.service';
import { TelegramAuthContextService } from '@api/services/telegram-bot/telegram-auth-context.service';
import type { Context } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createContext(text: string): {
  ctx: Context;
  deleteMessage: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  return {
    ctx: {
      chat: { id: 42, type: 'private' },
      deleteMessage,
      message: { text },
      reply,
    } as unknown as Context,
    deleteMessage,
    reply,
  };
}

describe('TelegramAuthContextService', () => {
  it('attaches a verified API-key context to the chat', async () => {
    const apiKeysService = {
      findByKey: vi.fn().mockResolvedValue({
        id: 'key-1',
        organizationId: 'org-1',
        scopes: ['content:read'],
        userId: 'user-1',
      }),
    } as unknown as ApiKeysService;
    const service = new TelegramAuthContextService(apiKeysService);
    const { ctx, deleteMessage, reply } = createContext('/connect gf_secret');

    await service.handleConnect(ctx);

    expect(apiKeysService.findByKey).toHaveBeenCalledWith('gf_secret');
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(service.resolveAuthContext(42)).toEqual({
      apiKeyId: 'key-1',
      authType: 'api_key',
      organizationId: 'org-1',
      scopes: ['content:read'],
      userId: 'user-1',
    });
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('Connected'));
  });

  it('does not attach a context when the API key is invalid', async () => {
    const apiKeysService = {
      findByKey: vi.fn().mockResolvedValue(null),
    } as unknown as ApiKeysService;
    const service = new TelegramAuthContextService(apiKeysService);
    const { ctx, reply } = createContext('/connect gf_invalid');

    await service.handleConnect(ctx);

    expect(service.resolveAuthContext(42)).toBeNull();
    expect(reply).toHaveBeenCalledWith('❌ Invalid or expired API key.');
  });

  it('drops a connected chat when the key is later revoked', async () => {
    const apiKeysService = {
      findActiveById: vi.fn().mockResolvedValue(null),
      findByKey: vi.fn().mockResolvedValue({
        id: 'key-1',
        organizationId: 'org-1',
        scopes: ['content:read'],
        userId: 'user-1',
      }),
    } as unknown as ApiKeysService;
    const service = new TelegramAuthContextService(apiKeysService);
    const { ctx } = createContext('/connect gf_secret');

    await service.handleConnect(ctx);
    expect(service.resolveAuthContext(42)?.apiKeyId).toBe('key-1');

    await expect(service.resolveLiveAuthContext(42)).resolves.toBeNull();
    expect(apiKeysService.findActiveById).toHaveBeenCalledWith('key-1');
    expect(service.resolveAuthContext(42)).toBeNull();
  });

  it('refreshes cached scopes from the live key row', async () => {
    const apiKeysService = {
      findActiveById: vi.fn().mockResolvedValue({
        id: 'key-1',
        organizationId: 'org-1',
        scopes: ['videos:read'],
        userId: 'user-1',
      }),
      findByKey: vi.fn().mockResolvedValue({
        id: 'key-1',
        organizationId: 'org-1',
        scopes: ['content:read'],
        userId: 'user-1',
      }),
    } as unknown as ApiKeysService;
    const service = new TelegramAuthContextService(apiKeysService);
    const { ctx } = createContext('/connect gf_secret');

    await service.handleConnect(ctx);

    await expect(service.resolveLiveAuthContext(42)).resolves.toEqual({
      apiKeyId: 'key-1',
      authType: 'api_key',
      organizationId: 'org-1',
      scopes: ['videos:read'],
      userId: 'user-1',
    });
  });
});

const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));
beforeEach(() => {
  runtime.cloud = false;
});

describe('Cloud Telegram verified identity', () => {
  it('denies environment default identity while preserving selfhost default', async () => {
    const service = new TelegramAuthContextService();
    service.setDefaultAuthContext({
      authType: 'better_auth',
      organizationId: 'org',
      userId: 'configured',
    });
    expect(service.resolveAuthContext(42)?.userId).toBe('configured');
    runtime.cloud = true;
    expect(service.resolveAuthContext(42)).toBeNull();
    await expect(service.resolveLiveAuthContext(42)).resolves.toBeNull();
    const { ctx, reply } = createContext('/connect default');
    await service.handleConnect(ctx);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('verified API key'),
    );
  });
  it('intersects original captured and current scopes monotonically', async () => {
    runtime.cloud = true;
    const findActiveById = vi.fn().mockResolvedValue({
      id: 'key',
      organizationId: 'org',
      userId: 'user',
      scopes: ['read', 'write'],
    });
    const service = new TelegramAuthContextService({
      findByKey: vi.fn().mockResolvedValue({
        id: 'key',
        organizationId: 'org',
        userId: 'user',
        scopes: ['read', 'admin'],
      }),
      findActiveById,
    } as unknown as ApiKeysService);
    await service.handleConnect(createContext('/connect gf_secret').ctx);
    expect((await service.resolveLiveAuthContext(42))?.scopes).toEqual([
      'read',
    ]);
    findActiveById.mockResolvedValue({
      id: 'key',
      organizationId: 'org',
      userId: 'user',
      scopes: ['read', 'admin'],
    });
    expect((await service.resolveLiveAuthContext(42))?.scopes).toEqual([
      'read',
    ]);
  });
  it.each(['organizationId', 'userId'] as const)(
    'rejects live key %s rebinding',
    async (field) => {
      runtime.cloud = true;
      const service = new TelegramAuthContextService({
        findByKey: vi.fn().mockResolvedValue({
          id: 'key',
          organizationId: 'org',
          userId: 'user',
          scopes: ['read'],
        }),
        findActiveById: vi.fn().mockResolvedValue({
          id: 'key',
          organizationId: 'org',
          userId: 'user',
          scopes: ['read'],
          [field]: 'other',
        }),
      } as unknown as ApiKeysService);
      await service.handleConnect(createContext('/connect gf_secret').ctx);
      await expect(service.resolveLiveAuthContext(42)).resolves.toBeNull();
      expect(service.resolveAuthContext(42)).toBeNull();
    },
  );
});
