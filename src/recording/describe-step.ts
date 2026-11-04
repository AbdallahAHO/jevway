// The one wording of a step that people read: the recording's shots (what happens next) and a summary's story (what
// happened). Kept apart from the recording so the pages and the story share it without importing the recorder.

/** What Jev is about to do on a screen, in the terms the task loop knows. */
export interface StepIntent {
  operation: string;
  element?: string;
  valueKey?: string;
  /** For UPLOAD: the declared file's key. */
  fileKey?: string;
  option?: string;
  confidence?: number;
}

// Row labels carry a whole table row; a sentence needs its first words.
const shorten = (label: string, max = 70) => {
  const text = label.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
};

// Each verb as Jev is about to do it (`next`, the recording's step shots) and as done (`done`, a summary's story).
const VERBS = {
  click: ['Click', 'Clicked'],
  type: ['Type', 'Typed'],
  choose: ['Choose', 'Chose'],
  press: ['Press', 'Pressed'],
  scroll: ['Scroll', 'Scrolled'],
  wait: ['Wait', 'Waited'],
  upload: ['Upload', 'Uploaded'],
} as const;

/**
 * A step as one plain sentence for people reading a recording (`next`, what happens on this screen) or a summary's
 * story (`done`, what happened).
 *
 * @example
 * describeStep({ operation: 'TYPE_TEXT', element: 'Search traces', valueKey: 'search_query' })
 * // 'Type the "search_query" value into "Search traces"'
 * describeStep({ operation: 'CLICK', element: 'Search' }, 'done') // 'Clicked "Search"'
 */
export const describeStep = ({ operation, element = '', valueKey, fileKey, option }: StepIntent, tense: 'next' | 'done' = 'next') => {
  const target = `"${shorten(element)}"`;
  const verb = (name: keyof typeof VERBS) => VERBS[name][tense === 'next' ? 0 : 1];
  switch (operation) {
    case 'CLICK':
      return `${verb('click')} ${target}`;
    case 'CLICK_AT':
      return `${verb('click')} the control at ${target} by its on-screen position`;
    case 'TYPE_TEXT':
      return valueKey ? `${verb('type')} the "${valueKey}" value into ${target}` : `${verb('type')} text into ${target}`;
    case 'UPLOAD':
      return fileKey ? `${verb('upload')} the "${fileKey}" file into ${target}` : `${verb('upload')} a file into ${target}`;
    case 'SELECT':
      return option ? `${verb('choose')} "${option}" in ${target}` : `${verb('choose')} an option in ${target}`;
    case 'PRESS_ENTER':
      return `${verb('press')} Enter in ${target} to submit it`;
    case 'PRESS_ESCAPE':
      return `${verb('press')} Escape to close the open menu or popup`;
    case 'SCROLL_DOWN':
      return `${verb('scroll')} down to reveal more of the page`;
    case 'SCROLL_UP':
      return `${verb('scroll')} back up`;
    case 'WAIT':
      return `${verb('wait')} for the page to finish updating`;
    // Says itself: "A person passed the Cloudflare check".
    case 'WAIT_FOR_PERSON':
      return element;
    default:
      return `${operation} ${target}`;
  }
};

const PAST = new Map<string, string>(Object.values(VERBS));

/**
 * A recorded step's description (the `next` tense) in the past tense, as a sentence.
 *
 * @example
 * pastTense('Type the "email" value into "Email"') // 'Typed the "email" value into "Email".'
 */
export const pastTense = (description: string) => {
  const [verb] = description.split(' ', 1);
  const told = PAST.has(verb) ? `${PAST.get(verb)}${description.slice(verb.length)}` : description;
  return /[.!?]$/.test(told) ? told : `${told}.`;
};
