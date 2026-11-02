import type { TaskSummary } from './run-task.ts';

/**
 * A question for the person, in the shape agents' ask tools take (AskUserQuestion, request_user_input): `options` map
 * to the tool's choices, `fields` to free-text answers, and `then` says what the agent does with the answer.
 */
export interface AskUser {
  question: string;
  /** At most 12 characters. */
  header: string;
  /** 2–4 choices, in the order they are offered. */
  options?: { label: string; description: string }[];
  /** Free-text answers, each the `values` key it goes under; `options` are the choices the page lists for it. */
  fields?: { key: string; label: string; options?: string[]; secret?: true }[];
  then: string;
}

const LABEL_CHARS = 60;
const OPTION_CHARS = 40;
const HEADER_CHARS = 12;
const MAX_OPTIONS = 4;
const MAX_LISTED_FIELDS = 4;
// Below this, a candidate is noise rather than a real alternative to offer.
const MIN_CANDIDATE_PROBABILITY = 0.05;

const SECRET_LABEL =
  /\b(password|passcode|passphrase|pin|token|api[ _-]?key|secret|cvc|cvv|security code|card number|one[- ]time|otp|2fa)\b/i;

const BOT_CHECK_NAMES: Record<string, string> = {
  cloudflare: 'Cloudflare',
  recaptcha: 'reCAPTCHA',
  hcaptcha: 'hCaptcha',
  turnstile: 'Turnstile',
  'unusual-traffic': "Google's unusual-traffic",
};

const DONE_OR_SKIP = [
  { label: 'Done', description: 'I did it; continue' },
  { label: 'Skip', description: 'Leave it; stop here' },
];
const AFTER_WALL = 'On Done, call again with this session and the same `goal`; on Skip, tell the user the step was not done.';

