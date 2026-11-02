import { describe, expect, it, vi } from 'vitest';
import { appleScriptString, desktopNotifier } from '../../src/notify/desktop.ts';
import { notificationText, passedText, waitingText, type PersonWall } from '../../src/notify/person-messages.ts';

const CLOUDFLARE: PersonWall = { kind: 'bot_check', check: 'Cloudflare' };
const GITHUB: PersonWall = { kind: 'sign_in', host: 'github.com' };
const GOOGLE: PersonWall = { kind: 'sso', provider: 'Google' };

describe('what the person is told', () => {
  it('says what to do and where, per wall', () => {
    expect(notificationText(CLOUDFLARE)).toBe('Pass the Cloudflare check in the Chrome window');
    expect(notificationText({ kind: 'bot_check', check: '"unusual traffic" page' })).toBe('Pass the "unusual traffic" check in the Chrome window');
    expect(notificationText(GITHUB)).toBe('Sign in to github.com in Chrome');
    expect(notificationText(GOOGLE)).toBe('Finish signing in with Google in Chrome');
  });

  it('counts down while it waits, and says who passed it once it cleared', () => {
    expect(waitingText(CLOUDFLARE, 45)).toBe('Waiting for you to pass the Cloudflare check in the Chrome window (45 s left)');
    expect(waitingText(GITHUB, 120)).toBe('Waiting for you to sign in to github.com in Chrome (120 s left)');
    expect(passedText(CLOUDFLARE)).toBe('A person passed the Cloudflare check');
    expect(passedText(GITHUB)).toBe('A person signed in to github.com');
    expect(passedText(GOOGLE)).toBe('A person finished signing in with Google');
  });
});

describe('the desktop notification', () => {
  const sender = (platform: NodeJS.Platform, env: Record<string, string> = {}) => {
    const run = vi.fn(async (_file: string, _args: string[]) => undefined);
    return { notify: desktopNotifier({ env, platform, run }), run };
  };

  it('shows a macOS notification titled jevway through osascript, never a shell', () => {
    const { notify, run } = sender('darwin');
    notify!('Sign in to github.com in Chrome');
    expect(run).toHaveBeenCalledWith('osascript', ['-e', 'display notification "Sign in to github.com in Chrome" with title "jevway"']);
  });

  it('escapes quotes and backslashes in the AppleScript string', () => {
    expect(appleScriptString('Pass the "unusual traffic" check \\ now')).toBe('"Pass the \\"unusual traffic\\" check \\\\ now"');
  });

  it('uses notify-send on Linux and sends nothing on Windows', () => {
    const linux = sender('linux');
    linux.notify!('Pass the Cloudflare check in the Chrome window');
    expect(linux.run).toHaveBeenCalledWith('notify-send', ['jevway', 'Pass the Cloudflare check in the Chrome window']);
    expect(sender('win32').notify).toBeUndefined();
  });

  it('is off with JEVWAY_NOTIFY=off', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'no']) expect(sender('darwin', { JEVWAY_NOTIFY: value }).notify, value).toBeUndefined();
    expect(sender('darwin', { JEVWAY_NOTIFY: 'on' }).notify).toBeTypeOf('function');
  });

  it('never throws, whether the command is missing or fails', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' });
    });
    const notify = desktopNotifier({ env: {}, platform: 'linux', run })!;
    expect(() => notify('Sign in to github.com in Chrome')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const throwing = desktopNotifier({ env: {}, platform: 'darwin', run: () => { throw new Error('no osascript'); } })!;
    expect(() => throwing('x')).not.toThrow();
  });
});
