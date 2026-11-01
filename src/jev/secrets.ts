/** What stands in for a secret value wherever it would otherwise show: Jev's request, the caller's summary, traces, recordings. */
export const secretMarker = (key: string) => `[secret:${key}]`;

const secretEntries = (values: Record<string, string>, secretKeys: readonly string[]) =>
  Object.entries(values).filter(([key, value]) => secretKeys.includes(key) && value.trim() !== '');

/**
 * The supplied values as Jev may see them: each key the caller marked secret carries its marker, so Jev can still pick
 * the field it belongs in by its name, and never reads the value. With nothing marked, the same object comes back.
 *
 * @example
 * shownValues({ token: 'ghp_x1', repo: 'ada/app' }, ['token']) // { token: '[secret:token]', repo: 'ada/app' }
 */
export const shownValues = (values: Record<string, string>, secretKeys: readonly string[] = []) => {
  const secrets = secretEntries(values, secretKeys);
  if (!secrets.length) return values;
  return { ...values, ...Object.fromEntries(secrets.map(([key]) => [key, secretMarker(key)])) };
};

// How a page may echo a value back: as typed, trimmed, or URL- and form-encoded in an address.
const formsOf = (value: string) => {
  const encoded = encodeURIComponent(value.trim());
  return [value, value.trim(), encodeURIComponent(value), encoded, encoded.replace(/%20/g, '+')];
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * A function that replaces every secret value in a string, or in every string of a plain object or array (keys,
 * numbers and class instances such as an image are left alone), with its key's marker. The business rule: a value the
 * caller marked secret never reaches the model or any output, including when the page echoes it (upper-cased, in an
 * address). Matching is case-insensitive and takes the longest form first, in one pass, so a marker is never scrubbed
 * again. Every non-empty value counts, even a short one: a garbled text is the safe failure, a leaked secret is not.
 * With nothing marked it is the identity.
 *
 * @example
 * const scrub = scrubberFor({ token: 'ghp_x1' }, ['token']);
 * scrub({ page_text: 'Token GHP_X1 created' }) // { page_text: 'Token [secret:token] created' }
 */
export const scrubberFor = (values: Record<string, string>, secretKeys: readonly string[] = []) => {
  const keyByForm = new Map<string, string>();
  for (const [key, value] of secretEntries(values, secretKeys)) {
    for (const form of formsOf(value)) if (form && !keyByForm.has(form.toLowerCase())) keyByForm.set(form.toLowerCase(), key);
  }
  if (!keyByForm.size) return <T>(value: T): T => value;
  const forms = [...keyByForm.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(forms.map(escapeRegExp).join('|'), 'gi');
  const scrubText = (text: string) => text.replace(pattern, (match) => secretMarker(keyByForm.get(match.toLowerCase())!));
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return scrubText(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrub(inner)]));
    return value;
  };
  return <T>(value: T): T => scrub(value) as T;
};
