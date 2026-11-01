/** Where a run may be: `allowed` undefined means any host; a blocked host is outside even when allowed. */
export interface HostRules {
  allowed?: string[];
  blocked: string[];
}

export const ANY_HOST: HostRules = { blocked: [] };

// Empty documents and Chrome's own error page show nothing from any site: they never leave the hosts.
const ALWAYS_PASSES = /^(about:(blank|srcdoc)\b|chrome-error:)/i;

/**
 * Reads host patterns: an exact host or `*.example.com` (any subdomain, not the apex), from a list or a comma/space
 * separated string. Hosts are compared as URL hostnames (lowercase, punycode, no trailing dot). Anything else (a scheme,
 * port, path, a `*` elsewhere) throws, so a typo never silently widens what a run may reach.
 *
 * @example
 * parseHostPatterns('en.wikipedia.org, *.wikimedia.org'); // ['en.wikipedia.org', '*.wikimedia.org']
 */
export const parseHostPatterns = (input: string | string[] | undefined): string[] =>
  (typeof input === 'string' ? input.split(/[\s,]+/) : (input ?? [])).map((raw) => raw.trim()).filter(Boolean).map(parsePattern);

const parsePattern = (raw: string) => {
  const text = raw.toLowerCase().replace(/\.$/, '');
  const wildcard = text.startsWith('*.');
  const host = wildcard ? text.slice(2) : text;
  const portOrPath = /[*/?#@\s\\]/.test(host) || (host.includes(':') && !host.startsWith('['));
  const hostname = portOrPath || !host ? undefined : hostnameOf(`http://${host}/`);
  if (!hostname) throw new Error(`"${raw}" is not a host pattern: use a host like example.com or *.example.com`);
  return wildcard ? `*.${hostname}` : hostname;
};

const hostnameOf = (url: string) => {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
};

const matches = (host: string, pattern: string) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern);

// Does `outer` let through everything `inner` does?
const covers = (outer: string, inner: string) => {
  if (!inner.startsWith('*.')) return matches(inner, outer);
  return outer.startsWith('*.') && (inner === outer || inner.endsWith(outer.slice(1)));
};

/**
 * Narrows `base` with a newer layer (the call over the server env, a later call over the session): blocked hosts add up,
 * and a newer allowed list replaces the old one only when it lies inside it; one that would widen it throws, naming the
 * pattern. An empty or missing list changes nothing.
 *
 * @example
 * const server = hostsFromEnv(); // JEVWAY_ALLOWED_HOSTS=*.wikipedia.org
 * narrowHosts(server, { allowed: ['en.wikipedia.org'] }); // { allowed: ['en.wikipedia.org'], blocked: [] }
 * narrowHosts(server, { allowed: ['evil.example'] }); // throws: a call can only narrow them
 */
export const narrowHosts = (base: HostRules, layer: { allowed?: string | string[]; blocked?: string | string[] }): HostRules => {
  const allowed = parseHostPatterns(layer.allowed);
  const blocked = [...new Set([...base.blocked, ...parseHostPatterns(layer.blocked)])];
  const wider = base.allowed && allowed.find((pattern) => !base.allowed!.some((outer) => covers(outer, pattern)));
  if (wider) {
    throw new Error(`allowed host "${wider}" is outside the allowed hosts already set (${base.allowed!.join(', ')}); a call can only narrow them`);
  }
  return { ...(allowed.length ? { allowed } : base.allowed && { allowed: base.allowed }), blocked };
};

/** The server's lists, from `JEVWAY_ALLOWED_HOSTS` and `JEVWAY_BLOCKED_HOSTS`; every call starts from these. */
export const hostsFromEnv = (env: Record<string, string | undefined> = process.env): HostRules =>
  narrowHosts(ANY_HOST, { allowed: env.JEVWAY_ALLOWED_HOSTS, blocked: env.JEVWAY_BLOCKED_HOSTS });

/**
 * Says why `url` is outside the rules, naming its host and the list it breaks, or undefined when the run may be there.
 * `about:blank`, `about:srcdoc` and Chrome's error page always pass; a `blob:` URL counts as its origin's host; any other
 * URL without a host is outside an allowed list (and passes a blocked list alone).
 *
 * @example
 * outsideHosts('https://partner.example/x', { allowed: ['shop.example'], blocked: [] });
 * // 'partner.example is outside the allowed hosts (shop.example)'
 */
export const outsideHosts = (url: string, { allowed, blocked }: HostRules): string | undefined => {
  if ((!allowed && !blocked.length) || ALWAYS_PASSES.test(url)) return undefined;
  const host = hostOf(url);
  if (!host) return allowed ? `a ${schemeOf(url)} page has no host, and only ${allowed.join(', ')} are allowed` : undefined;
  const blockedBy = blocked.find((pattern) => matches(host, pattern));
  if (blockedBy) return `${host} is a blocked host (${blockedBy})`;
  if (allowed && !allowed.some((pattern) => matches(host, pattern))) return `${host} is outside the allowed hosts (${allowed.join(', ')})`;
  return undefined;
};

// The host of a URL's origin: http(s) and ws(s) directly, blob: through the origin it wraps; none for data:, file: and the like.
const hostOf = (url: string) => {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? undefined : hostnameOf(origin);
  } catch {
    return undefined;
  }
};

const schemeOf = (url: string) => /^[a-z][\w+.-]*:/i.exec(url)?.[0].toLowerCase() ?? 'malformed';
