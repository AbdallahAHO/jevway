import { pageLines } from './checks.ts';

// The quote a `done` carries: Jev chooses one span of the final page's visible text, code copies it word for word.

/** A span of the page's visible text, and the pieces it was joined from (each inside one text node of the page). */
export interface Span {
  text: string;
  lines: string[];
}

/** Jev's Choice takes up to 255 options; fewer keep its probabilities apart. One more option is `absent`. */
export const MAX_SPANS = 100;
const MAX_SPAN_CHARS = 200;
// A text directive this long is quoted by its first and last words, as the text-fragments spec allows.
const LONG_QUOTE_CHARS = 120;
const LONG_QUOTE_WORDS = 10;
const END_WORDS = 5;
// Shorter or repeated quotes could highlight the wrong place, so they get no link.
const LINK_MIN_WORDS = 2;
const LINK_MIN_CHARS = 12;

const SENTENCE_END = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u;
const ENDS_SENTENCE = /[.!?:]$/;
// Inline formatting splits a sentence into several text nodes: the next piece starts lowercase or with punctuation.
const CONTINUES = /^[\p{Ll},.;:!?)\]%]/u;

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);
const normalized = (text: string) => wordsOf(text.normalize('NFKC').toLowerCase()).join(' ');

// A sentence longer than a span is cut at word breaks.
const piecesOf = (sentence: string) => {
  const pieces: string[] = [];
  for (const word of wordsOf(sentence)) {
    const last = pieces.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= MAX_SPAN_CHARS) pieces[pieces.length - 1] = `${last} ${word}`;
    else pieces.push(word);
  }
  return pieces;
};

// Past the cap, neighbours merge in equal groups, so the whole visible text is still offered.
const capped = (spans: Span[]) => {
  if (spans.length <= MAX_SPANS) return spans;
  const size = Math.ceil(spans.length / MAX_SPANS);
  return Array.from({ length: Math.ceil(spans.length / size) }, (_, i) => {
    const group = spans.slice(i * size, (i + 1) * size);
    return { text: group.map((span) => span.text).join(' '), lines: group.flatMap((span) => span.lines) };
  });
};

/**
 * The spans Jev may quote: the page's visible lines (without the reader's own) cut at sentence ends, with a piece that
 * continues the previous one joined to it, each up to 200 characters, and at most `MAX_SPANS`.
 *
 * @example
 * quoteSpans('Lisbon\n245\nproperties found') // [{ text: 'Lisbon', … }, { text: '245 properties found', lines: ['245', 'properties found'] }]
 */
export const quoteSpans = (text: string): Span[] => {
  const spans: Span[] = [];
  for (const piece of pageLines(text).flatMap((line) => line.split(SENTENCE_END).flatMap(piecesOf))) {
    const last = spans.at(-1);
    if (last && CONTINUES.test(piece) && !ENDS_SENTENCE.test(last.text) && last.text.length + 1 + piece.length <= MAX_SPAN_CHARS) {
      last.text = `${last.text} ${piece}`;
      last.lines.push(piece);
    } else spans.push({ text: piece, lines: [piece] });
  }
  return capped(spans);
};

// Everything but ASCII letters, digits and `_.~` is encoded: `-`, `,` and `&` are text-directive syntax.
const encodeTerm = (term: string) =>
  encodeURIComponent(wordsOf(term).join(' ')).replace(/[-!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const startOf = (text: string) => wordsOf(text).slice(0, END_WORDS).join(' ');
const endOf = (text: string) => wordsOf(text).slice(-END_WORDS).join(' ');
const isLong = (text: string) => text.length > LONG_QUOTE_CHARS && wordsOf(text).length > LONG_QUOTE_WORDS;

const occurrences = (needle: string, haystack: string) => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
};

/**
 * A link that opens the page scrolled to the quote and highlights it (a text fragment, `#:~:text=`), keeping the URL's
 * own `#anchor`. A span joined from several pieces is linked by its first and last piece, since one term can't cross
 * the elements between them. A quote under 2 words or 12 characters, or shown more than once, gets no link.
 *
 * @example
 * deepLink('https://ex.test/a#top', { text: 'Booking confirmed', lines: ['Booking confirmed'] }, pageText)
 * // 'https://ex.test/a#top:~:text=Booking%20confirmed'
 */
export const deepLink = (url: string, span: Span, pageText: string): string | undefined => {
  const quote = normalized(span.text);
  if (wordsOf(quote).length < LINK_MIN_WORDS || quote.length < LINK_MIN_CHARS) return undefined;
  if (occurrences(quote, normalized(pageLines(pageText).join(' '))) !== 1) return undefined;
  const first = span.lines[0];
  const last = span.lines.at(-1)!;
  const terms =
    span.lines.length > 1
      ? [isLong(first) ? startOf(first) : first, isLong(last) ? endOf(last) : last]
      : isLong(first)
        ? [startOf(first), endOf(first)]
        : [first];
  const [base, fragment = ''] = url.split(/#(.*)/s);
  const anchor = fragment.split(':~:')[0];
  return `${base}#${anchor}:~:text=${terms.map(encodeTerm).join(',')}`;
};
