import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkUploadFiles,
  fetchUploadUrls,
  publicAddress,
  vettedLookup,
  type UploadResponse,
} from '../../src/task/upload-files.ts';

const AVATAR = new URL('../../verify/fixture/capabilities/avatar.png', import.meta.url).pathname;

describe('files the caller declares for upload', () => {
  it('passes a map of absolute, readable files through', () => {
    expect(checkUploadFiles({ avatar: AVATAR })).toEqual({ avatar: AVATAR });
    expect(checkUploadFiles(undefined)).toEqual({});
  });

  it.each([
    ['a relative path', 'verify/fixture/capabilities/avatar.png', /files\.avatar: "verify\/fixture\/capabilities\/avatar\.png" is not an absolute path/],
    ['a missing file', '/no/such/dir/avatar.png', /files\.avatar: "\/no\/such\/dir\/avatar\.png" does not exist/],
    ['a directory', mkdtempSync(join(tmpdir(), 'jevway-upload-')), /files\.avatar: ".*" is not a file/],
  ])('refuses %s, naming its key', (_, path, message) => {
    expect(() => checkUploadFiles({ avatar: path })).toThrow(message);
  });

  it('takes an https URL as it is, to be fetched before the run', () => {
    expect(checkUploadFiles({ cv: 'https://files.example/cv.pdf' })).toEqual({ cv: 'https://files.example/cv.pdf' });
  });

  it.each([
    ['plain http', 'http://files.example/cv.pdf', /files\.cv: "http:\/\/files\.example\/cv\.pdf" is not an https URL/],
    ['a file URL', 'file:///etc/passwd', /files\.cv: "file:\/\/\/etc\/passwd" is not an https URL/],
    ['a URL with a user and password', 'https://ada:pw@files.example/cv.pdf', /files\.cv: ".*" carries a user name or password/],
  ])('refuses %s, naming its key', (_, url, message) => {
    expect(() => checkUploadFiles({ cv: url })).toThrow(message);
  });
});

