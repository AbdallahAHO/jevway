import { describe, expect, it } from 'vitest';
import { checkTotpSecrets, parseTotpSecret, totpCode, typingCode } from '../../src/task/totp.ts';

// RFC 6238 Appendix B: the seed is "12345678901234567890" repeated to the hash's size (20, 32, 64 bytes), base32 here.
const SEED = {
  sha1: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  sha256: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
  sha512: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
};
const RFC_VECTORS: [seconds: number, sha1: string, sha256: string, sha512: string][] = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];
const uri = (algorithm: string, secret: string) => `otpauth://totp/Example:ada@example.com?secret=${secret}&issuer=Example&algorithm=${algorithm}&digits=8&period=30`;

describe('totp codes', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 test vectors at T=%i for SHA1, SHA256 and SHA512', (seconds, sha1, sha256, sha512) => {
    expect(totpCode(parseTotpSecret(uri('SHA1', SEED.sha1)), seconds * 1000)).toBe(sha1);
    expect(totpCode(parseTotpSecret(uri('SHA256', SEED.sha256)), seconds * 1000)).toBe(sha256);
    expect(totpCode(parseTotpSecret(uri('SHA512', SEED.sha512)), seconds * 1000)).toBe(sha512);
  });

  it('makes 6-digit SHA1 codes with a 30 s period from a bare base32 secret', () => {
    const secret = parseTotpSecret(SEED.sha1);
    expect(secret).toMatchObject({ digits: 6, periodSeconds: 30, algorithm: 'sha1' });
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(totpCode(secret, 1111111109_000)).toBe('081804');
    // The same code for the whole period.
    expect(totpCode(secret, 30_000)).toBe(totpCode(secret, 59_999));
  });

  it('reads a base32 secret the way authenticator apps print it: any case, grouped, padded', () => {
    const plain = totpCode(parseTotpSecret(SEED.sha1), 59_000);
    for (const form of ['gezdgnbvgy3tqojqgezdgnbvgy3tqojq', 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ', 'GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ', ` ${SEED.sha1}== `]) {
      expect(totpCode(parseTotpSecret(form), 59_000)).toBe(plain);
    }
  });

  it('honours digits, period and algorithm from an otpauth URI, and its defaults when they are left out', () => {
    expect(parseTotpSecret(`otpauth://totp/GitHub:ada?secret=${SEED.sha1}&issuer=GitHub`)).toMatchObject({ digits: 6, periodSeconds: 30, algorithm: 'sha1' });
    const custom = parseTotpSecret(`otpauth://totp/x?secret=${SEED.sha256.toLowerCase()}&digits=7&period=60&algorithm=sha256`);
    expect(custom).toMatchObject({ digits: 7, periodSeconds: 60, algorithm: 'sha256' });
    // With a 60 s period, T=59 and T=0 share a counter.
    expect(totpCode(custom, 59_000)).toBe(totpCode(custom, 0));
    expect(totpCode(custom, 59_000)).toHaveLength(7);
  });

  it.each([
    ['', /empty/],
    ['GEZDGNBV!Y3TQOJQ', /not base32/],
    ['123456', /not base32|too short/],
    ['GEZDGNBVGY3T', /too short/],
    ['otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1', /otpauth:\/\/totp\//],
    ['otpauth://totp/x?issuer=Example', /no `secret`/],
    ['otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=4', /digits/],
    ['otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=0', /period/],
    ['otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=MD5', /algorithm/],
    ['https://example.com/?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', /not base32|otpauth/],
  ])('refuses %j', (text, why) => {
    expect(() => parseTotpSecret(text)).toThrow(why);
  });

  it('names the key in an input error and never repeats the secret', () => {
    const bad = 'GEZDGNBV!Y3TQOJQ-SECRETPART';
    let message = '';
    try {
      checkTotpSecrets({ github_otp: bad });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^totp\.github_otp: /);
    expect(message).not.toContain('SECRETPART');
    expect(message).not.toContain('GEZDGNBV');
  });

  it('refuses a key given both as a value and as an authenticator secret', () => {
    expect(() => checkTotpSecrets({ otp: SEED.sha1 }, { otp: '123456' })).toThrow(/^totp\.otp: .*values/);
    expect(checkTotpSecrets({ otp: SEED.sha1 }, { email: 'ada@example.com' }).get('otp')).toMatchObject({ digits: 6 });
    expect(checkTotpSecrets(undefined).size).toBe(0);
  });
});

describe('the code typed now', () => {
  const secret = parseTotpSecret(SEED.sha1);
  const clock = (start: number) => {
    let at = start;
    const pauses: number[] = [];
    return { now: () => at, pause: async (ms: number) => void pauses.push(ms), advance: (ms: number) => (at += ms), pauses };
  };

  it('is the current period\'s code when enough of the period is left', async () => {
    const { now, pause, pauses } = clock(30_000 + 20_000); // 10 s left
    expect(await typingCode(secret, { now, pause })).toBe(totpCode(secret, 50_000));
    expect(pauses).toEqual([]);
  });

  it('waits for the next period when under 8 s are left, and types the next period\'s code', async () => {
    const { now, pause, pauses } = clock(30_000 + 25_500); // 4.5 s left
    const code = await typingCode(secret, { now, pause });
    expect(pauses).toEqual([4_500]);
    // The clock did not move (a stopped run, a frozen test clock): still the next period's code, never the expiring one.
    expect(code).toBe(totpCode(secret, 60_000));
    expect(code).not.toBe(totpCode(secret, 55_500));
  });

  it('uses the clock after the wait when it moved on further', async () => {
    const at = clock(30_000 + 29_000);
    const code = await typingCode(secret, {
      now: at.now,
      pause: async (ms) => {
        at.pauses.push(ms);
        at.advance(ms + 31_000);
      },
    });
    expect(code).toBe(totpCode(secret, 91_000));
  });

  it('keeps the threshold to a third of a short period', async () => {
    const short = parseTotpSecret(`otpauth://totp/x?secret=${SEED.sha1}&period=6`);
    const { now, pause, pauses } = clock(6_000 + 3_500); // 2.5 s left of 6: more than a third, no wait
    await typingCode(short, { now, pause });
    expect(pauses).toEqual([]);
    const late = clock(6_000 + 4_500); // 1.5 s left
    await typingCode(short, late);
    expect(late.pauses).toEqual([1_500]);
  });
});
