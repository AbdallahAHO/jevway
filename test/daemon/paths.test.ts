import { describe, expect, it } from 'vitest';
import { socketPath } from '../../src/daemon/paths.ts';

describe('the daemon socket path', () => {
  it('is daemon.sock in the state dir when that fits the Unix socket limit', () => {
    expect(socketPath('/Users/ada/.cache/jevway', 'darwin')).toBe('/Users/ada/.cache/jevway/daemon.sock');
  });

  it('moves to a short path in the temp dir when the state dir is too deep for a Unix socket (104 bytes on macOS)', () => {
    const deep = `/private/tmp/${'nested-folder/'.repeat(8)}state`;
    const socket = socketPath(deep, 'darwin', '/tmp');
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
    expect(socket).toMatch(/^\/tmp\/jevway-[0-9a-f]{16}\.sock$/);
    // One state dir always maps to the same socket, and another state dir to another one.
    expect(socketPath(deep, 'darwin', '/tmp')).toBe(socket);
    expect(socketPath(`${deep}-2`, 'darwin', '/tmp')).not.toBe(socket);
  });
});
