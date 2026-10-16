// A stuck renderer or dropped reply must not hang a run.
const CALL_TIMEOUT_MS = 30_000;

// A wedged browser, or a port held by something else, must not hang the connect.
const OPEN_TIMEOUT_MS = 15_000;

/**
 * Minimal Chrome DevTools Protocol client over Node's global WebSocket.
 * Flattened sessions let one socket drive the browser and every owned tab.
 *
 * @example
 * const cdp = await CdpConnection.open('ws://127.0.0.1:9222/devtools/browser/…');
 * const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
 */
export class CdpConnection {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #listeners = new Set<CdpListener>();
  #closed: { code: number; reason: string } | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method) {
        for (const listener of this.#listeners) listener(message.method, message.params, message.sessionId);
        return;
      }
      const pending = message.id && this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CdpError(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', (event) => {
      this.#closed = { code: event.code, reason: event.reason };
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(this.#closedError());
      }
      this.#pending.clear();
    });
  }

  /**
   * Builds a connection around an existing socket. Used only by tests, to drive the client with a fake socket.
   *
   * @example
   * const cdp = CdpConnection.wrap(fakeSocket as unknown as WebSocket);
   */
  static wrap(socket: WebSocket): CdpConnection {
    return new CdpConnection(socket);
  }

  static open(endpoint: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const timer = setTimeout(() => {
        // Reject first: closing a connecting socket fires its error listener, which would win with the vaguer message.
        reject(new CdpError(`Cannot connect to ${endpoint}: no handshake within ${timeoutMs} ms`));
        try {
          socket.close();
        } catch {}
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpConnection(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new CdpError(`Cannot connect to ${endpoint}`));
        },
        { once: true },
      );
    });
  }

  /** Why the socket closed, or undefined while it is still open. */
  get closed() {
    return this.#closed;
  }

  /** Resolves with the reply; rejects if the socket is closed or no reply comes within `CALL_TIMEOUT_MS`. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    // A WebSocket silently discards send() once it is closing, so a call made then would never settle.
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(this.#closedError());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`${method} timed out after ${CALL_TIMEOUT_MS} ms`));
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  /** Subscribes to protocol events (all sessions); returns an unsubscribe function. */
  onEvent(listener: CdpListener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.#socket.close();
  }

  #closedError() {
    if (!this.#closed) return new CdpError('Browser connection closed');
    const { code, reason } = this.#closed;
    return new CdpError(`Browser connection closed (code ${code}${reason ? `: ${reason}` : ''})`);
  }
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpError extends Error {}

export type CdpListener = (method: string, params: any, sessionId?: string) => void;
