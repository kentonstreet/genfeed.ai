import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@services/core/interceptor.service', () => ({
  HTTPBaseService: class {
    instance = http;
    static getBaseServiceInstance(
      Service: new (token: string) => unknown,
      token: string,
    ) {
      return new Service(token);
    }
  },
}));
vi.mock('@services/core/environment.service', () => ({
  EnvironmentService: { apiEndpoint: 'https://api.example' },
}));

import { BotAccountLinksService } from './bot-account-links.service';

const resource = {
  id: 'link-1',
  type: 'bot-account-link',
  attributes: {
    integrationId: 'installation',
    platform: 'SLACK',
    remoteUserId: 'remote',
    revision: 1,
    verifiedAt: '2030-01-01T00:00:00Z',
    revokedAt: null,
  },
};
describe('authenticated bot account links client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('deserializes only the authenticated account collection', async () => {
    http.get.mockResolvedValue({ data: { data: [resource] } });
    const signal = new AbortController().signal;
    expect(await new BotAccountLinksService('token').list(signal)).toEqual([
      { id: resource.id, ...resource.attributes },
    ]);
    expect(http.get).toHaveBeenCalledWith('', { signal });
  });
  it('encodes preview IDs and forwards cancellation', async () => {
    http.get.mockResolvedValue({ data: { data: resource } });
    const signal = new AbortController().signal;
    await new BotAccountLinksService('token').preview('opaque/id', signal);
    expect(http.get).toHaveBeenCalledWith('challenges/opaque%2Fid', { signal });
  });
  it('confirms only the opaque challenge without caller authority fields', async () => {
    http.post.mockResolvedValue({ data: { data: resource } });
    expect(
      await new BotAccountLinksService('token').confirm('challenge'),
    ).toEqual({ id: resource.id, ...resource.attributes });
    expect(http.post).toHaveBeenCalledWith('confirm', {
      challengeId: 'challenge',
    });
  });
  it('unlinks the encoded ID without actor metadata', async () => {
    http.delete.mockResolvedValue({ status: 204 });
    await expect(
      new BotAccountLinksService('token').unlink('opaque/id'),
    ).resolves.toBeUndefined();
    expect(http.delete).toHaveBeenCalledWith('opaque%2Fid');
  });
  it('surfaces expired or denied confirmation without an empty success result', async () => {
    http.post.mockRejectedValue(new Error('challenge unavailable'));
    await expect(
      new BotAccountLinksService('token').confirm('expired'),
    ).rejects.toThrow('challenge unavailable');
  });
});
