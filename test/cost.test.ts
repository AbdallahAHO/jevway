import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateCostUsd, profileOptions, resolveModel } from '../src/jev/model.ts';

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
