import { describe, expect, it } from 'vitest';
import { describeStep } from '../../src/recording/recording.ts';
import { nextFor, presentSummary, storyLine, storyOf, type RunFiles } from '../../src/task/present.ts';
import type { TaskSummary } from '../../src/task/run-task.ts';

const FILES: RunFiles = {
  run_dir: '/work/.jevway/runs/2026-11-02_0905_book-a-stay_3f9a',
  screenshot: '/work/.jevway/runs/2026-11-02_0905_book-a-stay_3f9a/final.jpg',
  manifest: '/work/.jevway/runs/2026-11-02_0905_book-a-stay_3f9a/manifest.json',
};

const JEV = { requests: 6, input_tokens: 41230, median_latency_ms: 312, screenshots: 1, model: 'jev-1.14', est_cost_usd: 0.0124 };

// A realistic search on a stays site: typed, picked a suggestion, set guests, searched, verified.
const doneSummary: TaskSummary = {
  status: 'done',
  reason: 'Completion condition verified: the results list stays in Lisbon for 2 guests',
  url: 'https://stays.example/search?city=Lisbon&guests=2',
  title: 'Stays in Lisbon · Staylist',
  page_text: `Stays in Lisbon\n2 guests · 14 Nov – 17 Nov\n${'Casa do Alfama · €142 a night · 4.8 (312 reviews) · Free cancellation\n'.repeat(18)}`,
  elapsed_ms: 9412,
  steps: [
    { operation: 'TYPE_TEXT', element: 'Where are you going?', value_key: 'city', page_changed: true, value_kept: true, confidence: 0.97 },
    { operation: 'CLICK', element: 'Lisbon, Portugal', page_changed: true, confidence: 0.93 },
    { operation: 'SELECT', element: 'Guests → 2 guests', page_changed: true, confidence: 0.91 },
    { operation: 'CLICK', element: 'Search', page_changed: true, confidence: 0.95 },
  ],
  jev: JEV,
  done_probability: 0.94,
  evidence: { quote: 'Stays in Lisbon', url: 'https://stays.example/search?city=Lisbon&guests=2', confidence: 0.92 },
  checks: [{ type: 'url_contains', text: 'city=Lisbon', pass: true, detail: 'https://stays.example/search?city=Lisbon&guests=2' }],
};

// A sign-up form that wants a value the caller did not supply.
const needsInputSummary: TaskSummary = {
  status: 'needs_input',
  reason: 'No supplied value fits the field "Phone number"',
  url: 'https://shop.example/checkout/details',
  title: 'Your details · Shop',
  page_text: `Your details\nFull name\nEmail address\nPhone number\n${'Delivery options and terms of sale apply. '.repeat(30)}`,
  elapsed_ms: 6120,
  steps: [
    { operation: 'TYPE_TEXT', element: 'Full name', value_key: 'name', page_changed: true, value_kept: true, confidence: 0.96 },
    { operation: 'TYPE_TEXT', element: 'Email address', value_key: 'email', page_changed: true, value_kept: true, confidence: 0.95 },
  ],
  jev: { ...JEV, requests: 4 },
  done_probability: 0.04,
  stuck: {
    operation: 'TYPE_TEXT',
    element: 'Phone number',
    candidates: [
      { element: 'Phone number', probability: 0.81 },
      { element: 'Continue to payment', probability: 0.12 },
      { element: 'Date of birth', probability: 0.04 },
    ],
  },
  missing: [{ label: 'Phone number', role: 'textbox', path: '/checkout/details' }],
};

// A delete that needs the user's confirmation, after a menu and a scroll that moved nothing.
const confirmSummary: TaskSummary = {
  status: 'needs_confirmation',
  reason: 'Clicking "Delete this repository" looks irreversible (risk 0.92) on "ada/scratch · Settings"',
  url: 'http://127.0.0.1:3311/ada/scratch/settings',
  title: 'ada/scratch · Settings',
  page_text: `Settings\nDanger Zone\n${'Transfer ownership · Archive this repository · Delete this repository. '.repeat(25)}`,
  elapsed_ms: 7300,
  steps: [
    { operation: 'CLICK', element: 'Settings', page_changed: true, confidence: 0.94 },
    { operation: 'SCROLL_DOWN', element: 'Scroll down (nothing moved: there is no more to scroll this way)', page_changed: false, confidence: 0.7 },
    { operation: 'CLICK', element: 'Open in new tab (new tab opened: http://127.0.0.1:3311/ada/scratch/settings)', page_changed: true, confidence: 0.88 },
  ],
  jev: { ...JEV, requests: 5 },
  done_probability: 0.08,
  stuck: {
    operation: 'CLICK',
    element: 'Delete this repository',
    candidates: [
      { element: 'Delete this repository', probability: 0.9 },
      { element: 'Archive this repository', probability: 0.06 },
    ],
  },
};

