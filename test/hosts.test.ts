import { describe, expect, it } from 'vitest';
import { ANY_HOST, hostsFromEnv, narrowHosts, outsideHosts, parseHostPatterns } from '../src/task/hosts.ts';

const allowing = (...allowed: string[]) => narrowHosts(ANY_HOST, { allowed });
const blocking = (...blocked: string[]) => narrowHosts(ANY_HOST, { blocked });

describe('host patterns', () => {
  it('reads exact hosts and *. wildcards, lowercased, punycoded, without a trailing dot, from a list or a comma/space string', () => {
    expect(parseHostPatterns(['EN.Wikipedia.org.', '*.Example.com', 'bücher.de', '127.0.0.1', '[::1]'])).toEqual([
      'en.wikipedia.org',
      '*.example.com',
      'xn--bcher-kva.de',
      '127.0.0.1',
      '[::1]',
    ]);
    expect(parseHostPatterns('a.com, *.b.com  c.com')).toEqual(['a.com', '*.b.com', 'c.com']);
    expect(parseHostPatterns(undefined)).toEqual([]);
    expect(parseHostPatterns('')).toEqual([]);
  });

  it.each(['https://a.com', 'a.com:8080', 'a.com/path', 'a.*.com', '*', '*.', 'a b.com?x', 'user@a.com'])(
    'refuses "%s" instead of ignoring it',
    (pattern) => {
      expect(() => parseHostPatterns([pattern])).toThrow(/is not a host pattern/);
    },
  );
});

describe('the URL check', () => {
  it('passes every URL when no lists are set', () => {
    expect(outsideHosts('https://anywhere.example/x', ANY_HOST)).toBeUndefined();
    expect(outsideHosts('data:text/html,hi', ANY_HOST)).toBeUndefined();
  });

  it('matches an exact host, and a wildcard at any depth but not its apex', () => {
    const rules = allowing('en.wikipedia.org', '*.wikimedia.org');
    expect(outsideHosts('https://en.wikipedia.org/wiki/X', rules)).toBeUndefined();
    expect(outsideHosts('https://EN.WIKIPEDIA.ORG:443/', rules)).toBeUndefined();
    expect(outsideHosts('https://upload.wikimedia.org/a', rules)).toBeUndefined();
    expect(outsideHosts('https://a.b.wikimedia.org/a', rules)).toBeUndefined();
    expect(outsideHosts('https://wikimedia.org/', rules)).toBe('wikimedia.org is outside the allowed hosts (en.wikipedia.org, *.wikimedia.org)');
    expect(outsideHosts('https://de.wikipedia.org/', rules)).toBe('de.wikipedia.org is outside the allowed hosts (en.wikipedia.org, *.wikimedia.org)');
    expect(outsideHosts('https://notwikimedia.org/', rules)).toMatch(/^notwikimedia.org is outside/);
  });

  it('names the blocked pattern, and blocked wins over allowed', () => {
    const rules = narrowHosts(ANY_HOST, { allowed: ['*.example.com'], blocked: ['ads.example.com'] });
    expect(outsideHosts('https://ads.example.com/x', rules)).toBe('ads.example.com is a blocked host (ads.example.com)');
    expect(outsideHosts('https://shop.example.com/x', rules)).toBeUndefined();
    expect(outsideHosts('https://a.tracker.io/', blocking('*.tracker.io'))).toBe('a.tracker.io is a blocked host (*.tracker.io)');
    expect(outsideHosts('https://elsewhere.io/', blocking('*.tracker.io'))).toBeUndefined();
  });

  it('always passes about:blank, about:srcdoc and Chrome error pages', () => {
    const rules = allowing('a.com');
    for (const url of ['about:blank', 'about:srcdoc', 'chrome-error://chromewebdata/']) expect(outsideHosts(url, rules)).toBeUndefined();
  });

  it('judges a blob: URL by its origin, and any other URL without a host as outside an allowed list only', () => {
    const rules = allowing('a.com');
    expect(outsideHosts('blob:https://a.com/1234', rules)).toBeUndefined();
    expect(outsideHosts('blob:https://b.com/1234', rules)).toBe('b.com is outside the allowed hosts (a.com)');
    expect(outsideHosts('data:text/html,hi', rules)).toBe('a data: page has no host, and only a.com are allowed');
    expect(outsideHosts('file:///etc/hosts', rules)).toBe('a file: page has no host, and only a.com are allowed');
    expect(outsideHosts('data:text/html,hi', blocking('b.com'))).toBeUndefined();
  });
});

describe('merging the server, the call and later calls', () => {
  it('reads the server lists from JEV_ALLOWED_HOSTS and JEV_BLOCKED_HOSTS', () => {
    expect(hostsFromEnv({ JEV_ALLOWED_HOSTS: '*.wikipedia.org, en.wiktionary.org', JEV_BLOCKED_HOSTS: 'login.wikipedia.org' })).toEqual({
      allowed: ['*.wikipedia.org', 'en.wiktionary.org'],
      blocked: ['login.wikipedia.org'],
    });
    expect(hostsFromEnv({})).toEqual(ANY_HOST);
  });

  it('adds every blocked list and keeps the newest allowed list when it lies inside the one before', () => {
    const server = hostsFromEnv({ JEV_ALLOWED_HOSTS: '*.wikipedia.org en.wiktionary.org', JEV_BLOCKED_HOSTS: 'a.wikipedia.org' });
    const call = narrowHosts(server, { allowed: ['en.wikipedia.org', '*.m.wikipedia.org'], blocked: ['b.wikipedia.org'] });
    expect(call).toEqual({ allowed: ['en.wikipedia.org', '*.m.wikipedia.org'], blocked: ['a.wikipedia.org', 'b.wikipedia.org'] });
    expect(narrowHosts(server, {})).toEqual(server);
    expect(narrowHosts(server, { allowed: [] })).toEqual(server);
  });

  it.each([
    ['de.wiktionary.org', 'an exact host outside'],
    ['*.wiktionary.org', 'a wildcard wider than an exact host'],
    ['*.org', 'a wildcard wider than a wildcard'],
  ])('refuses %s (%s): a call can only narrow', (pattern) => {
    const server = hostsFromEnv({ JEV_ALLOWED_HOSTS: '*.wikipedia.org en.wiktionary.org' });
    expect(() => narrowHosts(server, { allowed: [pattern] })).toThrow(
      `allowed host "${pattern}" is outside the allowed hosts already set (*.wikipedia.org, en.wiktionary.org); a call can only narrow them`,
    );
  });
});
