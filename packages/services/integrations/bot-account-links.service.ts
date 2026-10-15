import type {
  IBotAccountLink,
  IBotAccountLinkChallengePreview,
} from '@genfeedai/contracts/interfaces/integrations/bot-account-link.interface';
import { EnvironmentService } from '@services/core/environment.service';
import { HTTPBaseService } from '@services/core/interceptor.service';
import {
  deserializeCollection,
  deserializeResource,
  type JsonApiResponseDocument,
} from '@services/core/json-api';

export class BotAccountLinksService extends HTTPBaseService {
  constructor(token: string) {
    super(`${EnvironmentService.apiEndpoint}/bot-account-links`, token);
  }
  static getInstance(token: string): BotAccountLinksService {
    return HTTPBaseService.getBaseServiceInstance(
      BotAccountLinksService,
      token,
    );
  }
  async list(signal?: AbortSignal): Promise<IBotAccountLink[]> {
    const response = await this.instance.get<JsonApiResponseDocument>('', {
      signal,
    });
    return deserializeCollection<IBotAccountLink>(response.data);
  }
  async preview(
    challengeId: string,
    signal?: AbortSignal,
  ): Promise<IBotAccountLinkChallengePreview> {
    const response = await this.instance.get<JsonApiResponseDocument>(
      `challenges/${encodeURIComponent(challengeId)}`,
      { signal },
    );
    return deserializeResource<IBotAccountLinkChallengePreview>(response.data);
  }
  async confirm(challengeId: string): Promise<IBotAccountLink> {
    const response = await this.instance.post<JsonApiResponseDocument>(
      'confirm',
      { challengeId },
    );
    return deserializeResource<IBotAccountLink>(response.data);
  }
  async unlink(id: string): Promise<void> {
    await this.instance.delete(encodeURIComponent(id));
  }
}
