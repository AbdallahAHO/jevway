import { accessSync, constants, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { basename, isAbsolute } from 'node:path';
import { finished } from 'node:stream/promises';
import { safeFileName, uniqueFileName } from '../output/layout.ts';
import { outsideHosts, type HostRules } from './hosts.ts';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MAX_REDIRECTS = 3;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

/** True for a `files` value that is a URL to fetch rather than a local path. */
const isUrl = (value: string) => SCHEME.test(value) && !/^[a-z]:[\\/]/i.test(value);

/**
 * Checks the files a caller declares for upload, before any browser work. Each is an absolute path to a readable regular
 * file, or an `https` URL fetched before the run (`fetchUploadUrls`). They are kept apart from `values`, so typed text
 * can never become a path or a path typed text; the model only ever picks one of these keys. Not restricted to a working
 * directory: the server's own is unrelated to the user's.
 *
 * @example
 * checkUploadFiles({ avatar: '/Users/ada/me.png', cv: 'https://files.example/cv.pdf' }); // as given
 * checkUploadFiles({ avatar: 'me.png' }); // throws: files.avatar: "me.png" is not an absolute path
 */
export const checkUploadFiles = (files: Record<string, string> | undefined): Record<string, string> => {
  for (const [key, path] of Object.entries(files ?? {})) {
    const refuse = (why: string) => {
      throw new Error(`files.${key}: "${path}" ${why}`);
    };
    if (isUrl(path)) {
      const url = URL.canParse(path) ? new URL(path) : undefined;
      if (url?.protocol !== 'https:' || !url.hostname) refuse('is not an https URL');
      if (url!.username || url!.password) refuse('carries a user name or password; put the file on disk instead');
      continue;
    }
    if (!isAbsolute(path)) refuse('is not an absolute path');
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      refuse('does not exist');
    }
    if (!isFile) refuse('is not a file');
    try {
      accessSync(path, constants.R_OK);
    } catch {
      refuse('is not readable');
    }
  }
  return { ...files };
};

/**
 * What the model may know of the declared files: each key with its file's name, never the path.
 *
 * @example
 * fileNames({ avatar: '/Users/ada/me.png' }); // { avatar: 'me.png' }
 */
export const fileNames = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([key, path]) => [key, basename(path)]));

// Every range a fetch for the caller must never reach: this machine, the local network, link-local (cloud metadata),
// carrier-grade NAT, multicast and reserved space, and the IPv6 forms that lead back into them.
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

// An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, `::ffff:7f00:1`) as the IPv4 address it reaches; undefined otherwise.
const mappedIpv4 = (address: string) => {
  const match = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (!match) return undefined;
  if (match[1]) return match[1];
  const high = parseInt(match[2], 16);
  const low = parseInt(match[3], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
};

/**
 * Whether an address is on the public internet: never this machine, a private or link-local network, CGNAT, multicast,
 * reserved space, or an IPv6 form (mapped, NAT64) of one.
 *
 * @example
 * publicAddress('93.184.215.14') // true
 * publicAddress('::ffff:127.0.0.1') // false
 */
export const publicAddress = (address: string): boolean => {
  const mapped = mappedIpv4(address);
  if (mapped) return publicAddress(mapped);
  const family = isIP(address);
  if (!family) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const resolveAll: Resolve = (host) => dnsLookup(host, { all: true });

/**
 * A `lookup` for the HTTPS connection that resolves the host, refuses it when any address is not public, and hands the
 * checked address to the connection, so the name can't resolve elsewhere between the check and the connect.
 *
 * @example
 * request(url, { lookup: vettedLookup() }) // a host resolving to 10.0.0.5 fails: "… resolves to 10.0.0.5, a private or local address"
 */
export const vettedLookup =
  (resolve: Resolve = resolveAll): LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const blocked = addresses.find(({ address }) => !publicAddress(address));
        if (blocked || !addresses.length) {
          callback(new Error(`${hostname} resolves to ${blocked?.address ?? 'nothing'}, a private or local address`), '', 4);
          return;
        }
        if ((options as { all?: boolean }).all) (callback as any)(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (error) => callback(error, '', 4),
    );
  };

/** One HTTPS answer, as `fetchUploadUrls` reads it. */
export interface UploadResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
  /** Drops the connection (the body is not read to its end). */
  close: () => void;
}

/** A GET over HTTPS that connects only to vetted public addresses. */
export type UploadGet = (url: URL, signal?: AbortSignal) => Promise<UploadResponse>;

