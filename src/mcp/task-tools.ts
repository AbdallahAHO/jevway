import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SessionService } from '../session/session-service.ts';
import { CHECKS, type Check } from '../task/checks.ts';
import { errorResult, jsonResult, taskResult, type ImageResponses } from './results.ts';

const STATUSES = ['done', 'needs_input', 'needs_confirmation', 'uncertain', 'blocked', 'step_budget'] as const;
const EXAMPLE_CALL =
  '{"goal":"Find stays in Lisbon for 2 guests","url":"https://stays.example","values":{"city":"Lisbon"},"done_when":"Stays in Lisbon are listed"}';
const EXAMPLE_CHECK = '{"type":"url_contains","text":"/issues/"}';

// Each rule once: the session pattern, consent, files and untrusted page text are in the server's instructions, a
// parameter's rule in that parameter; the long form is docs/reference.md.
const TASK_DESCRIPTION = `Run a whole browser goal with TypeSafe Jev and get one summary. Start with \`url\` (the page where the change is made, not a parent page) or \`tab\`; continue with \`session\`.
Statuses (\`next\` says what to do): done (\`done_when\` passed); needs_input (add the \`missing\` fields to \`values\`); needs_confirmation (the next click looks irreversible: see \`confirm_irreversible\`); uncertain / blocked (read \`reason\` and the screenshot; rephrase \`goal\` or use chrome-devtools; a \`wall\` is for the user to pass, never get past a bot check); step_budget (continue with a narrower goal).
Password fields are never typed: the user types them, then say so in \`goal\`. Closed shadow DOM, canvas: use chrome-devtools.`;

// Advertised loosely (each type's fields are in the description) and checked strictly with CHECKS in the handler: the
// full union would cost ~580 tokens of every tool list.
const CHECKS_INPUT = z
  .array(z.unknown())
  .describe(
    'Facts code checks on the final page: url_contains, title_contains, text_contains, text_absent {text}; url_matches {pattern: glob}; element_exists {name, role?}; value_equals {label, value}; checked {label, state}; count_at_least {min, name?, role?}. A failure turns done into uncertain; [] clears.',
  );

const TASK_INPUT = z.object({
  goal: z
    .string({ error: 'goal: the whole outcome as text, e.g. "Find stays in Lisbon for 2 guests"' })
    .min(1, 'goal: the whole outcome, e.g. "Find stays in Lisbon for 2 guests"')
    .describe('The whole outcome, every filter and choice.'),
  url: z.string().optional().describe('New session in a background tab.'),
  tab: z.string().optional().describe('New session on the open tab whose URL contains this.'),
  session: z.string().optional().describe('Continue this session.'),
  values: z
    .record(z.string(), z.string({ error: 'values holds text only, e.g. {"city":"Lisbon"}' }), {
      error: 'values maps keys to text, e.g. {"city":"Lisbon"}',
    })
    .optional()
    .describe('Every text Jev may type, by key: {"city":"Lisbon"}. Nothing else is typed.'),
  secret_keys: z
    .array(z.string())
    .optional()
    .describe('Keys of values that are secrets: Jev sees only the key; results show [secret:<key>].'),
  files: z
    .record(z.string(), z.string({ error: 'files maps keys to absolute paths, e.g. {"cv":"/Users/ada/cv.pdf"}' }))
    .optional()
    .describe('Files the user asked to upload: key → absolute path.'),
  done_when: z.string().optional().describe('Visible proof of success on the page this call ends on. done needs it.'),
  checks: CHECKS_INPUT.optional(),
  confirm_irreversible: z
    .boolean()
    .optional()
    .describe(
      'Allow one irreversible click, only when the user\'s own request names this action and its target ("unused repos" names none: ask). Only the control the needs_confirmation named, on the call answering it or a new session\'s first call.',
    ),
  confirm_target: z
    .string()
    .optional()
    .describe('The user\'s words naming the target ("ada/scratch"); the page must show them.'),
  max_steps: z.number().int().positive().max(100).optional().describe('Default 40.'),
  max_seconds: z.number().int().positive().max(3600).optional().describe('Default 300.'),
  allowed_hosts: z
    .array(z.string())
    .optional()
    .describe('Hosts the run may be on ("github.com", "*.example.com"); leaving ends it blocked.'),
  blocked_hosts: z.array(z.string()).optional().describe('Hosts never to visit.'),
  allow_coordinate_clicks: z
    .boolean()
    .optional()
    .describe('New session, opt-in: click a screenshot box no listed element matches (canvas).'),
  record: z.boolean().optional().describe('New session: keep a video, step shots and index.html for people.'),
  record_dir: z.string().optional().describe('New session: the run folder (recording on) goes here.'),
  detail: z.enum(['concise', 'full']).optional().describe('full adds raw steps, confidences, Jev stats.'),
  screenshot: z.boolean().optional().describe('Inline the final screenshot on done too.'),
});

// The fields every result has, plus `files`; the rest (missing, wall, checks, evidence, and with detail "full" steps, jev,
// stuck) are open, so a field a later version adds never fails a client's check.
const TASK_OUTPUT = z.looseObject({
  status: z.enum(STATUSES),
  reason: z.string(),
  story: z.array(z.string()),
  next: z.string(),
  session: z.string(),
  url: z.string(),
  title: z.string(),
  files: z.looseObject({ run_dir: z.string(), manifest: z.string() }).optional(),
  page_text: z.string(),
});

