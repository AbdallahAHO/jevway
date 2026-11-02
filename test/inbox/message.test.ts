import { describe, expect, it } from 'vitest';
import { bodyText, excerpt, extractCode, extractLinks, matchesFilters } from '../../src/inbox/message.ts';
import { verificationEmail } from './fake-mail.ts';

describe('reading an email', () => {
  it('finds the first standalone 4 to 8 digit code in the subject and text', () => {
    expect(extractCode(verificationEmail())).toBe('482913');
    expect(extractCode({ subject: '7731 is your Example code', text: 'Thanks' })).toBe('7731');
    expect(extractCode({ subject: 'Hi', text: 'Order 12-3456, price 1,250.00, version 2.1.3, call +44 20, code: 90210' })).toBe('90210');
    expect(extractCode({ subject: 'Hi', text: 'Nothing here but 123 and 123456789' })).toBeUndefined();
  });

  it('reads the html when there is no text part, without styles or tags', () => {
    const { text: _text, ...htmlOnly } = verificationEmail();
    expect(bodyText(htmlOnly)).toBe('Your verification code is 482913 . Confirm ns');
    expect(extractCode(htmlOnly)).toBe('482913');
  });

  it('lists each link a person could follow once, entities decoded, images and namespaces dropped', () => {
    expect(extractLinks(verificationEmail())).toEqual(['https://staylist.example/verify?token=abc&user=7']);
  });

  it('matches the sender by name or address and the subject, ignoring case; no filter matches all', () => {
    const summary = { from: { name: 'Staylist', address: 'no-reply@staylist.example' }, subject: 'Verify your Staylist account' };
    expect(matchesFilters(summary, {})).toBe(true);
    expect(matchesFilters(summary, { from: 'STAYLIST' })).toBe(true);
    expect(matchesFilters(summary, { from: 'no-reply@' })).toBe(true);
    expect(matchesFilters(summary, { subject: 'verify' })).toBe(true);
    expect(matchesFilters(summary, { from: 'staylist', subject: 'reset' })).toBe(false);
    expect(matchesFilters(summary, { from: 'other.example' })).toBe(false);
  });

  it('cuts an excerpt of folded whitespace at 600 characters', () => {
    expect(excerpt('Line one\n\n  line   two')).toBe('Line one line two');
    const long = excerpt('word '.repeat(400));
    expect(long.length).toBeLessThanOrEqual(601);
    expect(long.endsWith('…')).toBe(true);
  });
});
