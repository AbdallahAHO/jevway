/**
 * jevway as an MCP client sees it: the built server (`dist/mcp.js`) over stdio, driven like a real consumer through
 * every tool on the local fixtures. It checks what the docs promise: the result shape and order, `story`, `next`,
 * progress per step, the end page inline on hand-backs, `resource_link`s and files that exist, readable folder and
 * file names, the run page and journey viewer with their embedded JSON, and errors that say what to do.
 *
 *   pnpm build && pnpm verify:mcp      # needs a key in .env; spends a few cents of Jev requests
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const WORK = join(REPO, 'verify/out/consumer', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(WORK, { recursive: true });

const fixtures: Record<string, Buffer> = {};
for (const name of ['stays.html', 'journey.html']) fixtures[`/${name}`] = readFileSync(join(REPO, 'verify/fixture', name));
const server = createServer((req, res) => {
  const body = fixtures[(req.url ?? '/').split('?')[0]];
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const checks: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, ...(detail !== undefined && { detail: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300) }) });
  process.stdout.write(`${pass ? '✔' : '✘'} ${name}${!pass && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}\n`);
};

const client = new Client({ name: 'consumer-check', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [`--env-file-if-exists=${REPO}/.env`, join(REPO, 'dist/mcp.js')],
    cwd: WORK,
    env: { ...process.env, JEVWAY_BROWSER: 'launch-headless' } as Record<string, string>,
    stderr: 'pipe',
  }),
);

type Result = { isError?: boolean; content: any[]; structuredContent?: any };
const call = async (name: string, args: Record<string, unknown>) => {
  const progress: string[] = [];
  const started = Date.now();
  const result = (await client.callTool({ name, arguments: args }, { onprogress: (p: any) => progress.push(`${p.progress}: ${p.message ?? ''}`), timeout: 300_000 } as any)) as Result;
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const kinds = result.content.map((c) => c.type);
  const links = result.content.filter((c) => c.type === 'resource_link');
  return { result, json, text, kinds, links, progress, ms: Date.now() - started };
};
const fileOf = (uri: string) => decodeURIComponent(new URL(uri).pathname);

// 1. Discovery
check('negotiated the 2026-07-28 protocol', (client as any).getNegotiatedProtocolVersion?.() === '2026-07-28', (client as any).getNegotiatedProtocolVersion?.());
const instructions = client.getInstructions() ?? '';
check('server instructions are present and under 4,096 chars', instructions.length > 200 && instructions.length < 4096, instructions.length);
const { tools } = await client.listTools();
check('8 tools in a fixed order', tools.map((t) => t.name).join(',') === 'jevway_task,jevway_look,jevway_end,jevway_journey_start,jevway_journey_step,jevway_journey_autopilot,jevway_journey_annotate,jevway_journey_finish', tools.map((t) => t.name));
const listTokens = Math.round(JSON.stringify(tools).length / 4);
check('tool list ≤ 2,600 tokens', listTokens <= 2600, listTokens);
check('jevway_task declares an output schema', Boolean(tools.find((t) => t.name === 'jevway_task')?.outputSchema));

// 2. A recorded task that should end done
const search = await call('jevway_task', {
  url: `${base}/stays.html`,
  goal: 'Find stays in Lisbon for 2 guests with free cancellation, then open the details of Casa Flora.',
  values: { destination: 'Lisbon' },
  done_when: "Casa Flora's details page is showing.",
  record: true,
});
const s = search.json;
check('search: status done', s?.status === 'done', s?.status + ': ' + s?.reason);
check('search: structuredContent equals the text JSON', JSON.stringify(search.result.structuredContent) === JSON.stringify(s));
check('search: leads with status, reason, story, next, session', JSON.stringify(Object.keys(s ?? {}).slice(0, 5)) === '["status","reason","story","next","session"]', Object.keys(s ?? {}));
check('search: story has one sentence per step', Array.isArray(s?.story) && s.story.length >= 2 && s.story.every((l: string) => /^[A-Z].*\.$/.test(l)), s?.story);
check('search: concise (no steps/jev by default)', s && !('steps' in s) && !('jev' in s));
check('search: page_text is last', Object.keys(s ?? {}).at(-1) === 'page_text');
check('search: progress per step with story messages', search.progress.length >= 2 && search.progress.every((m) => /Step \d+: /.test(m)), search.progress);
check('search: no inline image on done by default', !search.kinds.includes('image'), search.kinds);
const files = s?.files ?? {};
check('search: files exist on disk (run_dir, screenshot, manifest, page, video?)', ['run_dir', 'screenshot', 'manifest', 'page'].every((k) => files[k] && existsSync(files[k])), files);
check('search: run folder lives under ./.jevway/runs with a readable name', /\.jevway\/runs\/\d{4}-\d\d-\d\d_\d{4}_find-stays-in-lisbon[a-z0-9-]*_[0-9a-f]{4}$/.test(files.run_dir ?? ''), files.run_dir);
check('search: every resource_link points at an existing file', search.links.length >= 3 && search.links.every((l: any) => existsSync(fileOf(l.uri))), search.links.map((l: any) => l.uri));
const manifest = JSON.parse(readFileSync(files.manifest, 'utf8'));
const listed: string[] = (manifest.files ?? manifest).map((f: any) => f.path);
check('search: manifest lists every file with a description', listed.length >= 4 && (manifest.files ?? manifest).every((f: any) => f.path && f.kind && f.description && existsSync(join(files.run_dir, f.path))), listed);
const stepShots = readdirSync(join(files.run_dir, 'steps')).sort();
check('search: step shots have readable names', stepShots.length >= 2 && stepShots.every((n) => /^\d\d-[a-z0-9-]+\.jpg$/.test(n)), stepShots);
const page = readFileSync(files.page, 'utf8');
const embedded = page.match(/<script type="application\/json" id="jevway-summary">([\s\S]*?)<\/script>/)?.[1];
check('search: index.html embeds the summary as JSON', Boolean(embedded) && (() => { try { JSON.parse(embedded!.replace(/\\u003c/g, '<')); return true; } catch { return false; } })());
check('search: index.html shows the goal', page.includes('Find stays in Lisbon'));
const session = s?.session;

// 3. Hand-back: needs_input, image inline
const book = await call('jevway_task', { session, goal: 'Book Casa Flora for the guest using their full name and email address.', values: { full_name: 'Ada Lovelace' }, done_when: 'A booking confirmation with a reference number is showing.' });
check('book: needs_input naming the email field', book.json?.status === 'needs_input' && JSON.stringify(book.json?.missing ?? []).toLowerCase().includes('email'), book.json?.status + ' ' + JSON.stringify(book.json?.missing));
check('book: end page inline as an image on the hand-back', book.kinds.includes('image'), book.kinds);
check('book: next says to add the missing values', /missing|values/i.test(book.json?.next ?? ''), book.json?.next);

// 4. needs_confirmation
const pay = await call('jevway_task', { session, goal: 'Book Casa Flora for the guest using their full name and email address.', values: { email: 'ada@example.com' } });
check('pay: needs_confirmation on the pay button', pay.json?.status === 'needs_confirmation' && /confirm booking/i.test(pay.json?.reason ?? ''), pay.json?.status + ': ' + pay.json?.reason);
check('pay: image inline', pay.kinds.includes('image'));

// 5. Look between calls: no ids, masked, read-only
const look = await call('jevway_look', { session });
check('look: url, title, page_text and elements, without ids', Boolean(look.json?.url && look.json?.page_text && look.json?.elements?.length) && !/"(id|node|rect)":/.test(look.text), Object.keys(look.json ?? {}));

// 6. Confirm and finish, full detail
const confirmed = await call('jevway_task', { session, goal: 'Book Casa Flora for the guest using their full name and email address.', confirm_irreversible: true, confirm_target: 'Casa Flora', detail: 'full', screenshot: true });
check('confirm: done after the confirmed click', confirmed.json?.status === 'done', confirmed.json?.status + ': ' + confirmed.json?.reason);
check('confirm: detail full adds steps and jev stats', Array.isArray(confirmed.json?.steps) && typeof confirmed.json?.jev?.requests === 'number', Object.keys(confirmed.json ?? {}));
check('confirm: screenshot: true attaches the image on done', confirmed.kinds.includes('image'));
const calls = readdirSync(join(files.run_dir, 'calls')).sort();
check('session folder keeps one end shot per call', calls.length >= 4 && calls.every((n) => /^\d\d-[a-z-]+\.jpg$/.test(n)), calls);

// 7. End, then the session is gone with a hint
const ended = await call('jevway_end', { session });
check('end: ok', !ended.result.isError, ended.text);
const gone = await call('jevway_task', { session, goal: 'anything' });
check('gone: isError naming what to do', Boolean(gone.result.isError) && /start a new one with `url`/i.test(gone.text), gone.text);

// 8. Bad input says what to do
const bad = await call('jevway_task', { goal: 'Open something' });
check('bad input: isError with an example call', Boolean(bad.result.isError) && /url/.test(bad.text) && /example|e\.g\./i.test(bad.text), bad.text);

// 9. A journey on the phone fixture
const start = await call('jevway_journey_start', { url: `${base}/journey.html`, device: 'iphone-15' });
const journey = start.json?.journey;
check('journey start: report + screen image', Boolean(journey) && start.kinds.includes('image') && Boolean(start.json?.screen?.type), start.result.isError ? start.text : { kinds: start.kinds, screen: start.json?.screen });
const auto = await call('jevway_journey_autopilot', { journey, screens: 3 });
check('journey autopilot: discovered screens with a per-move log', !auto.result.isError && (auto.json?.discovered?.length ?? 0) >= 1, auto.result.isError || !auto.json ? auto.text.slice(0, 600) : { stopped: auto.json?.stopped, discovered: auto.json?.discovered?.length });
const firstScreen = start.json?.screen?.id;
const annotated = await call('jevway_journey_annotate', { journey, screen: firstScreen, description: 'The home screen of the fixture app.', insight: 'Primary action is clear.' });
check('journey annotate: ok', !annotated.result.isError, annotated.text);
const finish = await call('jevway_journey_finish', { journey });
const viewer = finish.json?.viewer;
check('journey finish: viewer and journey.json exist under ./.jevway/journeys', Boolean(viewer) && existsSync(viewer) && /\.jevway\/journeys\//.test(viewer) && existsSync(finish.json?.journey_json), finish.json);
const shots = viewer ? readdirSync(join(viewer, '..', 'screens')) : [];
check('journey: screen files named by type', shots.length >= 1 && shots.every((n) => /^s\d\d-[a-z-]+\.png$/.test(n)), shots);
check('journey: the viewer embeds the journey JSON', viewer ? /id="jevway-journey"/.test(readFileSync(viewer, 'utf8')) : false);

await client.close();
server.close();
const failed = checks.filter((c) => !c.pass);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed · work dir ${WORK}\n`);
process.exitCode = failed.length ? 1 : 0;
