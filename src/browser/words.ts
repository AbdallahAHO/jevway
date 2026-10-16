// How the words a caller quotes are compared with what a page shows (see `BrowserTask` and `Tab.armConfirm`).

// The words a confirmation names are compared the way a person would: case, accents and spacing set aside.
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const AT_THE_ENDS = /^[\s"'“”‘’`()[\]{}.,;:!?]+|[\s"'“”‘’`()[\]{}.,;:!?]+$/gu;
// Words split on spaces and quotes; `/ . _ -` stay inside, so "ada/scratch" is one word.
const WORD_BREAKS = /[\s,;:!?()"'“”‘’`]+/u;
const MIN_WORD_CHARS = 3;
// Words that join a phrase and name nothing: "the repository named ada/scratch".
const FILLER_WORDS = new Set(['the', 'and', 'for', 'from', 'with', 'its', 'our', 'your', 'their', 'named', 'called', 'titled']);
const wordsOf = (text: string) =>
  normalized(text)
    .split(WORD_BREAKS)
    .map((word) => word.replace(AT_THE_ENDS, ''))
    .filter((word) => word.length >= MIN_WORD_CHARS);

/**
 * Whether the page shows the user's words for the target. The words of the clicked control and filler words describe
 * the action, not its target, so they never count; what is left must be there, every word, and at least one must be.
 * Without that, "delete" would match any page that shows a Delete button.
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
  return specific.length > 0 && specific.every((word) => corpus.includes(word));
};