/** Page text made safe to quote: one line, no control characters or backticks, double quotes as single, cut with `…`. */
const quotable = (text: string, max = LABEL_CHARS) => {
  const line = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069`]/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const headerOf = (label: string) => {
  const words = label.split(' ');
  let header = '';
  for (const word of words) {
    const longer = header ? `${header} ${word}` : word;
    if (longer.length > HEADER_CHARS) break;
    header = longer;
  }
  return header || label.slice(0, HEADER_CHARS);
};

const slugOf = (label: string) =>
  label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[secret:[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');

/** One `values` key per label: its slug, `value_<n>` when it has none, `_2`… when taken. */
const keysFor = (labels: string[]) => {
  const taken = new Set<string>();
  return labels.map((label, i) => {
    const base = slugOf(label) || `value_${i + 1}`;
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
    taken.add(key);
    return key;
  });
};

const listed = (quoted: string[]) => {
  const shown = quoted.length > MAX_LISTED_FIELDS ? [...quoted.slice(0, MAX_LISTED_FIELDS - 1), `${quoted.length - MAX_LISTED_FIELDS + 1} more`] : quoted;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
};

const distinct = (labels: string[]) => [...new Set(labels.filter(Boolean))];

const pageOf = ({ title, url }: Pick<TaskSummary, 'title' | 'url'>) => {
  if (title.trim()) return `"${quotable(title)}"`;
  try {
    const { host, pathname } = new URL(url);
    return quotable(`${host}${pathname === '/' ? '' : pathname}`);
  } catch {
    return quotable(url);
  }
};

const askForMissing = (missing: NonNullable<TaskSummary['missing']>): AskUser => {
  const labels = missing.map(({ label }) => quotable(label.replace(/ \(appears on hover\)$/, '')) || 'the field');
  const keys = keysFor(labels);
  const fields = missing.map(({ options }, i) => {
    const choices = distinct((options ?? []).map((option) => quotable(option, OPTION_CHARS)));
    return {
      key: keys[i],
      label: labels[i],
      ...(choices.length && { options: choices }),
      ...(SECRET_LABEL.test(labels[i]) && { secret: true as const }),
    };
  });
  const [only] = fields;
  const single = fields.length === 1;
  const choices = single ? (only.options ?? []) : [];
  const secretKeys = fields.filter((field) => field.secret).map((field) => `"${field.key}"`);
  return {
    question: `What should I enter for ${listed(labels.map((label) => `"${label}"`))}?`,
    header: single ? headerOf(only.label) : 'Details',
    fields,
    ...(choices.length >= 2 &&
      choices.length <= MAX_OPTIONS && {
        options: choices.map((label) => ({ label, description: `A choice the page lists for "${only.label}"` })),
      }),
    then: `Call again with this session and ${single ? 'the answer' : 'the answers'} in ${keys.map((key) => `\`values.${key}\``).join(', ')}${
      secretKeys.length ? `; list ${secretKeys.join(', ')} in \`secret_keys\`` : ''
    }.`,
  };
};

const askToConfirm = (summary: TaskSummary): AskUser => {
  const element = summary.stuck?.operation === 'CLICK_AT' ? undefined : summary.stuck?.element?.replace(/ \(appears on hover\)$/, '');
  const control = element ? `"${quotable(element)}"` : 'the control boxed on the screenshot';
  return {
    question: `Click ${control} on ${pageOf(summary)}?`,
    header: 'Confirm',
    options: [
      { label: 'Confirm', description: 'Do it: allows this one click' },
      { label: "Don't", description: 'Stop here; nothing is clicked' },
    ],
    then: "On Confirm, call again with this session, `confirm_irreversible: true` and `confirm_target` set to the user's own words naming the target (never the page's); on Don't, tell the user it was not done.",
  };
};

const askWhichOne = (summary: TaskSummary): AskUser | undefined => {
  const { operation, candidates } = summary.stuck ?? { operation: '', candidates: [] };
  const labels = distinct(
    candidates
      .filter(({ probability }) => probability >= MIN_CANDIDATE_PROBABILITY)
      .map(({ element }) => element.replace(/^\[[\d:]+\] /, ''))
      .map((label) => (operation === 'SELECT' ? label.split(' → ').at(-1)! : label))
      .map((label) => quotable(label, OPTION_CHARS)),
  ).slice(0, MAX_OPTIONS);
  if (labels.length < 2) return undefined;
  const question =
    operation === 'CLICK'
      ? `Which one should I click on ${pageOf(summary)}?`
      : operation === 'SELECT'
        ? `Which option should I choose on ${pageOf(summary)}?`
        : 'Which one did you mean?';
  return {
    question,
    header: 'Which one',
    options: labels.map((label) => ({ label, description: `Continue with "${label}"` })),
    then: 'Call again with this session and the chosen one named in `goal`.',
  };
};

const askAtWall = ({ kind, origin, name }: NonNullable<TaskSummary['wall']>): AskUser =>
  kind === 'sign_in'
    ? {
        question: `Sign in to ${quotable(origin)} in the Chrome window jevway uses, then choose Done.`,
        header: 'Sign in',
        options: DONE_OR_SKIP,
        then: AFTER_WALL,
      }
    : {
        question: `Pass the ${(name && BOT_CHECK_NAMES[name]) ?? 'bot'} check in the Chrome window jevway uses, then choose Done.`,
        header: 'Bot check',
        options: DONE_OR_SKIP,
        then: AFTER_WALL,
      };

/**
 * The question a hand-back puts to the person, or none when the agent decides on its own (`done`, `step_budget`, a
 * `blocked` with no wall). Built from the scrubbed summary: only control labels, the title and the URL are quoted,
 * never page prose, and a secret shows only as its marker.
 *
 * @example
 * askUserFor(needsInputSummary)
 * // { question: 'What should I enter for "Email address"?', header: 'Email', fields: [{ key: 'email_address', … }], then: '…`values.email_address`.' }
 */
export const askUserFor = (summary: TaskSummary): AskUser | undefined => {
  switch (summary.status) {
    case 'needs_input':
      return summary.missing?.length ? askForMissing(summary.missing) : undefined;
    case 'needs_confirmation':
      return askToConfirm(summary);
    case 'uncertain':
      return askWhichOne(summary);
    case 'blocked':
      return summary.wall ? askAtWall(summary.wall) : undefined;
    default:
      return undefined;
  }
};