describe('the addresses a URL upload may reach', () => {
  it.each(['93.184.215.14', '8.8.8.8', '2606:4700::6810:84e5', '172.32.0.1'])('lets %s through', (address) => {
    expect(publicAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
  ])('refuses %s', (address) => {
    expect(publicAddress(address)).toBe(false);
  });

  const lookupOnce = (lookup: ReturnType<typeof vettedLookup>, host: string) =>
    new Promise<{ address: string; family: number }>((resolve, reject) =>
      lookup(host, {}, (error, address, family) => (error ? reject(error) : resolve({ address: address as string, family: family! }))),
    );

  it('connects to the address it checked, and refuses a host with any private address', async () => {
    const resolve = async (host: string) =>
      host === 'files.example'
        ? [{ address: '93.184.215.14', family: 4 }]
        : [
            { address: '93.184.215.14', family: 4 },
            { address: '10.0.0.5', family: 4 },
          ];
    expect(await lookupOnce(vettedLookup(resolve), 'files.example')).toEqual({ address: '93.184.215.14', family: 4 });
    await expect(lookupOnce(vettedLookup(resolve), 'rebind.example')).rejects.toThrow('rebind.example resolves to 10.0.0.5, a private or local address');
  });
});

describe('fetching URL uploads before the run', () => {
  /** A fake `get` serving fixed responses by URL, and every URL it was asked for. */
  const served = (routes: Record<string, { status?: number; headers?: Record<string, string>; bytes?: Buffer; chunks?: Buffer[] }>) => {
    const asked: string[] = [];
    const get = async (url: URL): Promise<UploadResponse> => {
      asked.push(url.href);
      const route = routes[url.href];
      if (!route) throw new Error(`no route for ${url.href}`);
      const chunks = route.chunks ?? (route.bytes ? [route.bytes] : []);
      return {
        status: route.status ?? 200,
        headers: route.headers ?? {},
        body: (async function* () {
          yield* chunks;
        })(),
        close: () => undefined,
      };
    };
    return { get, asked };
  };
  const folder = () => mkdtempSync(join(tmpdir(), 'jevway-uploads-'));
  const PDF = Buffer.from('%PDF-1.4 cv');

  it('saves the file under the name Content-Disposition gives, and swaps the URL for its path', async () => {
    const dir = folder();
    const { get } = served({
      'https://files.example/d/123': { headers: { 'content-disposition': "attachment; filename=\"cv.pdf\"; filename*=UTF-8''Ada%20Lovelace%20CV.pdf" }, bytes: PDF },
    });
    const files = await fetchUploadUrls({ cv: 'https://files.example/d/123', avatar: AVATAR }, { dir, get });
    expect(files).toEqual({ cv: join(dir, 'Ada Lovelace CV.pdf'), avatar: AVATAR });
    expect(readFileSync(files.cv)).toEqual(PDF);
  });

  it('names a file by the URL path when the server gives no name, with a suffix when the name is taken', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'report.csv'), 'older');
    const { get } = served({ 'https://files.example/exports/report.csv?v=2': { bytes: Buffer.from('a,b') } });
    const files = await fetchUploadUrls({ sheet: 'https://files.example/exports/report.csv?v=2' }, { dir, get });
    expect(files.sheet).toBe(join(dir, 'report-2.csv'));
  });

  it('falls back to the key for a URL with no file name, never a path out of the folder', async () => {
    const dir = folder();
    const { get } = served({
      'https://files.example/': { bytes: PDF },
      'https://files.example/x': { headers: { 'content-disposition': 'attachment; filename="../../.ssh/config"' }, bytes: PDF },
    });
    const files = await fetchUploadUrls({ cv: 'https://files.example/', other: 'https://files.example/x' }, { dir, get });
    expect(files.cv).toBe(join(dir, 'cv'));
    expect(files.other).toBe(join(dir, 'config'));
  });

  it('follows up to 3 redirects, each checked again', async () => {
    const dir = folder();
    const { get, asked } = served({
      'https://short.example/cv': { status: 302, headers: { location: 'https://files.example/a' } },
      'https://files.example/a': { status: 301, headers: { location: '/b' } },
      'https://files.example/b': { status: 307, headers: { location: 'https://files.example/cv.pdf' } },
      'https://files.example/cv.pdf': { bytes: PDF },
    });
    const files = await fetchUploadUrls({ cv: 'https://short.example/cv' }, { dir, get });
    expect(files.cv).toBe(join(dir, 'cv.pdf'));
    expect(asked).toHaveLength(4);
  });

  it('refuses a fourth redirect', async () => {
    const { get } = served({
      'https://files.example/1': { status: 302, headers: { location: '/2' } },
      'https://files.example/2': { status: 302, headers: { location: '/3' } },
      'https://files.example/3': { status: 302, headers: { location: '/4' } },
      'https://files.example/4': { status: 302, headers: { location: '/5' } },
    });
    await expect(fetchUploadUrls({ cv: 'https://files.example/1' }, { dir: folder(), get })).rejects.toThrow(
      'files.cv: "https://files.example/1" redirected more than 3 times',
    );
  });

  it('refuses a redirect to plain http', async () => {
    const { get } = served({ 'https://files.example/cv': { status: 302, headers: { location: 'http://files.example/cv' } } });
    await expect(fetchUploadUrls({ cv: 'https://files.example/cv' }, { dir: folder(), get })).rejects.toThrow(
      'files.cv: "https://files.example/cv" redirected to http://files.example/cv, and only https URLs are fetched',
    );
  });

  it("keeps to the run's hosts: the URL and every redirect", async () => {
    const hosts = { allowed: ['files.example'], blocked: [] };
    const { get, asked } = served({ 'https://files.example/cv': { status: 302, headers: { location: 'https://elsewhere.example/cv' } } });
    await expect(fetchUploadUrls({ cv: 'https://other.example/cv' }, { dir: folder(), get, hosts })).rejects.toThrow(
      'files.cv: "https://other.example/cv" is outside this run\'s hosts: other.example is outside the allowed hosts (files.example)',
    );
    expect(asked).toEqual([]);
    await expect(fetchUploadUrls({ cv: 'https://files.example/cv' }, { dir: folder(), get, hosts })).rejects.toThrow(
      'files.cv: "https://files.example/cv" redirected to https://elsewhere.example/cv, which is outside this run\'s hosts',
    );
  });

  it('refuses an answer that is not a success, naming the status', async () => {
    const { get } = served({ 'https://files.example/cv.pdf': { status: 404 } });
    await expect(fetchUploadUrls({ cv: 'https://files.example/cv.pdf' }, { dir: folder(), get })).rejects.toThrow(
      'files.cv: "https://files.example/cv.pdf" answered 404',
    );
  });

  it('refuses a file over the size cap, by its length or while streaming, and leaves nothing behind', async () => {
    const dir = folder();
    const { get } = served({
      'https://files.example/big': { headers: { 'content-length': '2000' }, bytes: Buffer.alloc(10) },
      'https://files.example/sneaky.bin': { chunks: [Buffer.alloc(600), Buffer.alloc(600)] },
    });
    await expect(fetchUploadUrls({ cv: 'https://files.example/big' }, { dir, get, maxBytes: 1000 })).rejects.toThrow(
      'files.cv: "https://files.example/big" is larger than the 1000-byte cap',
    );
    await expect(fetchUploadUrls({ cv: 'https://files.example/sneaky.bin' }, { dir, get, maxBytes: 1000 })).rejects.toThrow(
      'files.cv: "https://files.example/sneaky.bin" is larger than the 1000-byte cap',
    );
    expect(existsSync(join(dir, 'sneaky.bin'))).toBe(false);
  });

  it('fetches a URL once per session: a later call reuses the file', async () => {
    const dir = folder();
    const known = new Map<string, string>();
    const { get, asked } = served({ 'https://files.example/cv.pdf': { bytes: PDF } });
    await fetchUploadUrls({ cv: 'https://files.example/cv.pdf' }, { dir, get, known });
    const again = await fetchUploadUrls({ resume: 'https://files.example/cv.pdf' }, { dir, get, known });
    expect(again.resume).toBe(join(dir, 'cv.pdf'));
    expect(asked).toHaveLength(1);
  });
});
