import { describe, expect, it } from 'vitest';
import { deepLink, MAX_SPANS, quoteSpans, type Span } from '../../src/task/evidence.ts';

const decoded = (link: string) => decodeURIComponent(link.split(':~:text=')[1]);
const oneLine = (text: string): Span => ({ text, lines: [text] });

describe('the spans a done quote is chosen from', () => {
  it('cuts the visible text into lines, without the reader’s own lines', () => {
    const spans = quoteSpans('Loading: 3 placeholder blocks on screen\nPassword field "Password" is empty\nStaylist\nBooking confirmed');
    expect(spans.map((span) => span.text)).toEqual(['Staylist', 'Booking confirmed']);
  });

  it('joins a line that continues the one before it, as inline text split by formatting', () => {
    const spans = quoteSpans('Rosetta Stone\n245\nproperties found\n, sorted by price\nNext page');
    expect(spans.map((span) => span.text)).toEqual(['Rosetta Stone', '245 properties found , sorted by price', 'Next page']);
    expect(spans[1].lines).toEqual(['245', 'properties found', ', sorted by price']);
  });

  it('does not join a lowercase line after a finished sentence', () => {
    expect(quoteSpans('The issue was created.\nlabels: bug').map((span) => span.text)).toEqual(['The issue was created.', 'labels: bug']);
  });

  it('cuts a long line at sentence ends, and a long sentence at word breaks', () => {
    const sentence = 'The Rosetta Stone is a stele of granodiorite inscribed with three versions of a decree issued in 196 BC.';
    const spans = quoteSpans(`${sentence} ${sentence} ${sentence}`);
    expect(spans.map((span) => span.text)).toEqual([sentence, sentence, sentence]);
    const words = 'word '.repeat(100).trim();
    const pieces = quoteSpans(words);
    expect(pieces.every((span) => span.text.length <= 200)).toBe(true);
    expect(pieces.map((span) => span.text).join(' ')).toBe(words);
  });

  it(`offers at most ${MAX_SPANS} spans, merging neighbours so the whole text stays offered`, () => {
    const lines = Array.from({ length: 250 }, (_, i) => `Item ${i + 1}`);
    const spans = quoteSpans(lines.join('\n'));
    expect(spans.length).toBeLessThanOrEqual(MAX_SPANS);
    expect(spans.map((span) => span.text).join(' ')).toBe(lines.join(' '));
  });
});

describe('the link to a quote', () => {
  const url = 'https://example.test/a?x=1&y=2';

  it.each([
    ['a-b & c,d and more', 'a%2Db%20%26%20c%2Cd%20and%20more'],
    ['café 東京 station', 'caf%C3%A9%20%E6%9D%B1%E4%BA%AC%20station'],
    ['100% #1 / (yes?)', '100%25%20%231%20%2F%20%28yes%3F%29'],
  ])('encodes "%s" as a text directive', (quote, encoded) => {
    expect(deepLink(url, oneLine(quote), quote)).toBe(`${url}#:~:text=${encoded}`);
  });

  it('keeps an anchor and replaces an old directive', () => {
    for (const fragment of ['#section', '#section:~:text=old', '#section:~:text=old&text=other']) {
      expect(deepLink(`https://example.test/${fragment}`, oneLine('Booking confirmed'), 'Booking confirmed')).toBe(
        'https://example.test/#section:~:text=Booking%20confirmed',
      );
    }
  });

  it('quotes a long line by its first and last five words', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const link = deepLink(url, oneLine(words.join(' ')), words.join(' '))!;
    const [start, end] = link.split(':~:text=')[1].split(',');
    expect(decodeURIComponent(start)).toBe(words.slice(0, 5).join(' '));
    expect(decodeURIComponent(end)).toBe(words.slice(25).join(' '));
  });

  it('quotes a span of several lines by its first and last line, since one term cannot cross elements', () => {
    const span: Span = { text: '245 properties found', lines: ['245', 'properties found'] };
    const link = deepLink(url, span, 'Lisbon\n245\nproperties found')!;
    expect(link).toBe(`${url}#:~:text=245,properties%20found`);
  });

  it('leaves the link out for a quote too short or repeated to point at one place', () => {
    expect(deepLink(url, oneLine('Saved'), 'Saved')).toBeUndefined();
    expect(deepLink(url, oneLine('Issue created'), 'Issue created\nmore\nIssue  created')).toBeUndefined();
    expect(decoded(deepLink(url, oneLine('Issue created'), 'Issue created\nmore')!)).toBe('Issue created');
  });
});