const LOOK_OUTPUT = z.looseObject({
  url: z.string(),
  title: z.string(),
  page_text: z.string(),
  elements: z.array(z.unknown()),
});

const END_OUTPUT = z.looseObject({ session: z.string(), run_dir: z.string() });

/** `checks` parsed strictly, or a message naming each bad place and field with a valid check to copy. */
const parseChecks = (checks: unknown): Check[] | undefined => {
  if (checks === undefined) return undefined;
  const parsed = CHECKS.safeParse(checks);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map(
    ({ path, message }) =>
      `\`checks${path.map((key) => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`)).join('')}\`: ${message}`,
  );
  throw new Error(
    `${problems.join('; ')}. A check looks like ${EXAMPLE_CHECK}; see the checks parameter for each type's fields.`,
  );
};

/** Registers `jevway_task`, `jevway_look` and `jevway_end` over the session service. */
export const taskTools = (service: SessionService, { images }: { images: ImageResponses }) => ({
  jevway_task: (server: McpServer) =>
    server.registerTool(
      'jevway_task',
      {
        title: 'Run a browser goal with Jev',
        // Drives any site, and can submit, pay or delete once the caller confirms.
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: TASK_DESCRIPTION,
        inputSchema: TASK_INPUT,
        outputSchema: TASK_OUTPUT,
      },
      async (input, ctx) => {
        try {
          if (!input.session && !input.url && !input.tab) {
            throw new Error(
              `Pass \`url\` (open a new tab), \`tab\` (part of an open tab's URL) or \`session\` (continue one). Example: ${EXAMPLE_CALL}`,
            );
          }
          const checks = parseChecks(input.checks);
          // Each step as progress, in order, all sent before the result: a client shows them and resets its idle timeout.
          const token = ctx.mcpReq._meta?.progressToken;
          let told: Promise<unknown> = Promise.resolve();
          const result = await service.task(
            {
              goal: input.goal,
              url: input.url,
              tab: input.tab,
              session: input.session,
              values: input.values,
              secretKeys: input.secret_keys,
              files: input.files,
              doneWhen: input.done_when,
              checks,
              confirmIrreversible: input.confirm_irreversible,
              confirmTarget: input.confirm_target,
              maxSteps: input.max_steps,
              maxSeconds: input.max_seconds,
              allowedHosts: input.allowed_hosts,
              blockedHosts: input.blocked_hosts,
              allowCoordinateClicks: input.allow_coordinate_clicks,
              record: input.record,
              recordDir: input.record_dir,
            },
            {
              // A client that cancels (or disconnects) stops the run instead of leaving it clicking.
              signal: ctx.mcpReq.signal,
              onEvent: (event) => {
                if (token === undefined || event.type !== 'step') return;
                const params = {
                  progressToken: token,
                  progress: event.n,
                  ...(input.max_steps && { total: input.max_steps }),
                  message: `Step ${event.n}: ${event.story}`,
                };
                told = told
                  .then(() => ctx.mcpReq.notify({ method: 'notifications/progress', params }))
                  .catch(() => undefined);
              },
            },
          );
          await told;
          return taskResult(result, {
            detail: input.detail ?? 'concise',
            screenshot: input.screenshot ?? false,
            images,
          });
        } catch (error) {
          return errorResult('jevway_task', error);
        }
      },
    ),

  jevway_look: (server: McpServer) =>
    server.registerTool(
      'jevway_look',
      {
        title: 'Look at a page without Jev',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
          "Read a page now, no model call, no input: url, title, page_text, the controls with their state, password fields as filled or empty. Pass one of `session`, `tab` (part of a tab's URL) or `url` (opened, read, closed).",
        inputSchema: z.object({
          session: z.string().optional(),
          tab: z.string().optional(),
          url: z.string().optional(),
        }),
        outputSchema: LOOK_OUTPUT,
      },
      async ({ session, tab, url }) => {
        try {
          if ([session, tab, url].filter(Boolean).length !== 1) {
            throw new Error(
              'Pass exactly one of `session`, `tab` or `url`, e.g. {"url":"https://example.com/pricing"} or {"session":"<id from jevway_task>"}.',
            );
          }
          return jsonResult(await service.look({ session, tab, url }));
        } catch (error) {
          return errorResult('jevway_look', error);
        }
      },
    ),

  jevway_end: (server: McpServer) =>
    server.registerTool(
      'jevway_end',
      {
        title: 'End a Jev browser session',
        // Forgets a session and closes the tabs jevway opened: nothing on a site changes.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
          'End a jevway_task session: forget it and close the tabs it opened, unless `keep_tab`. Its run folder stays.',
        inputSchema: z.object({ session: z.string(), keep_tab: z.boolean().optional() }),
        outputSchema: END_OUTPUT,
      },
      async ({ session, keep_tab }) => {
        try {
          const { run_dir } = await service.end(session, { keepTab: keep_tab });
          return jsonResult({ session, ended: true, run_dir });
        } catch (error) {
          return errorResult('jevway_end', error);
        }
      },
    ),
});
