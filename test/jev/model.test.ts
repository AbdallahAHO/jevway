import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateCostUsd, profileOptions, resolveModel } from '../../src/jev/model.ts';

describe('the estimated cost of a run', () => {
  it("prices Jev's input tokens at its published rate, rounded to 6 decimals", () => {
    expect(estimateCostUsd('jev-1.14.0', 1_000_000)).toBe(0.042);
    expect(estimateCostUsd('jev-1.14.0', 7534)).toBe(0.000316);
    expect(estimateCostUsd('jev-1.14.0', 0)).toBe(0);
  });

  it('prices Jev through OpenRouter at the same rate, as an estimate', () => {
    expect(estimateCostUsd('typesafe/jev-1.14', 7534)).toBe(0.000316);
  });

  it('is null for a model whose price is written nowhere, never a guess', () => {
    expect(estimateCostUsd('cloudflare/clef-omni', 7534)).toBeNull();
    expect(estimateCostUsd('some/unknown-model', 7534)).toBeNull();
    expect(estimateCostUsd(null, 7534)).toBeNull();
  });
});

describe('the model a task reports', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is the id its requests are sent with, on either route', () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-key');
    expect(profileOptions(resolveModel({ model: 'jev' }).profile).model).toBe('jev-1.14.0');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect(profileOptions(resolveModel({ model: 'jev' }).profile).model).toBe('typesafe/jev-1.14');
    expect(profileOptions(resolveModel({ model: 'clef-omni' }).profile).model).toBe('cloudflare/clef-omni');
  });
});

describe('model choice', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('routes Jev to the TypeSafe API when its key is set, otherwise through OpenRouter', () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect(resolveModel({ model: 'jev' })).toMatchObject({
      profile: { model: 'typesafe/jev-1.14', baseURL: 'https://openrouter.ai/api', apiKeyEnv: 'OPENROUTER_API_KEY' },
      screenshots: 'fallback',
    });
    expect(resolveModel({ model: 'jev' }).profile).toMatchObject({
      model: 'typesafe/jev-1.14',
      baseURL: 'https://openrouter.ai/api',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    });
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-key');
    const direct = resolveModel({ model: 'jev' });
    expect(direct).toMatchObject({
      profile: { model: 'jev-1.14.0', apiKeyEnv: 'TYPESAFE_API_KEY', imageTransport: 'assets', box: true },
      screenshots: 'fallback',
    });
    expect(direct.profile.baseURL).toBeUndefined();
    // OpenRouter drops TypeSafe's `assets` map, so Box only runs on the direct route.
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect(resolveModel({ model: 'jev' }).profile).toMatchObject({ imageTransport: 'image_url', box: false });
  });

  it('defaults Clef to text-only and Clef-omni to a screenshot every step', () => {
    expect(resolveModel({ model: 'clef' })).toMatchObject({ screenshots: 'off' });
    expect(resolveModel({ model: 'clef-omni' })).toMatchObject({
      profile: { model: 'cloudflare/clef-omni', apiKeyEnv: 'OPENROUTER_API_KEY' },
      screenshots: 'always',
    });
  });

  it('refuses screenshots for a model that cannot read them, and unknown names', () => {
    expect(() => resolveModel({ model: 'clef', screenshots: 'always' })).toThrow(/cannot read screenshots/);
    expect(() => resolveModel({ model: 'gpt' })).toThrow(/Unknown model/);
    expect(() => resolveModel({ model: 'clef-omni', screenshots: 'sometimes' })).toThrow(/Unknown screenshot mode/);
  });
});