const httpsGet: UploadGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const outgoing = request(url, { method: 'GET', lookup: vettedLookup(), timeout: FETCH_TIMEOUT_MS, signal, headers: { 'user-agent': 'jevway' } }, (incoming) =>
      resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: incoming, close: () => incoming.destroy() }),
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error(`no answer within ${FETCH_TIMEOUT_MS / 1000} s`)));
    outgoing.on('error', reject);
    outgoing.end();
  });

const header = (headers: UploadResponse['headers'], name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

// The file name a server gives: RFC 5987 `filename*` first, then plain `filename`.
const dispositionName = (disposition: string | undefined) => {
  if (!disposition) return undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(disposition);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      // fall through to the plain name
    }
  }
  return /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean)?.trim();
};

const urlName = (url: URL) => {
  try {
    return decodeURIComponent(url.pathname.split('/').pop() ?? '');
  } catch {
    return url.pathname.split('/').pop() ?? '';
  }
};

/**
 * Fetches every `https` value of `files` into `dir` and returns the files with each URL swapped for its path; local paths
 * pass through. Only `https`, at most 3 redirects, each hop inside `hosts` and connected only to public addresses, at
 * most 50 MB. The name comes from Content-Disposition, else the URL path, made safe, else the key. `known` remembers
 * what a session already fetched. Every error starts with the key and the URL.
 *
 * @example
 * await fetchUploadUrls({ cv: 'https://files.example/cv.pdf' }, { dir: '<run>/uploads' }) // { cv: '<run>/uploads/cv.pdf' }
 */
export const fetchUploadUrls = async (
  files: Record<string, string>,
  {
    dir,
    hosts = { blocked: [] },
    get = httpsGet,
    known = new Map<string, string>(),
    maxBytes = MAX_UPLOAD_BYTES,
    signal,
  }: { dir: string; hosts?: HostRules; get?: UploadGet; known?: Map<string, string>; maxBytes?: number; signal?: AbortSignal },
): Promise<Record<string, string>> => {
  const fetched: Record<string, string> = {};
  for (const [key, value] of Object.entries(files)) {
    if (!isUrl(value)) {
      fetched[key] = value;
      continue;
    }
    const path = known.get(value) ?? (await fetchOne({ key, value, dir, hosts, get, maxBytes, signal }));
    known.set(value, path);
    fetched[key] = path;
  }
  return fetched;
};

const fetchOne = async ({
  key,
  value,
  dir,
  hosts,
  get,
  maxBytes,
  signal,
}: {
  key: string;
  value: string;
  dir: string;
  hosts: HostRules;
  get: UploadGet;
  maxBytes: number;
  signal?: AbortSignal;
}) => {
  const refuse = (why: string): never => {
    throw new Error(`files.${key}: "${value}" ${why}`);
  };
  let url = new URL(value);
  const outside = outsideHosts(url.href, hosts);
  if (outside) refuse(`is outside this run's hosts: ${outside}`);
  for (let redirects = 0; ; redirects++) {
    const response = await get(url, signal).catch((error: Error) => refuse(`could not be fetched: ${error.message}`));
    const location = header(response.headers, 'location');
    if (response.status >= 300 && response.status < 400 && location) {
      response.close();
      if (redirects >= MAX_REDIRECTS) refuse(`redirected more than ${MAX_REDIRECTS} times`);
      const next = new URL(location, url);
      if (next.protocol !== 'https:') refuse(`redirected to ${next.href}, and only https URLs are fetched`);
      if (outsideHosts(next.href, hosts)) refuse(`redirected to ${next.href}, which is outside this run's hosts`);
      url = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      response.close();
      refuse(`answered ${response.status}`);
    }
    if (Number(header(response.headers, 'content-length') ?? 0) > maxBytes) {
      response.close();
      refuse(`is larger than the ${capWords(maxBytes)} cap`);
    }
    mkdirSync(dir, { recursive: true });
    const path = uniqueFileName(dir, safeFileName(dispositionName(header(response.headers, 'content-disposition')) ?? urlName(url), key));
    await save(response, path, maxBytes).catch((error: Error) => {
      rmSync(path, { force: true });
      refuse(error.message === TOO_BIG ? `is larger than the ${capWords(maxBytes)} cap` : `could not be fetched: ${error.message}`);
    });
    return path;
  }
};

const TOO_BIG = 'too big';
const capWords = (bytes: number) => (bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${bytes}-byte`);

// Streams the body to `path`, counting bytes: a body that passes the cap is cut off there.
const save = async (response: UploadResponse, path: string, maxBytes: number) => {
  const out = createWriteStream(path);
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(TOO_BIG);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
  } catch (error) {
    response.close();
    out.destroy();
    throw error;
  }
  out.end();
  await finished(out);
};
