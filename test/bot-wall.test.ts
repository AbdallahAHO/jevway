import { describe, expect, it } from 'vitest';
import { detectBotWall, findBotWall } from '../src/browser/bot-wall.ts';

// npm's challenge as headless Chrome saw it (verify/out/real-2026-10-18T08-24-16-820Z/npm-1.json).
const NPM_CHALLENGE = {
  title: 'Just a moment...',
  text: [
    'www.npmjs.com',
    'Performing security verification',
    'This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.',
    'Ray ID:',
    'a4c627515b445548',
    'Performance and Security by',
    'Cloudflare',
    'Privacy',
  ].join('\n'),
};

// An article that quotes a challenge line and its Ray ID: two markers, one of them a brand phrase.
const ARTICLE = {
  title: 'Why do sites keep asking me to verify I am human? | Field Notes',
  text: [
    'Field Notes',
    'Why do sites keep asking me to verify I am human?',
    'You open a link and get a grey page: "Verify you are human by completing the action below." At the bottom sits a Ray ID: a string you can quote to the site owner.',
    'Here is what that page checks, and why a VPN makes it show up more often.',
  ].join('\n'),
};

// A Hacker News thread whose top comments are about captchas.
const HN_THREAD = {
  title: 'Ask HN: Are captchas still worth it? | Hacker News',
  text: [
    'Hacker News',
    'new | past | comments | ask | show | jobs | submit',
    'Ask HN: Are captchas still worth it?',
    '212 points by dsco 3 hours ago | hide | past | favorite | 180 comments',
    'rjh29 2 hours ago [–]',
    'We dropped Google Captcha v3 last year. The "I am not a robot" checkbox costs more signups than the bots it stops; captchas mostly punish people on VPNs.',
    'reply',
  ].join('\n'),
};

const SIGN_IN = {
  title: 'Sign in - Forgejo: Beyond coding. We Forge.',
  text: 'Sign in\nUsername or email address\nPassword\nRemember this device\nSign in\nForgot password?\nNeed an account? Register now.',
};

// Google's /sorry page.
const UNUSUAL_TRAFFIC = {
  title: 'https://www.google.com/search?q=flights',
  text: [
    'About this page',
    'Our systems have detected unusual traffic from your computer network. This page checks to see if it’s really you sending the requests, and not a robot.',
    'Why did this happen?',
  ].join('\n'),
};

describe('a bot wall', () => {
  it("is npm's Cloudflare challenge, named with the markers it showed", () => {
    expect(detectBotWall(NPM_CHALLENGE)).toEqual({
      name: 'Cloudflare',
      evidence: ['title "just a moment..."', 'ray id:', 'performance and security by cloudflare', 'performing security verification'],
    });
  });

  it('is never an article that quotes a challenge line and its Ray ID', () => {
    expect(detectBotWall(ARTICLE)).toBeUndefined();
  });

  it('is never a thread that discusses captchas and the "not a robot" checkbox', () => {
    expect(detectBotWall(HN_THREAD)).toBeUndefined();
  });

  it('is never a sign-in page', () => {
    expect(detectBotWall(SIGN_IN)).toBeUndefined();
  });

  it('is never a page titled "Just a moment..." that shows no challenge text', () => {
    expect(detectBotWall({ title: 'Just a moment...', text: 'Loading your dashboard' })).toBeUndefined();
  });

  it("is Google's unusual-traffic page, named after the reCAPTCHA box it shows, or after its wording without one", () => {
    expect(detectBotWall(UNUSUAL_TRAFFIC)?.name).toBe('"unusual traffic" page');
    expect(detectBotWall(UNUSUAL_TRAFFIC, ['reCAPTCHA'])?.name).toBe('reCAPTCHA');
  });

  it('reads only the top of the page: challenge text below the first 600 characters is an article, not a wall', () => {
    const below = { title: 'Notes', text: `${'Lorem ipsum dolor sit amet. '.repeat(30)}\n${NPM_CHALLENGE.text}` };
    expect(detectBotWall(below)).toBeUndefined();
  });

  it('is a large visible challenge box with two challenge lines, named after the box', () => {
    const page = { title: 'Security check', text: 'One more step\nPlease complete the security check to continue.\nVerify you are human' };
    expect(detectBotWall(page, ['hCaptcha'])?.name).toBe('hCaptcha');
    expect(detectBotWall(page)).toBeUndefined();
  });

  it("names a Cloudflare page's Turnstile box", () => {
    expect(detectBotWall(NPM_CHALLENGE, ['Turnstile'])?.name).toBe('Cloudflare (Turnstile)');
  });
});

describe('finding a bot wall on a tab', () => {
  it('asks the page for challenge boxes only when its text already looks like a check', async () => {
    let asked = 0;
    const tab = {
      evaluate: async () => {
        asked++;
        return ['Turnstile'];
      },
    };
    expect(await findBotWall(tab, { title: 'Docs', text: 'Getting started' })).toBeUndefined();
    expect(asked).toBe(0);
    expect((await findBotWall(tab, NPM_CHALLENGE))?.name).toBe('Cloudflare (Turnstile)');
    expect(asked).toBe(1);
  });

  it('still finds the wall from its text when the box read fails', async () => {
    const tab = {
      evaluate: async () => {
        throw new Error('Execution context was destroyed');
      },
    };
    expect((await findBotWall(tab, NPM_CHALLENGE))?.name).toBe('Cloudflare');
  });
});
