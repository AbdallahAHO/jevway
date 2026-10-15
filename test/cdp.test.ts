import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpConnection } from '../src/browser/cdp.ts';

/** Just enough of a WebSocket for the client: records what it sends and lets a test play the browser's side. */
const fakeSocket = () => {
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const socket = {
    readyState: WebSocket.OPEN as number,
    sent: [] as any[],
    addEventListener: (type: string, listener: (event: any) => void) => (listeners[type] ??= []).push(listener),
    send: (data: string) => socket.sent.push(JSON.parse(data)),
    close: () => {},
    reply: (message: object) => listeners.message.forEach((listener) => listener({ data: JSON.stringify(message) })),
    drop: (code: number, reason = '') => {
      socket.readyState = WebSocket.CLOSED;
      listeners.close.forEach((listener) => listener({ code, reason }));
    },
  };
  return { socket, cdp: CdpConnection.wrap(socket as unknown as WebSocket) };
};

describe('CdpConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects at once a call made after the connection closed', async () => {
    const { socket, cdp } = fakeSocket();
    socket.drop(1006);
    await expect(cdp.send('Page.captureScreenshot')).rejects.toThrow('Browser connection closed');
    expect(socket.sent).toEqual([]);
  });

  it('rejects a call pending at close with the close code and reason', async () => {
    const { socket, cdp } = fakeSocket();
    const call = cdp.send('Runtime.evaluate');
    const outcome = expect(call).rejects.toThrow('Browser connection closed (code 1006: socket reset)');
    socket.drop(1006, 'socket reset');
    await outcome;
    expect(cdp.closed).toEqual({ code: 1006, reason: 'socket reset' });
  });

  it('rejects a call that gets no reply within the timeout', async () => {
    const { cdp } = fakeSocket();
    const call = cdp.send('Page.captureScreenshot');
    const outcome = expect(call).rejects.toThrow('Page.captureScreenshot timed out after 30000 ms');
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

  it('resolves a replied call and leaves no timer to reject it later', async () => {
    const { socket, cdp } = fakeSocket();
    const call = cdp.send('Target.createTarget', { url: 'about:blank' });
    socket.reply({ id: socket.sent[0].id, result: { targetId: 'T1' } });
    await expect(call).resolves.toEqual({ targetId: 'T1' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
  });
});
