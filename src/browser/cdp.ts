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
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  #listeners = new Set<CdpListener>();

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
      if (message.error) pending.reject(new CdpError(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const { reject } of this.#pending.values()) reject(new CdpError('Browser connection closed'));
      this.#pending.clear();
    });
  }

  static open(endpoint: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)), { once: true });
      socket.addEventListener('error', () => reject(new CdpError(`Cannot connect to ${endpoint}`)), { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
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
}

export class CdpError extends Error {}

export type CdpListener = (method: string, params: any, sessionId?: string) => void;
