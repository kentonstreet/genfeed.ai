import {
  storyboardLegacyConfigSchema,
  storyboardStoredRunConfigSchema,
} from '@api/collections/content-runs/services/storyboard-imported-run-state.schema';
import {
  convertStoryboardRun,
  storyboardConfigHash,
  storyboardLegacySceneInputHash,
} from '@api/collections/content-runs/services/storyboard-run-migration';
import { projectStoryboardRun } from '@api/collections/content-runs/services/storyboard-run-store.service';
import { ContentRunStatus } from '@genfeedai/contracts';
import { describe, expect, it } from 'vitest';

function fixture() {
  const config = storyboardLegacyConfigSchema.parse({
    contract: 'brand-remix-run',
    version: 1,
    recipeVersion: 1,
    revision: 4,
    phase: 'prefilled',
    readiness: { state: 'ready', issues: [] },
    draft: {
      fidelityMode: 'guided',
      identity: {},
      intent: { objective: 'A product video' },
      output: {
        kind: 'video',
        count: 1,
        aspectRatio: '9:16',
        durationSeconds: 12,
      },
      references: [],
      reviewRequired: true,
      target: { kind: 'organic', platform: 'tiktok' },
    },
    sourceSnapshot: {
      capturedAt: '2026-09-30T12:00:00.000Z',
      selector: { kind: 'source_post', sourcePostId: 'source-1' },
      sourceId: 'source-1',
      platform: 'tiktok',
      title: 'A product',
      metrics: {},
      pattern: {},
      evidence: [],
    },
    concept: {
      savedAt: '2026-09-30T12:00:00.000Z',
      storyboard: [1, 2].map((ordinal) => ({
        id: `scene-${ordinal}`,
        ordinal,
        visualIntent: 'Show the product',
        durationSeconds: 6,
      })),
    },
    scenePipeline: {
      version: 1,
      language: 'en',
      state: 'storyboard',
      cancellationGeneration: 0,
      replacedAssetIds: [],
      receipts: [],
      scenes: {
        'scene-1': {
          identity: { avatarAssetId: 'avatar-1', speechVoiceId: 'voice-1' },
          referenceAssetIds: [],
          image: { state: 'ready', attempt: 1, assetId: 'image-1' },
          video: { state: 'pending', attempt: 1 },
          replacedAssetIds: [],
        },
      },
    },
  });
  const record = {
    id: 'run-1',
    brandId: 'brand-1',
    organizationId: 'org-1',
    isDeleted: false,
    updatedAt: new Date('2026-09-30T12:00:00.000Z'),
    config,
  };
  const context = {
    brandId: 'brand-1',
    organizationId: 'org-1',
    migratedAt: '2026-09-30T14:00:00.000Z',
    authorizedAssetIds: new Set(['image-1', 'avatar-1']),
  };
  return { config, record, context };
}
describe('Lossless in-place Storyboard converter', () => {
  it('archives exact original state and preserves revision, scene IDs and real stale assets without inventing creator/request/model', () => {
    const { config, record, context } = fixture();
    const result = convertStoryboardRun(record, context);
    const converted = storyboardStoredRunConfigSchema.parse(result.config);
    expect(converted).toMatchObject({
      origin: 'migrated',
      revision: 4,
      createdByUserId: null,
      clientRequestId: null,
      submittedInputHash: null,
    });
    expect(converted.plan?.shots[0]).toMatchObject({
      id: 'scene-1',
      ordinal: 1,
      stillAssetId: 'image-1',
      stillFreshness: 'stale',
    });
    expect(converted.importedState?.originalConfig).toEqual(config);
    expect(result.report.preservationChecks).toEqual({
      originalArchiveUnchanged: true,
      creativeRevisionUnchanged: true,
      paidIdentitiesUnchanged: true,
    });
    expect(config.contract).toBe('brand-remix-run');
  });
  it('conversion is a no-op on the matching fingerprint even when the clock changes', () => {
    const { record, context } = fixture();
    const first = convertStoryboardRun(record, context);
    const second = convertStoryboardRun(
      { ...record, config: first.config },
      { ...context, migratedAt: '2026-10-01T00:00:00.000Z' },
    );
    expect(second.status).toBe('unchanged');
    expect(second.config).toEqual(first.config);
  });
  it('preserves 4:5 in the imported plan branch', () => {
    const { record, context, config } = fixture();
    if ('aspectRatio' in config.draft.output)
      config.draft.output.aspectRatio = '4:5';
    expect(
      storyboardStoredRunConfigSchema.parse(
        convertStoryboardRun(record, context).config,
      ).plan?.format,
    ).toBe('4:5');
  });
  it.each(['dialogue', 'runtime', 'non-scene'] as const)(
    'exposes recovery for unrepresentable %s without truncating the archive',
    (kind) => {
      const { record, context, config } = fixture();
      if (kind === 'dialogue' && config.concept)
        config.concept.storyboard[0].narration = 'x'.repeat(600);
      if (kind === 'runtime' && 'durationSeconds' in config.draft.output)
        config.draft.output.durationSeconds = 180;
      if (kind === 'non-scene')
        config.draft.output = { kind: 'image', aspectRatio: '1:1', count: 2 };
      const migrated = storyboardStoredRunConfigSchema.parse(
        convertStoryboardRun(record, context).config,
      );
      expect(migrated.plan).toBeNull();
      expect(migrated.importedState?.originalConfig).toEqual(config);
      expect(migrated.importedPresentation?.shots[0].action).toBe(
        'Show the product',
      );
    },
  );
  it('only marks stills fresh with ready output and verified matching source inputs', () => {
    const { record, context, config } = fixture();
    const scene = config.concept?.storyboard[0];
    if (!scene) throw new Error('fixture');
    const verifiedStills = new Map([
      [
        'scene-1',
        {
          assetId: 'image-1',
          inputHash: storyboardLegacySceneInputHash(config, scene),
        },
      ],
    ]);
    expect(
      storyboardStoredRunConfigSchema.parse(
        convertStoryboardRun(record, { ...context, verifiedStills }).config,
      ).plan?.shots[0].stillFreshness,
    ).toBe('fresh');
    scene.visualIntent = 'Changed';
    expect(
      storyboardStoredRunConfigSchema.parse(
        convertStoryboardRun(record, { ...context, verifiedStills }).config,
      ).plan?.shots[0].stillFreshness,
    ).toBe('stale');
  });
  it('uses deterministic IDs only for never-executed draft scenes', () => {
    const { record, context, config } = fixture();
    if (config.concept) delete config.concept.storyboard[1].id;
    const first = storyboardStoredRunConfigSchema.parse(
      convertStoryboardRun(record, context).config,
    );
    const second = storyboardStoredRunConfigSchema.parse(
      convertStoryboardRun(record, context).config,
    );
    expect(first.plan?.shots[1].id).toEqual(second.plan?.shots[1].id);
    expect(first.plan?.shots[1].id).toMatch(/^shot-/);
  });
  it('rejects cross-org, soft-deleted and unknown contracts without changing any bytes', () => {
    const { record, context } = fixture();
    for (const input of [
      { ...record, organizationId: 'other-org' },
      { ...record, isDeleted: true },
      { ...record, config: { contract: 'other' } },
    ]) {
      const result = convertStoryboardRun(input, context);
      expect(result.status).toBe('unsupported');
      expect(storyboardConfigHash(result.config)).toBe(
        storyboardConfigHash(input.config),
      );
    }
  });
  it('public projection excludes archives, historical quote and funding state', () => {
    const { record, context } = fixture();
    const result = convertStoryboardRun(record, context);
    const projected = projectStoryboardRun({
      ...record,
      createdAt: record.updatedAt,
      status: ContentRunStatus.PENDING,
      config: result.config as never,
    });
    expect(projected.migrationReview?.status).toBe('required');
    expect(JSON.stringify(projected)).not.toContain('originalConfig');
    expect(JSON.stringify(projected)).not.toContain('importedState');
    expect(JSON.stringify(projected)).not.toContain('receipts');
  });
});