describe('story', () => {
  it('tells each step as a past-tense sentence in the recording page\'s words', () => {
    expect(describeStep({ operation: 'TYPE_TEXT', element: 'Destination', valueKey: 'destination' }, 'done')).toBe(
      'Typed the "destination" value into "Destination"',
    );
    expect(storyOf(doneSummary.steps)).toEqual([
      'Typed the "city" value into "Where are you going?".',
      'Clicked "Lisbon, Portugal".',
      'Chose "2 guests" in "Guests".',
      'Clicked "Search".',
    ]);
  });

  it('says what happened when it was not the plain outcome', () => {
    expect(storyOf(confirmSummary.steps)).toEqual([
      'Clicked "Settings".',
      'Scrolled down to reveal more of the page; nothing moved.',
      'Clicked "Open in new tab"; a new tab opened: http://127.0.0.1:3311/ada/scratch/settings.',
    ]);
    expect(storyLine({ operation: 'TYPE_TEXT', element: 'Search', value_key: 'q', value_kept: false })).toBe(
      'Typed the "q" value into "Search"; the field did not keep the text.',
    );
    expect(storyLine({ operation: 'CLICK', element: 'Save (the page then showed an alert "Saved"; answered OK)' })).toBe(
      'Clicked "Save"; the page then showed an alert "Saved"; answered OK.',
    );
    expect(storyLine({ operation: 'CLICK', element: 'Pay', not_executed: 'could not be reached: another layer covers it' })).toBe(
      'Did not click "Pay": could not be reached: another layer covers it.',
    );
    expect(storyLine({ operation: 'PRESS_ESCAPE', element: 'closed the open popup covering "Search"' })).toBe(
      'Pressed Escape and closed the open popup covering "Search".',
    );
    expect(storyLine({ operation: 'UPLOAD', element: 'Avatar', file_key: 'avatar' })).toBe('Uploaded the "avatar" file into "Avatar".');
  });

  it('shows a secret only as its marker, since steps are scrubbed before they are told', () => {
    const line = storyLine({ operation: 'CLICK', element: 'Copy [secret:token]' });
    expect(line).toBe('Clicked "Copy [secret:token]".');
  });
});

describe('next', () => {
  it('gives one short instruction per status, naming the parameter to change', () => {
    expect(nextFor(needsInputSummary)).toBe('Add the missing values to `values` and call again with this session.');
    expect(nextFor(confirmSummary)).toMatch(/confirm_irreversible: true/);
    expect(nextFor(confirmSummary)).toMatch(/ask the user/i);
    expect(nextFor({ ...doneSummary, status: 'blocked', wall: { kind: 'bot_check', origin: 'https://x.example', name: 'cloudflare' } })).toMatch(
      /ask the user to pass it/i,
    );
    expect(nextFor({ ...doneSummary, status: 'blocked', wall: { kind: 'sign_in', origin: 'https://x.example' } })).toMatch(/sign in at https:\/\/x\.example/i);
    for (const status of ['done', 'uncertain', 'blocked', 'step_budget'] as const) expect(nextFor({ ...doneSummary, status })).toBeTruthy();
  });
});

describe('presentSummary', () => {
  it('is concise by default: the story, the page, the files and what to do next', () => {
    const concise = presentSummary({ session: 'S', summary: needsInputSummary, files: FILES });
    expect(Object.keys(concise)).toEqual(['session', 'status', 'reason', 'next', 'story', 'url', 'title', 'page_text', 'missing', 'files']);
    expect(concise.story).toEqual(['Typed the "name" value into "Full name".', 'Typed the "email" value into "Email address".']);
    expect(concise.files).toEqual(FILES);
  });

  it('adds the raw steps, Jev stats and stuck candidates in full', () => {
    const full = presentSummary({ session: 'S', summary: needsInputSummary, files: FILES }, { detail: 'full' });
    expect(full).toMatchObject({ steps: needsInputSummary.steps, jev: needsInputSummary.jev, stuck: needsInputSummary.stuck, elapsed_ms: 6120, done_probability: 0.04 });
  });

  it('keeps a dropped confirmation in the concise form: the agent must know its consent was not used', () => {
    const concise = presentSummary({ session: 'S', summary: { ...confirmSummary, confirm_ignored: 'the previous call ended done, not needs_confirmation' } });
    expect(concise.confirm_ignored).toBe('the previous call ended done, not needs_confirmation');
  });

  it('costs fewer tokens than the full form on realistic summaries', () => {
    const tokens = (value: unknown) => Math.ceil(JSON.stringify(value, null, 1).length / 4);
    for (const summary of [doneSummary, needsInputSummary, confirmSummary]) {
      const concise = tokens(presentSummary({ session: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', summary, files: FILES }));
      const full = tokens(presentSummary({ session: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', summary, files: FILES }, { detail: 'full' }));
      expect(concise).toBeLessThan(full);
    }
  });
});
