/**
 * How the fixture suite judges a done's evidence quote (plan 100). The 0.6 bar makes a quote rare, so a done without one
 * is only reported; a quote that is given must be the final page's own text, word for word (spacing aside), or it fails.
 *
 * @example
 * judgeQuote(summary.evidence, document.body.innerText) // { pass: true, line: 'evidence: "…" (0.71) is on the page' }
 */
export const judgeQuote = (evidence: { quote: string; confidence: number } | undefined, pageText: string) => {
  if (!evidence) return { pass: true, line: 'evidence: none (no span cleared the 0.6 bar): a recall miss, not a failure' };
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  const pass = squash(pageText).includes(squash(evidence.quote));
  return { pass, line: `evidence: "${evidence.quote}" (${evidence.confidence}) ${pass ? 'is on the page' : 'is NOT on the final page'}` };
};
