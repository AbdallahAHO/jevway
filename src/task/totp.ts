import { createHmac } from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** An authenticator secret ready to make codes: the shared key and how codes are cut from it (RFC 6238). */
export interface TotpSecret {
  /** The secret as the caller gave it, trimmed. */
  given: string;
  key: Buffer;
  /** The key as canonical base32 (upper case, no padding): scrubbed wherever a page could echo it. */
  base32: string;
  digits: number;
  periodSeconds: number;
  algorithm: TotpAlgorithm;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// RFC 4226 asks for at least 128 bits and recommends 160; real services hand out 80. Fewer is a mistake, such as a code passed as the secret.
const MIN_SECRET_BITS = 80;
const ALGORITHMS: Record<string, TotpAlgorithm> = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };
// A code typed with less than this left in its period could expire before the submit that follows it reaches the server.
const FRESH_FOR_MS = 8_000;

const decodeBase32 = (text: string): { key: Buffer; base32: string } => {
  const base32 = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!base32) throw new Error('is empty: pass the authenticator secret (base32) or its otpauth://totp/ URI');
  if (![...base32].every((char) => BASE32_ALPHABET.includes(char))) {
    throw new Error('is not base32 (letters A–Z and digits 2–7) or an otpauth://totp/ URI');
  }
  const bits = base32.length * 5;
  if (bits < MIN_SECRET_BITS) {
    throw new Error(`is too short for an authenticator secret (${base32.length} characters, at least 16): pass the secret behind the QR code, not a code`);
  }
  const bytes: number[] = [];
  let buffer = 0;
  let held = 0;
  for (const char of base32) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    held += 5;
    if (held >= 8) {
      held -= 8;
      bytes.push((buffer >>> held) & 0xff);
    }
  }
  return { key: Buffer.from(bytes), base32 };
};

const wholeNumberIn = (raw: string | null, name: string, fallback: number, min: number, max: number) => {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) throw new Error(`has ${name} "${raw}" in its URI; it must be ${min} to ${max}`);
  return value;
};

const parseOtpauth = (text: string): Omit<TotpSecret, 'given'> => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('is not a valid otpauth://totp/ URI');
  }
  if (url.protocol !== 'otpauth:' || url.host.toLowerCase() !== 'totp') throw new Error('must be base32 or an otpauth://totp/ URI (counter-based hotp is not supported)');
  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error('has no `secret` in its otpauth URI');
  const algorithmName = url.searchParams.get('algorithm');
  const algorithm = ALGORITHMS[(algorithmName ?? 'SHA1').toUpperCase()];
  if (!algorithm) throw new Error(`has algorithm "${algorithmName}" in its URI; it must be SHA1, SHA256 or SHA512`);
  return {
    ...decodeBase32(secret),
    digits: wholeNumberIn(url.searchParams.get('digits'), 'digits', 6, 6, 8),
    periodSeconds: wholeNumberIn(url.searchParams.get('period'), 'period', 30, 1, 300),
    algorithm,
  };
};

/**
 * Reads an authenticator secret: base32 as apps print it (any case, spaced or hyphenated, padded or not; SHA1, 6 digits,
 * 30 s), or an `otpauth://totp/` URI whose `digits`, `period` and `algorithm` are honoured. Throws a message that never
 * repeats the secret.
 *
 * @example
 * parseTotpSecret('JBSW Y3DP EHPK 3PXP') // { digits: 6, periodSeconds: 30, algorithm: 'sha1', … }
 */
export const parseTotpSecret = (text: string): TotpSecret => {
  const given = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given)) return { given, ...parseOtpauth(given) };
  return { given, ...decodeBase32(given), digits: 6, periodSeconds: 30, algorithm: 'sha1' };
};

/**
 * The caller's `totp` secrets by key, checked before any browser work; a key may not also be one of `values`. An input
 * error names the key (`totp.<key>: …`) and never the secret.
 *
 * @example
 * checkTotpSecrets({ github_otp: 'JBSWY3DPEHPK3PXP' }).get('github_otp')?.digits // 6
 */
export const checkTotpSecrets = (totp: Record<string, string> | undefined, values: Record<string, string> = {}) =>
  new Map(
    Object.entries(totp ?? {}).map(([key, text]) => {
      try {
        if (key in values) throw new Error('is also given in values; pass a key in one of them');
        return [key, parseTotpSecret(text)] as const;
      } catch (error) {
        throw new Error(`totp.${key}: ${(error as Error).message}`);
      }
    }),
  );

/** Each authenticator secret as the scrubber masks it, under its key: as given and as base32. */
export const totpMasks = (authenticators: Map<string, TotpSecret>) =>
  [...authenticators].flatMap(([key, secret]): [string, string][] => [
    [key, secret.given],
    [key, secret.base32],
  ]);

/** The RFC 6238 code for the period that holds `atMs`. */
export const totpCode = (secret: TotpSecret, atMs: number) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / secret.periodSeconds)));
  const mac = createHmac(secret.algorithm, secret.key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** secret.digits).padStart(secret.digits, '0');
};

/**
 * The code to type now: the current one, or, with less than 8 s (a third of a short period) left, the next period's
 * after `pause` waits for it. After the wait the code is for the new period even if the clock reads earlier.
 *
 * @example
 * await typingCode(secret, { now: Date.now, pause: (ms) => limit.pause(ms) }) // '287082'
 */
export const typingCode = async (secret: TotpSecret, { now, pause }: { now: () => number; pause: (ms: number) => Promise<unknown> }) => {
  const at = now();
  const periodMs = secret.periodSeconds * 1000;
  const left = periodMs - (at % periodMs);
  if (left >= Math.min(FRESH_FOR_MS, periodMs / 3)) return totpCode(secret, at);
  await pause(left);
  return totpCode(secret, Math.max(now(), at + left));
};
