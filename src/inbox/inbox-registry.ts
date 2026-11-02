import { randomUUID } from 'node:crypto';
import {
  createInbox,
  InboxError,
  listMessages,
  PROVIDERS,
  providerOf,
  readMessage,
  waitForMessage,
  type Inbox,
  type InboxClient,
  type Provider,
  type WaitOptions,
} from './inbox.ts';

export type InboxRegistry = ReturnType<typeof createInboxRegistry>;

/**
 * The inboxes one process holds in memory (the MCP server, or the CLI daemon), each named by a UUID and found by
 * that id or its address. They end with the process.
 *
 * @example
 * const inboxes = createInboxRegistry();
 * const { inbox, address } = await inboxes.create();
 * await inboxes.wait(inbox, { from: 'staylist', timeoutMs: 120_000 });
 */
export const createInboxRegistry = (client: InboxClient = {}) => {
  const inboxes = new Map<string, Inbox>();

  const find = (handle: string) => {
    const inbox = inboxes.get(handle) ?? [...inboxes.values()].find(({ address }) => address === handle.toLowerCase());
    if (inbox) return inbox;
    throw new InboxError(
      'unknown_inbox',
      `Unknown inbox "${handle}": inboxes live in memory and end when this jevway process (or its daemon) stops.`,
      'Create a new one with jevway_inbox_create (CLI: jevway inbox create) and sign up again with its address.',
    );
  };

  return {
    async create({ provider }: { provider?: Provider } = {}) {
      const inbox = await createInbox({ ...client, ...(provider && { api: PROVIDERS[provider] }) });
      const id = randomUUID();
      inboxes.set(id, inbox);
      return { inbox: id, address: inbox.address, provider: providerOf(inbox.api) };
    },
    /** The inbox's address; throws `unknown_inbox`. */
    addressOf: (handle: string) => find(handle).address,
    wait: async (handle: string, options: WaitOptions) => waitForMessage(find(handle), { ...client, ...options }),
    list: async (handle: string, options: { signal?: AbortSignal } = {}) => listMessages(find(handle), { ...client, ...options }),
    read: async (handle: string, id: string, options: { signal?: AbortSignal } = {}) => readMessage(find(handle), id, { ...client, ...options }),
  };
};
