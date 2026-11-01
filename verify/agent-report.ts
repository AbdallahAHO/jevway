// The real-agent suite's report: chores, runs, the agent's tool calls (stub; filled in by the feature commit).
import type { RecordedStep } from '../src/task/recording.ts';
import type { BrowserCall, ConfirmTarget } from './agent-confirms.ts';

export interface ChoreRun {
  chore: string;
  run: number;
  prompt: string;
  verdict: 'pass' | 'fail' | 'skipped' | 'error';
  check: string;
  passes: string;
  expectsHandBack?: string;
  calls: BrowserCall[];
  handBacks: string[];
  inventedValues: string[];
  confirmOffTarget: boolean;
  confirmTargets: ConfirmTarget[];
  sessionsEnded: number;
  otherTools: string[];
  denials: string[];
  answer: string;
  outcome: string;
  turns: number;
  costUsd: number | null;
  durationMs: number;
  dir: string;
}

export interface Totals {
  passed: number;
  ran: number;
  costUsd: number;
  runsOfUnknownCost: number;
  handBacks: number;
  unusableHandBacks: number;
  handBacksNeedingReplan: number;
  confirmCalls: number;
  confirmCallsHonoured: number;
  confirmCallsIgnored: number;
  confirmsWithoutTarget: number;
  confirmTargetsNotInPrompt: number;
  confirmTargetsRefused: number;
  stoppedBecause?: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  status?: string;
  reason?: string;
  actions?: number;
  title?: string;
  url?: string;
  error?: string;
}

export interface AgentRunRecord {
  transcript?: ToolCall[];
  recording?: { video: string | null; steps: RecordedStep[]; viewport?: { width: number; height: number } };
}

export const transcriptOf = (_stream: string): ToolCall[] => [];

export const renderAgentReport = (_input: { rows: ChoreRun[]; totals: Totals; model: string; outFolder?: string; readRun: (dir: string) => AgentRunRecord }) => '';
