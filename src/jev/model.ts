import { TypeSafeClient } from '@typesafe-ai/sdk';
import { askWith, type Ask } from './decide.ts';
import { NEXT_ACTION_COMPACT } from './instructions.ts';

/** When a decision request carries a marked viewport screenshot. */
export type ScreenshotMode = 'off' | 'fallback' | 'always';

const OPENROUTER = 'https://openrouter.ai/api';

export interface ModelProfile {
  name: ModelName;
  /** Model id sent with every System One request. */
  model: string;
  /** API root; omitted means the TypeSafe API. */
  baseURL?: string;
  apiKeyEnv: string;
  /** Whether the model reads images placed in `state` at a sane token cost. */
  vision: boolean;
  /** Screenshot mode when the caller doesn't choose one. */
  defaultScreenshots: ScreenshotMode;
  /** Hand-back threshold on the model's reported confidence; each model reports on its own scale. */
  minConfidence: number;
  /** Flat operation rules for models that score them better than the structured NEXT_ACTION. */
  compactRules?: string;
  /** Judge commit risk per click candidate by name instead of one page-level guess (one extra request). */
  elementRisk: boolean;
}

type Profile = Omit<ModelProfile, 'name'> & {
  /** A direct route used instead when its key is set (Jev on the TypeSafe API). */
  direct?: Pick<ModelProfile, 'model' | 'apiKeyEnv' | 'vision' | 'defaultScreenshots'>;
};

/**
 * Decision models that speak the System One API (`/v1/systemone`), all through the same SDK.
 * Everything but direct Jev goes through OpenRouter; only root, key and model id differ.
 * Settings beyond Jev's come from the runs in docs/verification.md.
 */
export const MODELS = {
  jev: {
    model: 'typesafe/jev-1.14',
    baseURL: OPENROUTER,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    // The TypeSafe API wants images in its own `assets` map, which isn't wired up: text-only there.
    direct: { model: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY', vision: false, defaultScreenshots: 'off' },
    // OpenRouter turns `image_url` state parts into Jev 1.14 images.
    vision: true,
    // With a screenshot every step its done check dipped under 0.5 on a correct page (2 of 3 runs); text-first wins.
    defaultScreenshots: 'fallback',
    minConfidence: 0.3,
    elementRisk: false,
  },
  clef: {
    model: 'cloudflare/clef',
    baseURL: OPENROUTER,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    // Clef bills an image by its base64 size: one 58 KB screenshot cost 16k tokens and 2.7 s.
    vision: false,
    defaultScreenshots: 'off',
    // Like Clef-omni, its correct steps scored 0.18–0.3; Jev's 0.3 stops them.
    minConfidence: 0.05,
    elementRisk: true,
  },
  'clef-flash': {
    model: 'cloudflare/clef-flash',
    baseURL: OPENROUTER,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    vision: true,
    defaultScreenshots: 'always',
    minConfidence: 0.3,
    elementRisk: true,
  },
  'clef-omni': {
    model: 'cloudflare/clef-omni',
    baseURL: OPENROUTER,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    vision: true,
    // Only `always` completed the fixture flow; Clef's confidence can't tell when `fallback` should look.
    defaultScreenshots: 'always',
    // Clef reports confidence on a compressed scale: correct steps scored 0.09–0.3, so Jev's 0.3 stops everything.
    minConfidence: 0.05,
    compactRules: NEXT_ACTION_COMPACT,
    elementRisk: true,
  },
  'pplx-decider': {
    model: 'perplexity/pplx-decider-v1.1-27b',
    baseURL: OPENROUTER,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    vision: true,
    defaultScreenshots: 'always',
    minConfidence: 0.3,
    elementRisk: true,
  },
  'gpt-6-luna': {
    model: 'openai/gpt-6-luna-decisions',
    baseURL: OPENROUTER,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    vision: true,
    defaultScreenshots: 'always',
    minConfidence: 0.3,
    elementRisk: true,
  },
} as const satisfies Record<string, Profile>;

export type ModelName = keyof typeof MODELS;

/**
 * Resolves the model and screenshot mode from explicit choices, then `JEV_MODEL` / `JEV_SCREENSHOTS`.
 * Jev uses the TypeSafe API when `TYPESAFE_API_KEY` is set, otherwise OpenRouter.
 * Screenshots on a model that cannot read images are a configuration error, not a silent no-op.
 *
 * @example
 * const { profile, screenshots } = resolveModel({ model: 'clef-omni' }); // screenshots: 'always'
 */
export const resolveModel = ({
  model = process.env.JEV_MODEL || 'jev',
  screenshots = process.env.JEV_SCREENSHOTS || undefined,
}: { model?: string; screenshots?: string } = {}) => {
  if (!(model in MODELS)) throw new Error(`Unknown model "${model}"; use ${Object.keys(MODELS).join(' | ')}.`);
  const { direct, ...route }: Profile = MODELS[model as ModelName];
  const name = model as ModelName;
  const profile: ModelProfile =
    direct && process.env[direct.apiKeyEnv]?.trim()
      ? { ...route, ...direct, baseURL: undefined, name }
      : { ...route, name };
  const mode = screenshots ?? profile.defaultScreenshots;
  if (!['off', 'fallback', 'always'].includes(mode)) {
    throw new Error(`Unknown screenshot mode "${mode}"; use off | fallback | always.`);
  }
  if (mode !== 'off' && !profile.vision) throw new Error(`${profile.name} cannot read screenshots.`);
  return { profile, screenshots: mode as ScreenshotMode };
};

/** An `Ask` bound to the profile's API root, key and model. */
export const createAsk = (profile: ModelProfile): Ask => {
  const apiKey = process.env[profile.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`Set ${profile.apiKeyEnv} to use ${profile.name}.`);
  return askWith(
    new TypeSafeClient({
      apiKey,
      ...(profile.baseURL && { baseURL: profile.baseURL }),
      defaultModel: profile.model,
      timeout: 15_000,
      logLevel: 'off',
      // SDK 0.7 sends zstd bodies by default; only the TypeSafe API is known to accept them.
      ...(profile.baseURL && { compression: false }),
    }),
  );
};
