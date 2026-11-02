/**
 * Rebuilds a page from what an out folder kept, without running anything again:
 * - a jobs suite's `report.html` from `results.json` and each run's `summary.json`. Facts an older `results.json` never
 *   saved (the model, the screenshots mode) show as unknown, never guessed; the title is made from the folder name and
 *   the job count;
 * - the agent suite's `report.html` (its `results.json` has `rows`) from each run's `stream.jsonl`;
 * - one run folder's `index.html` from its `summary.json`.
 *
 * @example
 * // node verify/jobs/rerender.ts verify/out/forgejo-2026-11-01T15-43-33-653Z
 * // pnpm report:render verify/out/agent-2026-11-01T18-39-09-098Z
 * // pnpm report:render verify/out/forgejo-2026-11-01T15-43-33-653Z/new-issue/run-1
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writeManifest } from '../../src/output/manifest.ts';
import { renderRunPage } from '../../src/recording/run-page.ts';
import { agentRunReader, renderAgentReport, type ChoreRun, type Totals } from '../agent/report.ts';
import type { Phrasing, ReportJob, ReportResult, RunResult } from './report.ts';
import { renderReport } from './report.ts';

/** `results.json` as the runner writes it; the fields after `results` were added later and may be missing. */
export interface SavedResults {
  device: string;
  phrasing: string;
  runsPerJob: number;
  results: { job: Record<string, unknown>; runs: RunResult[] }[];
  title?: string;
  model?: string;
  screenshots?: string;
  writes?: boolean;
}

// A RegExp saved as its source ("/register/i"); older files saved it as {}, which says only that the job had one.
const confirmsFrom = (saved: unknown) => {
  const parts = typeof saved === 'string' ? /^\/(.*)\/([a-z]*)$/s.exec(saved) : null;
  return parts ? new RegExp(parts[1], parts[2]) : undefined;
};

// forgejo-2026-11-01T15-43-33-653Z → Forgejo
const suiteOf = (folder: string) => {
  const name = folder.replace(/-?\d{4}-\d{2}-\d{2}T[\d-]+Z$/, '');
  return name ? name[0].toUpperCase() + name.slice(1) : 'Verify';
};

/**
 * What `renderReport` needs, from a saved `results.json` and its folder's name (without `readRecording`).
 * A suite counts as writing when the file says so, or (older files) when any job had a confirmation rule.
 *
 * @example
 * reportFromResults(JSON.parse(readFileSync('results.json', 'utf8')), 'signup-2026-11-01T15-45-48-680Z').title
 * // 'Signup: 5 jobs with jevway' (when results.json has no title)
 */
export const reportFromResults = (saved: SavedResults, folder: string) => {
  const results: ReportResult[] = saved.results.map(({ job, runs }) => ({
    job: { ...job, confirms: confirmsFrom(job.confirms) } as unknown as ReportJob,
    runs,
  }));
  return {
    title: saved.title ?? `${suiteOf(folder)}: ${results.length} jobs with jevway`,
    results,
    model: saved.model ?? 'unknown',
    screenshots: saved.screenshots ?? 'unknown',
    device: saved.device ?? 'unknown',
    phrasing: (saved.phrasing ?? 'as-written') as Phrasing,
    outFolder: folder,
    writes: saved.writes ?? saved.results.some(({ job }) => job.confirms !== undefined),
  };
};

/**
 * The page an out folder (or a run folder) rebuilds into, and where it goes.
 *
 * @example
 * renderFolder('verify/out/agent-2026-11-01T18-39-09-098Z') // { file: '…/report.html', html: '<!doctype html>…' }
 */
export const renderFolder = (dir: string) => {
  const outDir = resolve(dir);
  const results = join(outDir, 'results.json');
  if (!existsSync(results)) {
    const record = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    return { file: join(outDir, 'index.html'), html: renderRunPage({ ...record, video: record.video ?? null }), runFolder: true };
  }
  const saved = JSON.parse(readFileSync(results, 'utf8'));
  const file = join(outDir, 'report.html');
  if (Array.isArray(saved.rows)) {
    const { rows, model, ...totals } = saved as Totals & { rows: ChoreRun[]; model?: string };
    return { file, html: renderAgentReport({ rows, totals, model: model ?? 'unknown', outFolder: basename(outDir), readRun: agentRunReader(outDir) }) };
  }
  const readRecording = (runDir: string) => {
    try {
      return JSON.parse(readFileSync(join(outDir, runDir, 'summary.json'), 'utf8'));
    } catch {
      return undefined;
    }
  };
  return { file, html: renderReport({ ...reportFromResults(saved as SavedResults, basename(outDir)), readRecording }) };
};

/**
 * Rebuilds a folder's page in place and returns its path. A run folder recorded before manifests existed also gets the
 * `manifest.json` its page links.
 *
 * @example
 * rerender('verify/out/forgejo-2026-11-01T15-43-33-653Z/new-issue/run-1') // '…/run-1/index.html'
 */
export const rerender = (dir: string) => {
  const { file, html, runFolder } = renderFolder(dir);
  writeFileSync(file, html);
  if (runFolder && !existsSync(join(dirname(file), 'manifest.json'))) writeManifest(dirname(file), 'run');
  return file;
};

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write('usage: node verify/jobs/rerender.ts <verify/out/folder | a run folder>\n');
    process.exit(2);
  }
  process.stdout.write(`${rerender(dir)}\n`);
}
