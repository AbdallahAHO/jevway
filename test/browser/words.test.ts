import { describe, expect, it } from 'vitest';
import { messageNames, showsTarget } from '../../src/browser/words.ts';

describe('the words a confirmation quotes', () => {
  it.each([
    ['app', 'The app settings'],
    ['scratch', 'ada/scratch - Settings'],
    ['v1.2', 'Milestone v1.2, due soon'],
    ['v1.2', 'Milestone v1.2.'],
  ])('finds "%s" in "%s"', (target, shown) => {
    expect(showsTarget(target, 'Delete', [shown])).toBe(true);
  });

  it.each([
    ['app', 'Apply now'],
    ['ada/app', 'ada/app2 - Settings'],
    ['ada/scratch', 'ada/scratch-2 - Settings'],
    ['v1.2', 'Release v1.20'],
    ['v1.2', 'Release v1.2.3'],
  ])('does not find "%s" inside a longer word in "%s"', (target, shown) => {
    expect(showsTarget(target, 'Delete', [shown])).toBe(false);
  });
});

describe('a dialog that names the click the caller confirmed', () => {
  const DRAFT_COMMENTS =
    'Page will be reloaded, but there are draft comments. Continuing to reload will discard the comments. Continue?';

  it.each([
    ['Delete the draft?', ['the draft', 'Delete draft']],
    ['Delete ada/scratch? This cannot be undone.', ['ada/scratch', 'Delete this repository']],
    ['Really delete this repository?', ['ada/app', 'Delete this repository']],
  ])('names it: "%s"', (message, phrases) => {
    expect(messageNames(message, phrases)).toBe(true);
  });

  it.each([
    [DRAFT_COMMENTS, ['Labels', 'Labels']],
    [DRAFT_COMMENTS, ['Safari', 'Comment']],
    ['Delete your account and all its data?', ['profile', 'Save profile']],
    ['Delete the draft?', ['', '']],
    ['Delete the draft?', ['the', 'qq']],
  ])('does not name it: "%s" for %j', (message, phrases) => {
    expect(messageNames(message, phrases)).toBe(false);
  });
});
