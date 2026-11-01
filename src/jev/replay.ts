import type { Ask } from './decide.ts';

export interface RecordedRoute {
  profile: string;
  model: string;
  route: 'direct' | 'openrouter';
  screenshots?: string;
}

export class ReplayMiss extends Error {}

export const requestKey = (_model: string, _request: unknown): string => {
  throw new Error('not implemented');
};

export const recordingAsk = (_ask: Ask, _route: RecordedRoute, _dir?: string): Ask => {
  throw new Error('not implemented');
};

export const replayingAsk = (_model: string, _dir?: string): Ask => {
  throw new Error('not implemented');
};
