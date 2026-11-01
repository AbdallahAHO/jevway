import { describe, expect, it } from 'vitest';
import { scrubberFor, shownValues } from '../src/jev/secrets.ts';

describe('scrubbing secret values', () => {
  it('replaces the value as typed, upper-cased and URL-encoded with its key\'s marker', () => {
    const scrub = scrubberFor({ token: 'ab c/9' }, ['token']);
    expect(scrub('typed ab c/9, shown AB C/9, sent ?t=ab%20c%2F9 or ?t=ab+c%2F9')).toBe(
      'typed [secret:token], shown [secret:token], sent ?t=[secret:token] or ?t=[secret:token]',
    );
  });

  it('matches the trimmed value too', () => {
    expect(scrubberFor({ otp: ' 918273 ' }, ['otp'])('code 918273.')).toBe('code [secret:otp].');
  });

  it('replaces the longer of two overlapping secrets first, in one pass', () => {
    const scrub = scrubberFor({ short: 'secret', long: 'secret-token-1' }, ['short', 'long']);
    expect(scrub('secret-token-1 and secret')).toBe('[secret:long] and [secret:short]');
  });

  it('walks objects and arrays, leaving keys, numbers and class instances alone', () => {
    class Image {
      constructor(readonly data: string) {}
    }
    const image = new Image('k3y');
    const scrub = scrubberFor({ token: 'k3y' }, ['token']);
    const scrubbed = scrub({ k3y: ['a k3y'], n: 3, image, nested: { text: 'K3Y' } });
    expect(scrubbed).toEqual({ k3y: ['a [secret:token]'], n: 3, image, nested: { text: '[secret:token]' } });
    expect(scrubbed.image).toBe(image);
  });

  it('is the identity when nothing is marked, or a marked key has no value', () => {
    const value = { text: 'k3y' };
    expect(scrubberFor({ token: 'k3y' }, [])(value)).toBe(value);
    expect(scrubberFor({ token: 'k3y' }, ['otp'])(value)).toBe(value);
    expect(scrubberFor({ token: '' }, ['token'])(value)).toBe(value);
  });

  it('shows the marker in place of each marked value, and the others as they are', () => {
    expect(shownValues({ token: 'k3y', name: 'Ada' }, ['token'])).toEqual({ token: '[secret:token]', name: 'Ada' });
    const values = { name: 'Ada' };
    expect(shownValues(values, [])).toBe(values);
  });
});
