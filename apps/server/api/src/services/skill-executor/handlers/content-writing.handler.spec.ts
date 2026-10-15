import { ContentGeneratorService } from '@api/collections/content-intelligence/services/content-generator.service';
import { LlmDispatcherService } from '@api/services/integrations/llm/llm-dispatcher.service';
import { ContentWritingHandler } from '@api/services/skill-executor/handlers/content-writing.handler';
import { LoggerService } from '@libs/logger/logger.service';
import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ cloud: false }));
vi.mock('@genfeedai/config', async (original) => ({
  ...(await original<typeof import('@genfeedai/config')>()),
  isCloudDeployment: () => runtime.cloud,
}));

describe('ContentWritingHandler', () => {
  let handler: ContentWritingHandler;

  const mockContentGeneratorService = {
    generateContent: vi.fn(),
  };

  const mockLlmDispatcherService = {
    chatCompletion: vi.fn(),
  };

  const mockLoggerService = {
    warn: vi.fn(),
  };

  const baseContext = {
    brandId: 'test-object-id',
    brandVoice: 'Bold and witty',
    organizationId: 'test-object-id',
    platforms: ['instagram'],
  };

  beforeEach(async () => {
    runtime.cloud = false;
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContentWritingHandler,
        {
          provide: ContentGeneratorService,
          useValue: mockContentGeneratorService,
        },
        { provide: LlmDispatcherService, useValue: mockLlmDispatcherService },
        {
          provide: LoggerService,
          useValue: mockLoggerService,
        },
      ],
    }).compile();

    handler = module.get(ContentWritingHandler);
  });

  it('generates content draft with refinement', async () => {
    mockContentGeneratorService.generateContent.mockResolvedValue([
      {
        content: 'Base generated content',
        hashtags: ['#ai'],
        patternUsed: 'freeform',
      },
    ]);

    mockLlmDispatcherService.chatCompletion.mockResolvedValue({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'Refined content', role: 'assistant' },
        },
      ],
      id: '1',
      usage: { completion_tokens: 12, prompt_tokens: 24, total_tokens: 36 },
    });

    const result = await handler.execute(baseContext, {
      platform: 'instagram',
      topic: 'AI content workflows',
    });

    expect(result.content).toBe('Refined content');
    expect(result.skillSlug).toBe('content-writing');
    expect(result.type).toBe('text');
    expect(result.platforms).toEqual(['instagram']);
  });

  it('throws when topic is missing', async () => {
    await expect(handler.execute(baseContext, {})).rejects.toThrow(
      'content-writing requires a topic',
    );
  });

  it('falls back to base draft when LLM refinement fails', async () => {
    mockContentGeneratorService.generateContent.mockResolvedValue([
      {
        content: 'Base generated content',
        hashtags: ['#ai'],
        patternUsed: 'freeform',
      },
    ]);

    mockLlmDispatcherService.chatCompletion.mockRejectedValue(
      new Error('LLM provider unavailable'),
    );

    const result = await handler.execute(baseContext, {
      topic: 'AI workflows',
    });

    expect(result.content).toBe('Base generated content');
    expect(result.skillSlug).toBe('content-writing');
    expect(mockLoggerService.warn).toHaveBeenCalledWith(
      'content-writing refinement failed, using base draft',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it('uses first platform from context when platform param is missing', async () => {
    mockContentGeneratorService.generateContent.mockResolvedValue([
      {
        content: 'Generated for twitter',
        hashtags: [],
        patternUsed: 'freeform',
      },
    ]);

    mockLlmDispatcherService.chatCompletion.mockResolvedValue({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'Refined for twitter', role: 'assistant' },
        },
      ],
      id: '2',
      usage: { completion_tokens: 10, prompt_tokens: 20, total_tokens: 30 },
    });

    const result = await handler.execute(
      { ...baseContext, platforms: ['twitter'] },
      { topic: 'Thread about AI' },
    );

    expect(result.content).toBe('Refined for twitter');
    expect(mockContentGeneratorService.generateContent).toHaveBeenCalled();
  });
  it('rejects missing server admission before generating a Cloud draft', async () => {
    runtime.cloud = true;
    await expect(
      handler.execute(baseContext, { topic: 'Topic' }),
    ).rejects.toThrow('Brand access denied');
    expect(mockContentGeneratorService.generateContent).not.toHaveBeenCalled();
  });
  it('rechecks revoked admission before refinement without returning a fallback success', async () => {
    runtime.cloud = true;
    mockContentGeneratorService.generateContent.mockResolvedValue([
      { content: 'Base', hashtags: [] },
    ]);
    const admission = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ForbiddenException('Brand access denied'));
    await expect(
      handler.execute(baseContext, { topic: 'Topic' }, admission),
    ).rejects.toThrow('Brand access denied');
    expect(admission).toHaveBeenCalledTimes(2);
    expect(mockLlmDispatcherService.chatCompletion).not.toHaveBeenCalled();
  });

  it('keeps captured actor and proof out of generator and refinement provider payloads', async () => {
    runtime.cloud = true;
    mockContentGeneratorService.generateContent.mockResolvedValue([
      { content: 'Draft', hashtags: [], patternUsed: 'freeform' },
    ]);
    mockLlmDispatcherService.chatCompletion.mockResolvedValue({
      choices: [{ message: { content: 'Refined' } }],
    });
    const admission = vi.fn().mockResolvedValue(undefined);
    const actor = {
      organizationId: baseContext.organizationId,
      userId: 'private-user',
      isApiKey: true,
      apiKeyId: 'private-key',
      scopes: ['admin'],
    };
    await handler.execute(
      { ...baseContext, initiatingActor: actor },
      { topic: 'Public topic' },
      admission,
    );
    expect(admission).toHaveBeenCalledTimes(2);
    expect(mockContentGeneratorService.generateContent).toHaveBeenCalledOnce();
    expect(mockLlmDispatcherService.chatCompletion).toHaveBeenCalledOnce();
    const providerPayload = JSON.stringify([
      mockContentGeneratorService.generateContent.mock.calls[0],
      mockLlmDispatcherService.chatCompletion.mock.calls[0],
    ]);
    for (const privateValue of [
      'private-user',
      'private-key',
      'initiatingActor',
      'initiatingActorKey',
      'initiatingRequestKey',
    ]) {
      expect(providerPayload).not.toContain(privateValue);
    }
  });
});
