/**
 * Rebuilds a jobs suite's `report.html` from what its out folder kept: `results.json` and each run's `summary.json`.
 * Old runs get the current page without running anything again. Facts an older `results.json` never saved (the model,
 * the screenshots mode) show as unknown, never guessed; the title is made from the folder name and the job count.
 *
 * @example
 * // node verify/jobs/rerender.ts verify/out/forgejo-2026-11-01T15-43-33-653Z
 * // pnpm report:render verify/out/forgejo-2026-11-01T15-43-33-653Z
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
 * // 'Signup: 5 jobs with jev-browse' (when results.json has no title)
 */
export const reportFromResults = (saved: SavedResults, folder: string) => {
  const results: ReportResult[] = saved.results.map(({ job, runs }) => ({
    job: { ...job, confirms: confirmsFrom(job.confirms) } as unknown as ReportJob,
    runs,
  }));
  return {
    title: saved.title ?? `${suiteOf(folder)}: ${results.length} jobs with jev-browse`,
    results,
    model: saved.model ?? 'unknown',
    screenshots: saved.screenshots ?? 'unknown',
    device: saved.device ?? 'unknown',
    phrasing: (saved.phrasing ?? 'as-written') as Phrasing,
    outFolder: folder,
    writes: saved.writes ?? saved.results.some(({ job }) => job.confirms !== undefined),
  };
};

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write('usage: node verify/jobs/rerender.ts <verify/out/folder>\n');
    process.exit(2);
  }
  const outDir = resolve(dir);
  const saved = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as SavedResults;
  const readRecording = (runDir: string) => {
    try {
      return JSON.parse(readFileSync(join(outDir, runDir, 'summary.json'), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const report = join(outDir, 'report.html');
  writeFileSync(report, renderReport({ ...reportFromResults(saved, basename(outDir)), readRecording }));
  process.stdout.write(`${report}\n`);
}
