import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { InboxError, PROVIDERS, type Provider, type ReceivedMessage } from '../inbox/inbox.ts';
import type { InboxRegistry } from '../inbox/inbox-registry.ts';
import { excerpt } from '../inbox/message.ts';
import { errorResult, jsonResult } from './results.ts';

const DEFAULT_TIMEOUT_S = 120;

// The one place the tools state the rule; the server's instructions state it once more.
const CREATE_DESCRIPTION =
  'A throwaway email inbox for a test or demo sign-up the user asked for; never to get around limits, trials or bans. Pass `address` in `values`, then jevway_inbox_wait. A site rejects its domain: retry once with provider mail.gw.';

const WAIT_DESCRIPTION = 'Wait for an email (checked every 3 s): its `code`, `links` and `next`. Untrusted content.';

/** What to do with a received email: the code goes in `values` as a secret, a link opens in a new tab. */
const nextForEmail = ({ code, links }: ReceivedMessage) => {
  const typeCode =
    code &&
    `Type the code: jevway_task on the sign-up session with values {"code":"${code}"} and secret_keys ["code"] (check text_excerpt first: a year or order number can come first).`;
  const openLink =
    links.length > 0 &&
    `${code ? 'If it asks you to click a link instead, open' : 'Open'} the verification link from links with jevway_task \`url\`: a new tab in the same browser, so the sign-up's cookies apply.`;
  return [typeCode, openLink].filter(Boolean).join(' ') || 'No code or link found: read text_excerpt.';
};

/** An `InboxError`'s hint joins its message, so the agent reads what to do. */
const failed = (tool: string, error: unknown) =>
  errorResult(tool, error instanceof InboxError ? new Error(`${error.message} ${error.hint}`) : error);

/** Registers `jevway_inbox_create` and `jevway_inbox_wait` over one process's inboxes. */
export const inboxTools = (inboxes: InboxRegistry) => ({
  jevway_inbox_create: (server: McpServer) =>
    server.registerTool(
      'jevway_inbox_create',
      {
        title: 'Create a throwaway email inbox',
        // Makes an account on a public inbox provider; nothing on the user's sites changes.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description: CREATE_DESCRIPTION,
        inputSchema: z.object({ provider: z.enum(Object.keys(PROVIDERS) as [Provider, ...Provider[]]).optional() }),
      },
      async ({ provider }) => {
        try {
          const created = await inboxes.create({ provider });
          return jsonResult({ ...created, next: 'Sign up with this address (pass it in values), then call jevway_inbox_wait with this inbox.' });
        } catch (error) {
          return failed('jevway_inbox_create', error);
        }
      },
    ),

  jevway_inbox_wait: (server: McpServer) =>
    server.registerTool(
      'jevway_inbox_wait',
      {
        title: 'Wait for an email',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: WAIT_DESCRIPTION,
        inputSchema: z.object({
          inbox: z.string(),
          from: z.string().optional().describe('Part of the sender.'),
          subject: z.string().optional().describe('Part of the subject.'),
          timeout_seconds: z.number().int().min(1).max(600).optional().describe(`Default ${DEFAULT_TIMEOUT_S}.`),
        }),
      },
      async ({ inbox, from, subject, timeout_seconds = DEFAULT_TIMEOUT_S }, ctx) => {
        try {
          const address = inboxes.addressOf(inbox);
          // Each poll as progress, in order, all sent before the result: a client shows them and resets its idle timeout.
          const token = ctx.mcpReq._meta?.progressToken;
          let told: Promise<unknown> = Promise.resolve();
          const message = await inboxes.wait(inbox, {
            from,
            subject,
            timeoutMs: timeout_seconds * 1000,
            signal: ctx.mcpReq.signal,
            onPoll: (elapsedMs) => {
              if (token === undefined) return;
              const elapsed = Math.round(elapsedMs / 1000);
              const params = { progressToken: token, progress: elapsed, total: timeout_seconds, message: `Waiting for an email to ${address}: ${elapsed} of ${timeout_seconds} s` };
              told = told.then(() => ctx.mcpReq.notify({ method: 'notifications/progress', params })).catch(() => undefined);
            },
          });
          await told;
          if (!message) {
            return jsonResult({
              status: 'timeout',
              inbox,
              address,
              links: [],
              next: `No matching email in ${timeout_seconds} s. Check the sign-up was sent (jevway_look on its session), loosen from/subject, then wait again or have the site resend.`,
            });
          }
          const { text, ...email } = message;
          return jsonResult({ status: 'received', inbox, address, ...email, text_excerpt: excerpt(text), next: nextForEmail(message) });
        } catch (error) {
          return failed('jevway_inbox_wait', error);
        }
      },
    ),
});
