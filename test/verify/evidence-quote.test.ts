import { describe, expect, it } from 'vitest';
import { judgeQuote } from '../../verify/evidence-quote.ts';

const PAGE = 'Staylist\n2 stays in Lisbon\nfor 2 guest(s)\nCasa Flora · €206/night';

describe('the evidence scenario judges a quote on precision, not recall', () => {
  it('passes a quote the final page shows word for word, spacing aside', () => {
    expect(judgeQuote({ quote: '2 stays in Lisbon for 2 guest(s)', confidence: 0.71 }, PAGE)).toEqual({
      pass: true,
      line: 'evidence: "2 stays in Lisbon for 2 guest(s)" (0.71) is on the page',
    });
  });

  it('fails a quote the page does not show verbatim, a changed letter or case included', () => {
    expect(judgeQuote({ quote: '2 stays in lisbon', confidence: 0.8 }, PAGE)).toEqual({
      pass: false,
      line: 'evidence: "2 stays in lisbon" (0.8) is NOT on the final page',
    });
  });

  it('reports a done without a quote as a line, not a failure', () => {
    expect(judgeQuote(undefined, PAGE)).toEqual({ pass: true, line: 'evidence: none (no span cleared the 0.6 bar): a recall miss, not a failure' });
  });
});
