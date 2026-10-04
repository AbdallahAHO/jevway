import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from './cdp.ts';

/**
 * Where the browser comes from:
 * - `auto`: the user's running Chrome with remote debugging allowed (chrome://inspect).
 *   This is the same Chrome that `chrome-devtools-mcp --auto-connect` drives, so both tools share tabs.
 * - `launch` / `launch-headless`: a throwaway Chrome profile, for CI and verification.
 * - `http://…` or `ws://…`: an explicit debugging endpoint, e.g. Chrome started with `--remote-debugging-port=9222`.
 */
export type BrowserSource = 'auto' | 'launch' | 'launch-headless' | (string & {});

export interface ChromeHandle {
  cdp: CdpConnection;
  close: () => Promise<void>;
}

export const connectChrome = async (source: BrowserSource): Promise<ChromeHandle> => {
  if (source === 'launch' || source === 'launch-headless') return launchChrome(source === 'launch-headless');
  const endpoint = source === 'auto' ? autoEndpoint() : await explicitEndpoint(source);
  const cdp = await CdpConnection.open(endpoint);
  return { cdp, close: async () => cdp.close() };
};

// Chrome writes DevToolsActivePort (port + browser path) when remote debugging is allowed.
const autoEndpoint = () => {
  const file = chromeProfileDirs()
    .map((dir) => join(dir, 'DevToolsActivePort'))
    .find(existsSync);
  if (!file) {
    throw new Error('No running Chrome with remote debugging. Open chrome://inspect/#remote-debugging and allow it.');
  }
  const [port, path] = readFileSync(file, 'utf8').trim().split('\n');
  return `ws://127.0.0.1:${port}${path}`;
};

const chromeProfileDirs = () => {
  const home = homedir();
  if (process.platform === 'darwin') return [join(home, 'Library/Application Support/Google/Chrome')];
  if (process.platform === 'win32') return [join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/User Data')];
  return [join(home, '.config/google-chrome'), join(home, '.config/chromium')];
};

const explicitEndpoint = async (url: string) => {
  if (url.startsWith('ws')) return url;
  const version = await fetch(new URL('/json/version', url)).then((response) => response.json());
  return version.webSocketDebuggerUrl as string;
};

const chromeExecutable = () => {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH.');
  return found;
};

const launchChrome = async (headless: boolean): Promise<ChromeHandle> => {
  const profile = mkdtempSync(join(tmpdir(), 'jev-browse-'));
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1120,780',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const chrome = spawn(chromeExecutable(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await readDevToolsEndpoint(chrome);
  const cdp = await CdpConnection.open(endpoint);
  return {
    cdp,
    close: async () => {
      cdp.close();
      chrome.kill();
      await new Promise((resolve) => chrome.once('exit', resolve));
      rmSync(profile, { recursive: true, force: true });
    },
  };
};

const readDevToolsEndpoint = (chrome: ChildProcess) =>
  new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start within 15s')), 15_000);
    chrome.stderr!.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.once('exit', (code) => reject(new Error(`Chrome exited (${code}) before DevTools started`)));
  });