describe('Imported accepted-work recovery blockers', () => {
  it('keeps a missing accepted actor null and preserves the original quote/receipt identities', () => {
    const { record, context, config } = fixture();
    if (!config.scenePipeline) throw new Error('fixture');
    config.scenePipeline.operation = {
      id: 'old-op',
      quoteId: 'old-quote',
      revision: 3,
      sequence: 7,
      cancellationGeneration: 1,
      startedAt: '2026-09-30T12:00:00.000Z',
    };
    config.scenePipeline.state = 'blocked';
    config.scenePipeline.receipts = [
      {
        key: 'line:original',
        operationId: 'old-op',
        reservationId: 'hold:original',
        amount: 3,
        billingMode: 'platform',
        state: 'uncertain',
      },
    ];
    const converted = storyboardStoredRunConfigSchema.parse(
      convertStoryboardRun(record, context).config,
    );
    expect(converted.createdByUserId).toBeNull();
    expect(converted.migrationReview?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LEGACY_STAGE_IDENTITY_MISSING' }),
      ]),
    );
    expect(
      converted.importedState?.originalConfig.scenePipeline?.operation?.userId,
    ).toBeUndefined();
    expect(
      converted.importedState?.originalConfig.scenePipeline?.receipts,
    ).toEqual(config.scenePipeline.receipts);
    expect(converted.migrationRecovery?.nextSequence).toBe(8);
  });
  it('never guesses an absent scene ID once its operation has been accepted', () => {
    const { record, context, config } = fixture();
    if (!config.scenePipeline || !config.concept) throw new Error('fixture');
    delete config.concept.storyboard[1].id;
    config.scenePipeline.operation = {
      id: 'old-op',
      quoteId: 'old-quote',
      userId: 'user-1',
      revision: 4,
      sequence: 1,
      cancellationGeneration: 0,
      startedAt: '2026-09-30T12:00:00.000Z',
    };
    const converted = storyboardStoredRunConfigSchema.parse(
      convertStoryboardRun(record, context).config,
    );
    expect(converted.plan).toBeNull();
    expect(converted.importedPresentation?.shots[1].id).toBeNull();
    expect(
      converted.importedState?.originalConfig.concept?.storyboard[1].id,
    ).toBeUndefined();
  });
  it('does not discard a seventh distinct cast pair or overwrite an archive fingerprint', () => {
    const { record, context, config } = fixture();
    if (!config.concept) throw new Error('fixture');
    config.concept.storyboard = Array.from({ length: 7 }, (_, index) => ({
      id: `scene-${index + 1}`,
      ordinal: index + 1,
      visualIntent: 'Action',
      durationSeconds: 1,
      identity: {
        avatarAssetId: `avatar-${index + 1}`,
        speechVoiceId: `voice-${index + 1}`,
      },
    }));
    context.authorizedAssetIds = new Set(
      Array.from({ length: 7 }, (_, index) => `avatar-${index + 1}`),
    );
    const converted = storyboardStoredRunConfigSchema.parse(
      convertStoryboardRun(record, context).config,
    );
    expect(converted.plan).toBeNull();
    expect(converted.migrationReview?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LEGACY_CAST_LIMIT_EXCEEDED' }),
      ]),
    );
    if (!converted.importedState) throw new Error('fixture');
    converted.importedState.originalConfig.revision += 1;
    expect(storyboardStoredRunConfigSchema.safeParse(converted).success).toBe(
      false,
    );
  });
});
