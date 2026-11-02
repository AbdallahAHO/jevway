/** An email as the provider returns it; a listed one has no `text` or `html`. */
export interface ProviderMessage {
  id?: string;
  from?: { name?: string; address?: string };
  subject?: string;
  text?: string;
  html?: string | string[];
  createdAt?: string;
}

const EXCERPT_CHARS = 600;

const htmlOf = (message: ProviderMessage) => [message.html ?? []].flat().join('\n');

const stripHtml = (html: string) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The text part, or the html part without tags when there is no text. */
export const bodyText = (message: ProviderMessage) => message.text || stripHtml(htmlOf(message));

/**
 * The first standalone 4–8 digit number in subject and body: not part of a longer number, a decimal, a date or an id.
 *
 * @example
 * extractCode({ subject: 'Welcome', text: 'Your code is 482913.' }) // '482913'
 */
export const extractCode = (message: ProviderMessage) =>
  `${message.subject ?? ''}\n${bodyText(message)}`.match(/(?<![\w.,/-])\d{4,8}(?!\d|[.,/-]\d)/)?.[0];

// Doctype and namespace URLs and images (logos, tracking pixels) are never the link to follow.
const NOT_A_LINK = /^https?:\/\/www\.w3\.org\/|\.(png|jpe?g|gif|svg|webp|ico)(\?|$)/i;

/** Unique http(s) URLs a person could follow, from the text and html parts, `&amp;` decoded. */
export const extractLinks = (message: ProviderMessage) => {
  const urls = `${message.text ?? ''}\n${htmlOf(message)}`.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  return [...new Set(urls.map((url) => url.replace(/&amp;/g, '&')))].filter((url) => !NOT_A_LINK.test(url));
};

/** Whether the sender (name or address) and subject contain the filters, ignoring case; a missing filter passes. */
export const matchesFilters = (message: ProviderMessage, { from, subject }: { from?: string; subject?: string }) => {
  const sender = `${message.from?.name ?? ''} ${message.from?.address ?? ''}`.toLowerCase();
  return (
    (!from || sender.includes(from.toLowerCase())) &&
    (!subject || (message.subject ?? '').toLowerCase().includes(subject.toLowerCase()))
  );
};

/** `text` with whitespace folded, cut at 600 characters with an ellipsis. */
export const excerpt = (text: string) => {
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length <= EXCERPT_CHARS ? folded : `${folded.slice(0, EXCERPT_CHARS).trimEnd()}…`;
};
