import type { Socket } from 'node:net';

/**
 * The daemon's protocol: newline-delimited JSON over one local socket. A client sends `{ id, method, params }` and
 * may send `{ cancel: id }`; the daemon answers each id with zero or more `{ id, event }` and then one `{ id, result }`
 * or `{ id, error }`. A dropped connection cancels that connection's running calls.
 */
export type Method =
  | 'hello'
  | 'task'
  | 'look'
  | 'end'
  | 'sessions'
  | 'journey.start'
  | 'journey.step'
  | 'journey.autopilot'
  | 'journey.annotate'
  | 'journey.finish'
  | 'stop';

export interface ErrorBody {
  code: string;
  message: string;
  hint: string;
}

export type ClientMessage = { id: number; method: Method; params?: Record<string, any> } | { cancel: number };

export type DaemonMessage = { id: number; event: unknown } | { id: number; result: unknown } | { id: number; error: ErrorBody };

/** What a runner is made of: one per combination, each with its own browser connection. */
export interface RunnerChoice {
  browser: string;
  model?: string;
  screenshots?: string;
}

/** Where a caller's files go, resolved on the caller's side so they land under its working directory. */
export interface Placement {
  outDir: string;
  journeysDir?: string;
  cwd: string;
}

/** The daemon's answer to `hello`. */
export interface Hello {
  version: string;
  fingerprint: string;
  pid: number;
  /** Open task sessions and journeys. */
  sessions: number;
  /** null: never idles out. */
  idle_timeout_s: number | null;
  started_at: string;
}

export const sendLine = (socket: Socket, message: ClientMessage | DaemonMessage) => {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
};

/** Calls `onMessage` with each JSON line the socket receives; a line that does not parse is dropped. */
export const readLines = (socket: Socket, onMessage: (message: any) => void) => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(message);
    }
  });
};
