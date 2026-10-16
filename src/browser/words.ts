// How the words a caller quotes are compared with what a page shows (see `BrowserTask` and `Tab.armConfirm`).

// The words a confirmation names are compared the way a person would: case, accents and spacing set aside.
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const AT_THE_ENDS = /^[\s"'“”‘’`()[\]{}.,;:!?]+|[\s"'“”‘’`()[\]{}.,;:!?]+$/gu;
// Words split on spaces and quotes; `/ . _ -` stay inside, so "ada/scratch" is one word.
const WORD_BREAKS = /[\s,;:!?()"'“”‘’`]+/u;
const MIN_WORD_CHARS = 3;
// Words that join a phrase and name nothing: "the repository named ada/scratch".
const FILLER_WORDS = new Set(['the', 'and', 'for', 'from', 'with', 'its', 'our', 'your', 'their', 'named', 'called', 'titled']);
// Where a word may end or begin inside the page's text: next to a letter, a digit, "_" or "-" it is part of a longer word,
// and so is a "." that goes on with another character ("v1.2" is not in "v1.2.3").
const LONGER_BEFORE = '(?<![\\p{L}\\p{N}_-])';
const LONGER_AFTER = '(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])';
const appearsWhole = (word: string, text: string) =>
  new RegExp(`${LONGER_BEFORE}${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${LONGER_AFTER}`, 'u').test(text);

const wordsOf = (text: string) =>
  normalized(text)
    .split(WORD_BREAKS)
    .map((word) => word.replace(AT_THE_ENDS, ''))
    .filter((word) => word.length >= MIN_WORD_CHARS);

/**
 * Whether the page shows the user's words for the target. The words of the clicked control and filler words describe
 * the action, not its target, so they never count; what is left must be there, every word, and at least one must be.
 * Without that, "delete" would match any page that shows a Delete button. A word counts where the page has it whole:
 * "app" is not in "apply", nor "ada/scratch" in "ada/scratch-2".
 *
 * @example
 * showsTarget('the repository ada/scratch', 'Delete this repository', ['ada/scratch - Settings']) // true
 * showsTarget('delete', 'Delete this repository', ['ada/scratch - Settings', 'Delete this repository']) // false
 * showsTarget('anything unused', 'Delete this repository', ['ada/scratch - Settings']) // false
 */
export const showsTarget = (target: string, control: string, shown: string[]) => {
  const controlWords = new Set(wordsOf(control));
  const specific = wordsOf(target).filter((word) => !controlWords.has(word) && !FILLER_WORDS.has(word));
  const corpus = shown.map(normalized).join('\n');
  return specific.length > 0 && specific.every((word) => appearsWhole(word, corpus));
};

/**
 * Whether a dialog's message names what the caller confirmed or the control they clicked: every word of either phrase
 * (3+ characters, not filler) is in it, whole. A dialog about something else, like the draft comments a reload would
 * discard, names neither.
 *
 * @example
 * messageNames('Delete the draft?', ['the draft', 'Delete draft']) // true
 * messageNames('Page will be reloaded, but there are draft comments. Continue?', ['Labels', 'Labels']) // false
 */
export const messageNames = (message: string, phrases: string[]) => {
  const text = normalized(message);
  return phrases.some((phrase) => {
    const words = wordsOf(phrase).filter((word) => !FILLER_WORDS.has(word));
    return words.length > 0 && words.every((word) => appearsWhole(word, text));
  });
};
