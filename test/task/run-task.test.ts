import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpError, type CdpConnection } from '../../src/browser/cdp.ts';
import * as chrome from '../../src/browser/chrome.ts';
import { StalePage, TargetUnreachable, Tab, type PageAction, type PageState } from '../../src/browser/tab.ts';
import { buildActionSpace } from '../../src/jev/action-space.ts';
import { buildRequest, NO_SUPPLIED_FILE, NO_SUPPLIED_VALUE, type Ask } from '../../src/jev/decide.ts';
import * as model from '../../src/jev/model.ts';
import { describeStep, frameDurations, videoOffset } from '../../src/recording/recording.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { createRunner } from '../../src/task/start-task.ts';
import { answer, bookingActions, fakeTab, page, scriptedJev, STAYLIST } from '../fakes.ts';

describe('BrowserTask', () => {
  it('types only the supplied value Jev selects for the chosen field', async () => {
    const { ask } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'DONE', done_check: 0.9 },
    ]);
    const { asTab, acted } = fakeTab();
    const task = new BrowserTask(asTab, ask, {
      goal: 'Enter email',
      values: { email: 'ada@example.com' },
      doneWhen: 'x',
      changeWaitMs: 0,
    });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(acted).toEqual([{ label: 'Email address', text: 'ada@example.com' }]);
  });

  it('hands back needs_input instead of inventing a value, after one retry', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE }]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('needs_input');
    expect(summary.reason).toBe('No supplied value fits the field "Email address"');
    expect(requests).toHaveLength(2);
    expect(acted).toEqual([]);
  });

  it('lets the model pick another step once when no supplied value fits the field it chose', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE },
      { operation: 'CLICK', click_target: '1' },
      { operation: 'DONE', done_check: 0.9 },
    ]);
    const pages = ['a', 'b', 'c', 'd'].map((fingerprint) => page({ fingerprint }));
    const { asTab, acted } = fakeTab(pages);
    const summary = await new BrowserTask(asTab, ask, {
      goal: 'Open the booking',
      doneWhen: 'x',
      values: { name: 'Ada' },
      changeWaitMs: 0,
    }).run();
    expect(summary.status).toBe('done');
    expect(acted).toEqual([{ label: 'Open Full name' }]);
    expect(summary.steps[0]).toMatchObject({
      operation: 'TYPE_TEXT',
      element: 'Email address',
      not_executed: expect.stringContaining('no supplied value fits this field'),
    });
    expect(JSON.stringify(requests[1])).toContain('no supplied value fits this field');
  });

  it('gives each distinct field its own retry before asking the caller', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE },
      { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: NO_SUPPLIED_VALUE },
    ]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 0 }).run();
    expect(summary).toMatchObject({ status: 'needs_input', reason: 'No supplied value fits the field "Full name"' });
    expect(requests).toHaveLength(3);
    expect(acted).toEqual([]);
  });

  it('turns BLOCKED on empty fields without values into needs_input naming them, with no retry', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', value_for_1: 'name', value_for_2: NO_SUPPLIED_VALUE }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 0 }).run();
    expect(summary).toMatchObject({ status: 'needs_input', reason: 'Blocked: no supplied value for "Email address"' });
    expect(requests).toHaveLength(1);
  });

  it('gates an irreversible click until the agent confirms, then allows exactly one', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
    const { asTab, acted } = fakeTab([
      page({ fingerprint: 'a' }),
      page({ fingerprint: 'b' }),
      page({ fingerprint: 'c' }),
    ]);
    const task = new BrowserTask(asTab, ask, { goal: 'Pay', maxSteps: 2 });

    const held = await task.run();
    expect(held.status).toBe('needs_confirmation');
    expect(held.reason).toContain('"Confirm booking and pay €412" on "Staylist" looks irreversible');
    expect(held.reason).toContain("Confirm only if the user's request named this action and this target;");
    expect(held.reason).toContain('a category ("anything unused", "old ones") names no target: list the candidates and ask the user.');
    expect(held.reason).toContain("To continue, call again with confirm_irreversible and confirm_target (the user's words naming the target).");
    expect(acted).toEqual([]);

    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
    expect(summary.status).toBe('needs_confirmation');
  });

  it('names the page a risky click is on, cut to 80 characters, and leaves it out when the page has no title', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
    const long = 'Repository - ada/scratch - ' + 'x'.repeat(200);
    const titled = await new BrowserTask(fakeTab([page({ title: long })]).asTab, ask, { goal: 'Pay' }).run();
    expect(titled.reason).toContain(`on "${long.slice(0, 80)}" looks irreversible`);
    expect(titled.reason).not.toContain(long.slice(0, 81));
    const untitled = await new BrowserTask(fakeTab([page({ title: '' })]).asTab, ask, { goal: 'Pay' }).run();
    expect(untitled.reason).toContain('"Confirm booking and pay €412" looks irreversible');
  });

  describe('a new session started through the runner', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const startWith = async (confirmIrreversible?: boolean, confirmTarget?: string) => {
      vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
      const { asTab, acted } = fakeTab();
      vi.spyOn(model, 'createAsk').mockReturnValue(ask);
      vi.spyOn(chrome, 'connectChrome').mockResolvedValue({ cdp: {} } as chrome.ChromeHandle);
      vi.spyOn(Tab, 'open').mockResolvedValue(asTab);
      const task = await createRunner('launch-headless').start({
        goal: 'Pay',
        url: 'http://fixture/pay',
        maxSteps: 1,
        confirmIrreversible,
        confirmTarget,
        changeWaitMs: 0,
      });
      return { summary: await task.run(), acted };
    };

    it('clicks the irreversible target once when the first call already carries the confirmation', async () => {
      const { summary, acted } = await startWith(true, STAYLIST);
      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
      expect(summary.status).not.toBe('needs_confirmation');
    });

    it('still hands the irreversible click back without the confirmation', async () => {
      const { summary, acted } = await startWith();
      expect(summary.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
    });
  });

  describe('a confirmation counts only when it answers a needs_confirmation', () => {
    const pay = { operation: 'CLICK', click_target: '4', commit_risk: 0.9 };
    const unsure = { operation: 'CLICK', click_target: '1', confidence: 0.1 };
    const noValueForEmail = { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE };
    const pages = () => Array.from({ length: 12 }, (_, i) => page({ fingerprint: String(i) }));
    const options = { goal: 'Pay', values: { name: 'Ada' }, maxSteps: 1, changeWaitMs: 0 };

    it('clicks the risky target when the call right after a needs_confirmation carries the flag', async () => {
      const { ask } = scriptedJev([pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);

      expect((await task.run()).status).toBe('needs_confirmation');
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();

      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
      expect(summary.confirm_ignored).toBeUndefined();
    });

    it('clicks the risky target when a new session\'s first call carries the flag', async () => {
      const { ask } = scriptedJev([pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);

      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();

      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
      expect(summary.confirm_ignored).toBeUndefined();
    });

    it('ignores the flag on a call that follows an uncertain hand-back, and says so once', async () => {
      const { ask } = scriptedJev([unsure, pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);

      expect((await task.run()).status).toBe('uncertain');
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const ignored = await task.run();

      expect(ignored.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
      expect(ignored.confirm_ignored).toBe('the previous call ended uncertain, not needs_confirmation');

      const next = await task.run();
      expect(next.confirm_ignored).toBeUndefined();
    });

    it('ignores the flag on a call that follows a done, after an earlier confirmation was used', async () => {
      const { ask } = scriptedJev([pay, pay, { operation: 'DONE' }, pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, { ...options, maxSteps: 5 });

      expect((await task.run()).status).toBe('needs_confirmation');
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const finished = await task.run();
      expect(finished.status).toBe('done');
      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);

      task.update({ goal: 'Pay again', confirmIrreversible: true, confirmTarget: STAYLIST });
      const again = await task.run();

      expect(again.status).toBe('needs_confirmation');
      expect(acted).toHaveLength(1);
      expect(again.confirm_ignored).toBe('the previous call ended done, not needs_confirmation');
    });

    it('keeps a confirmation the first call gave through a needs_input, until a risky click uses it', async () => {
      const { ask } = scriptedJev([noValueForEmail, noValueForEmail, pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);

      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const asked = await task.run();
      expect(asked).toMatchObject({ status: 'needs_input', reason: 'No supplied value fits the field "Email address"' });
      expect(acted).toEqual([]);

      task.update({ values: { email: 'ada@example.com' }, confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();

      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
      expect(summary.confirm_ignored).toBeUndefined();
    });
  });

  describe('a confirmation allows only the control it answered', () => {
    const PAY = 'Confirm booking and pay €412';
    const CANCEL = 'Cancel my reservation';
    const cancelButton: PageAction = { id: 'e6', kind: 'click', node: 5, role: 'button', label: CANCEL };
    const twoRisky = (fingerprint: string, url = 'http://fixture/stays') =>
      page({ url, actions: [...bookingActions, cancelButton], fingerprint });
    // The first call's page, then every later observation on `laterUrl`.
    const pagesOn = (firstUrl: string, laterUrl = firstUrl) =>
      Array.from({ length: 12 }, (_, i) => twoRisky(String(i), i === 0 ? firstUrl : laterUrl));
    const pay = { operation: 'CLICK', click_target: '4', commit_risk: 0.9 };
    const cancel = { operation: 'CLICK', click_target: '5', commit_risk: 0.9 };
    const options = { goal: 'Pay for the Staylist booking', maxSteps: 1, changeWaitMs: 0 };
    const flaggedThen = async (steps: Record<string, any>[], pages = pagesOn('http://fixture/stays')) => {
      const { ask } = scriptedJev(steps);
      const { asTab, acted } = fakeTab(pages);
      const task = new BrowserTask(asTab, ask, options);
      const flagged = await task.run();
      expect(flagged.reason).toMatch(new RegExp(`^Clicking "${PAY}"`));
      return { task, acted };
    };

    it('clicks the control that was flagged', async () => {
      const { task, acted } = await flaggedThen([pay, pay]);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
    });

    it('hands back a different risky control, naming it and the one confirmed, and clicks nothing', async () => {
      const { task, acted } = await flaggedThen([pay, cancel]);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toMatch(new RegExp(`^Clicking "${CANCEL}" on "Staylist" looks irreversible`));
      expect(summary.reason).toContain(`The confirmation given was for "${PAY}" on /stays, a different control, so it was not used.`);
      expect(summary.reason).toContain('To continue, call again with confirm_irreversible and confirm_target');
      expect(acted).toEqual([]);
    });

    it('lets the agent confirm the new control in turn, and then clicks only that one', async () => {
      const { task, acted } = await flaggedThen([pay, cancel, cancel]);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: CANCEL }]);
    });

    it('spends the old confirmation when it hands back the different control', async () => {
      const { task, acted } = await flaggedThen([pay, cancel, pay]);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      const after = await task.run();
      expect(after.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
    });

    it('treats the same label on another page path as another control', async () => {
      const { task, acted } = await flaggedThen([pay, pay], pagesOn('http://fixture/stays/41', 'http://fixture/stays/42'));
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toContain(`The confirmation given was for "${PAY}" on /stays/41, a different control`);
      expect(acted).toEqual([]);
    });

    it('treats a changed query string as the same page, as a single-page app rewrites it', async () => {
      const { task, acted } = await flaggedThen([pay, pay], pagesOn('http://fixture/stays?tab=1', 'http://fixture/stays?tab=2#top'));
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
    });

    it('lets a new session\'s first-call confirmation, which answers no flagged control, click either one', async () => {
      const { ask } = scriptedJev([cancel]);
      const { asTab, acted } = fakeTab(pagesOn('http://fixture/stays'));
      const task = new BrowserTask(asTab, ask, options);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: CANCEL }]);
    });
  });

  describe('a confirmation must name its target in the user\'s words', () => {
    const DELETE = 'Delete this repository';
    const scratchPage = (fingerprint: string, overrides: Partial<PageState> = {}) =>
      page({
        url: 'http://fixture/ada/scratch/settings',
        title: 'ada/scratch - Settings',
        text: `Danger zone\n${DELETE}`,
        actions: [{ id: 'e1', kind: 'click', node: 1, role: 'button', label: DELETE }],
        fingerprint,
        ...overrides,
      });
    const manyPages = (make: (fingerprint: string) => PageState) => Array.from({ length: 12 }, (_, i) => make(String(i)));
    const deleteIt = { operation: 'CLICK', click_target: '1', commit_risk: 0.9 };
    const options = { goal: 'Delete the repository ada/scratch', maxSteps: 1, changeWaitMs: 0 };
    // The run has asked whether to delete, and waits for the calling agent's answer.
    const askedToDelete = async (make = scratchPage) => {
      const { ask } = scriptedJev([deleteIt]);
      const { asTab, acted } = fakeTab(manyPages(make));
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('needs_confirmation');
      return { task, acted };
    };
    const refusalFor = (target: string, title = 'ada/scratch - Settings') =>
      `confirm_target "${target}" names nothing "${DELETE}" acts on here (page "${title}", its address, the visible text or the values typed on this page); ask the user which one they mean.`;

    it.each(['ada/scratch', 'the repository ada/scratch', 'the repository named "ada/scratch"', '"Ada/Scratch".'])(
      'clicks when the target is shown by the page title: %s',
      async (confirmTarget) => {
        const { task, acted } = await askedToDelete();
        task.update({ confirmIrreversible: true, confirmTarget });
        await task.run();
        expect(acted).toEqual([{ label: DELETE }]);
      },
    );

    it('refuses a confirmation that carries no target, and clicks nothing', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true });
      const summary = await task.run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toBe(`confirm_irreversible needs confirm_target: the words from the user's request that name what "${DELETE}" acts on.`);
      expect(acted).toEqual([]);
    });

    it('refuses a first call whose confirmation carries no target', async () => {
      const { ask } = scriptedJev([deleteIt]);
      const { asTab, acted } = fakeTab(manyPages(scratchPage));
      const task = new BrowserTask(asTab, ask, options);
      task.update({ confirmIrreversible: true });
      const summary = await task.run();
      expect(summary.reason).toContain('confirm_irreversible needs confirm_target');
      expect(acted).toEqual([]);
    });

    it.each(['anything unused', 'anything that looks unused'])('refuses a category: %s names nothing on the page', async (confirmTarget) => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget });
      const summary = await task.run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toBe(refusalFor(confirmTarget));
      expect(acted).toEqual([]);
    });

    // The page's own text shows "Delete this repository" too, and still the action's words are not a target.
    it.each(['delete', 'this repository', 'Delete this repository'])('refuses the action\'s own words: %s', async (confirmTarget) => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget });
      expect((await task.run()).reason).toBe(refusalFor(confirmTarget));
      expect(acted).toEqual([]);
    });

    it('refuses the wrong target: another repository than the page is on', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'ada/app' });
      const summary = await task.run();
      expect(summary.reason).toBe(refusalFor('ada/app'));
      expect(acted).toEqual([]);
    });

    it('refuses a target when only some of its words are on the page', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'ada/scratch and ada/app' });
      expect((await task.run()).reason).toBe(refusalFor('ada/scratch and ada/app'));
      expect(acted).toEqual([]);
    });

    it('refuses a target made only of words too short to name anything', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'qq' });
      expect((await task.run()).reason).toBe(refusalFor('qq'));
      expect(acted).toEqual([]);
    });

    it('cuts the page title in the refusal to 80 characters, and leaves it out when the page has none', async () => {
      const long = 'ada/scratch - Settings - ' + 'x'.repeat(200);
      const titled = await askedToDelete((fingerprint) => scratchPage(fingerprint, { title: long }));
      titled.task.update({ confirmIrreversible: true, confirmTarget: 'ada/app' });
      expect((await titled.task.run()).reason).toBe(refusalFor('ada/app', long.slice(0, 80)));

      const untitled = await askedToDelete((fingerprint) => scratchPage(fingerprint, { title: '' }));
      untitled.task.update({ confirmIrreversible: true, confirmTarget: 'ada/app' });
      expect((await untitled.task.run()).reason).toContain('here (its address, the visible text or the values typed on this page)');
    });

    it('matches the address when the title does not name the target', async () => {
      const { task, acted } = await askedToDelete((fingerprint) => scratchPage(fingerprint, { title: '' }));
      task.update({ confirmIrreversible: true, confirmTarget: 'ada/scratch' });
      await task.run();
      expect(acted).toEqual([{ label: DELETE }]);
    });

    it('matches the visible text when neither the title nor the address names the target', async () => {
      const bare = (fingerprint: string) =>
        scratchPage(fingerprint, { title: '', url: 'http://fixture/settings', text: 'Danger zone\nRemove ada/scratch for good' });
      const { task, acted } = await askedToDelete(bare);
      task.update({ confirmIrreversible: true, confirmTarget: 'remove ada/scratch' });
      await task.run();
      expect(acted).toEqual([{ label: DELETE }]);
    });

    it('matches an issue title for the Comment button, whose label says nothing of the issue', async () => {
      const issuePage = (fingerprint: string) =>
        page({
          url: 'http://fixture/ada/app/issues/1',
          title: 'Login fails on Safari · Issue #1',
          text: 'Login fails on Safari\nWrite\nComment',
          actions: [{ id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Comment' }],
          fingerprint,
        });
      const { ask } = scriptedJev([deleteIt]);
      const { asTab, acted } = fakeTab(manyPages(issuePage));
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('needs_confirmation');

      task.update({ confirmIrreversible: true, confirmTarget: 'Login fails on Safari' });
      await task.run();

      expect(acted).toEqual([{ label: 'Comment' }]);
    });

    describe('on a page that does not show the target outside what was typed', () => {
      const field = (label: string, node: number): PageAction => ({ id: `e${node}`, kind: 'fill', node, role: 'textbox', label, value: '' });
      const formPage = (fingerprint: string, url: string, title: string, fieldLabel: string, button: string) =>
        page({
          url,
          title,
          text: title,
          actions: [field(fieldLabel, 1), { id: 'e2', kind: 'click', node: 2, role: 'button', label: button }],
          fingerprint,
        });
      const typeInto = { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'value' };
      const submit = { operation: 'CLICK', click_target: '2', commit_risk: 0.9 };
      const callWith = (value: string) => ({ goal: 'Fill the form with the value', values: { value }, maxSteps: 5, changeWaitMs: 0 });

      describe('a sign-up page', () => {
        const signUpPage = (fingerprint: string) =>
          formPage(fingerprint, 'http://fixture/user/sign_up', 'Create account', 'Username', 'Register');
        const withUsername = { goal: 'Create an account with the username in values', values: { username: 'signup-3-x7k2qa' }, maxSteps: 5, changeWaitMs: 0 };

        it('matches the username value this task typed on the page', async () => {
          const { ask } = scriptedJev([{ ...typeInto, value_for_1: 'username' }, submit]);
          const { asTab, acted } = fakeTab(manyPages(signUpPage));
          const task = new BrowserTask(asTab, ask, withUsername);
          expect((await task.run()).status).toBe('needs_confirmation');

          task.update({ confirmIrreversible: true, confirmTarget: 'signup-3-x7k2qa' });
          await task.run();

          expect(acted).toEqual([{ label: 'Username', text: 'signup-3-x7k2qa' }, { label: 'Register' }]);
        });

        it('does not count a supplied value that was never typed there', async () => {
          const { ask } = scriptedJev([submit]);
          const { asTab, acted } = fakeTab(manyPages(signUpPage));
          const task = new BrowserTask(asTab, ask, withUsername);
          expect((await task.run()).status).toBe('needs_confirmation');

          task.update({ confirmIrreversible: true, confirmTarget: 'signup-3-x7k2qa' });
          const summary = await task.run();

          expect(summary.reason).toBe(
            `confirm_target "signup-3-x7k2qa" names nothing "Register" acts on here (page "Create account", its address, the visible text or the values typed on this page); ask the user which one they mean.`,
          );
          expect(acted).toEqual([]);
        });
      });

      it('matches the name typed into a new milestone', async () => {
        const milestonePage = (fingerprint: string) =>
          formPage(fingerprint, 'http://fixture/ada/app/milestones/new', 'New Milestone', 'Title', 'Create milestone');
        const { ask } = scriptedJev([typeInto, submit]);
        const { asTab, acted } = fakeTab(manyPages(milestonePage));
        const task = new BrowserTask(asTab, ask, callWith('v1.2'));
        expect((await task.run()).status).toBe('needs_confirmation');

        task.update({ confirmIrreversible: true, confirmTarget: 'v1.2' });
        await task.run();

        expect(acted).toEqual([{ label: 'Title', text: 'v1.2' }, { label: 'Create milestone' }]);
      });
    });

    it('clears a refused confirmation: the next risky click is handed back until the agent answers again', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'anything that looks unused' });
      expect((await task.run()).reason).toBe(refusalFor('anything that looks unused'));

      const handedBack = await task.run();
      expect(handedBack.status).toBe('needs_confirmation');
      expect(handedBack.reason).toContain(`Clicking "${DELETE}" on "ada/scratch - Settings" looks irreversible`);
      expect(acted).toEqual([]);
    });

    it('lets the agent answer a refusal with the words that do name the target', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'anything that looks unused' });
      expect((await task.run()).status).toBe('needs_confirmation');

      task.update({ confirmIrreversible: true, confirmTarget: 'ada/scratch' });
      await task.run();

      expect(acted).toEqual([{ label: DELETE }]);
    });

    it('keeps the target a first call gave through a needs_input, and takes no new one from a call that is not answering', async () => {
      const noValueForEmail = { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE };
      const { ask } = scriptedJev([noValueForEmail, noValueForEmail, { operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
      const { asTab, acted } = fakeTab(manyPages((fingerprint) => page({ fingerprint })));
      const task = new BrowserTask(asTab, ask, { goal: 'Pay', values: { name: 'Ada' }, maxSteps: 1, changeWaitMs: 0 });

      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      expect((await task.run()).status).toBe('needs_input');
      task.update({ values: { email: 'ada@example.com' }, confirmIrreversible: true, confirmTarget: 'anything unused' });
      await task.run();

      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
    });
  });

  describe('the confirm dialog a confirmed click opens', () => {
    const PAY = 'Confirm booking and pay €412';
    const pay = { operation: 'CLICK', click_target: '4', commit_risk: 0.9 };
    const safe = { operation: 'CLICK', click_target: '4', commit_risk: 0.1 };
    const pages = () => Array.from({ length: 12 }, (_, i) => page({ fingerprint: String(i) }));
    const options = { goal: 'Pay', maxSteps: 1, changeWaitMs: 0 };
    // What the tab records when it answered OK to the dialog the click opened.
    const answeredOk = { type: 'confirm', message: 'Pay €412 now?', accepted: true };
    const confirmed = { confirmIrreversible: true, confirmTarget: STAYLIST };

    it('arms the next confirm with the user\'s words and the control\'s label, and notes the OK on the step', async () => {
      const { ask } = scriptedJev([pay]);
      const { tab, asTab } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('needs_confirmation');
      expect(tab.armedAtAct).toEqual([]);

      tab.dialogOnAct = answeredOk;
      task.update(confirmed);
      const summary = await task.run();

      expect(tab.armedAtAct).toEqual([[STAYLIST, PAY]]);
      expect(summary.steps[0].element).toContain('asked "Pay €412 now?" in a confirm dialog; answered OK (the click the caller confirmed)');
    });

    it('never arms a click the caller did not confirm', async () => {
      const { ask } = scriptedJev([pay]);
      const { tab, asTab, acted } = fakeTab(pages());
      expect((await new BrowserTask(asTab, ask, options).run()).status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
      expect(tab.armedAtAct).toEqual([]);
      expect(tab.armed).toBeUndefined();
    });

    it('never arms a click that is not risky, even with a confirmation waiting', async () => {
      const { ask } = scriptedJev([safe]);
      const { tab, asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      task.update(confirmed);
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
      expect(tab.armedAtAct).toEqual([undefined]);
    });

    it('takes the arm back after the step, also when no dialog opened', async () => {
      const { ask } = scriptedJev([pay]);
      const { tab, asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      task.update(confirmed);
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
      expect(tab.armedAtAct).toEqual([[STAYLIST, PAY]]);
      expect(tab.armed).toBeUndefined();
    });

    it('does not carry the arm into the next step when the click never reached the page', async () => {
      const { ask } = scriptedJev([pay, safe]);
      const { tab, asTab, acted } = fakeTab(pages());
      tab.staleOnce = true;
      const task = new BrowserTask(asTab, ask, options);
      task.update(confirmed);
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
      expect(tab.armedAtAct).toEqual([[STAYLIST, PAY], undefined]);
    });

    it('does not count an accepted confirm toward "the page keeps asking", where a declined one is a loop', async () => {
      const dialogTwice = async (accepted: boolean) => {
        const { ask } = scriptedJev([pay]);
        const { tab, asTab } = fakeTab(pages());
        tab.dialogOnAct = { ...answeredOk, accepted };
        const task = new BrowserTask(asTab, ask, options);
        task.update(confirmed);
        await task.run();
        expect((await task.run()).status).toBe('needs_confirmation');
        task.update(confirmed);
        return task.run();
      };
      expect((await dialogTwice(true)).status).toBe('step_budget');
      expect((await dialogTwice(false)).status).toBe('blocked');
    });
  });

  it('gives a gray-zone click a screenshot look before it runs, and a clearly safe one none', async () => {
    const run = async (commit_risk: number) => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk }]);
      const { tab, asTab, acted } = fakeTab();
      await new BrowserTask(asTab, ask, { goal: 'Pay', maxSteps: 1, screenshots: 'fallback', changeWaitMs: 0 }).run();
      return { requests, screenshots: tab.screenshots, acted };
    };

    const gray = await run(0.35);
    expect(gray).toMatchObject({ screenshots: 1, acted: [{ label: 'Confirm booking and pay €412' }] });
    expect(gray.requests).toHaveLength(2);

    const safe = await run(0.1);
    expect(safe.screenshots).toBe(0);
    expect(safe.requests).toHaveLength(1);
  });

  it('waits and re-decides when the completion check rejects DONE', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'DONE', done_check: 0.1 },
      { operation: 'DONE', done_check: 0.97 },
    ]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Search', doneWhen: 'Results listed' }).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.97 });
    expect(requests).toHaveLength(2);
  });

  it('re-observes and re-decides when the page moved before input', async () => {
    const { ask } = scriptedJev([
      { operation: 'CLICK', click_target: '1' },
      { operation: 'CLICK', click_target: '1' },
      { operation: 'DONE' },
    ]);
    const { tab, asTab, acted } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    tab.staleOnce = true;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(acted).toHaveLength(1);
    expect(summary.jev.requests).toBe(3);
  });

  it('stops as blocked when three actions change nothing', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Loop', changeWaitMs: 0 }).run();
    expect(summary).toMatchObject({ status: 'blocked', reason: 'The last 3 actions did not change the page' });
    expect(summary.steps).toHaveLength(3);
  });

  describe('on a page that changes faster than a decision takes', () => {
    const PAY = 'Confirm booking and pay €412';
    const options = { goal: 'Pay', maxSteps: 5, changeWaitMs: 0 };

    it('does not spend the decision budget on clicks the page refused', async () => {
      // maxSteps 5 gives 10 decisions: 10 refusals plus the click and DONE would end step_budget if each were charged; 10 is the most the cap allows.
      const clicks = Array.from({ length: 11 }, () => ({ operation: 'CLICK', click_target: '4' }));
      const { ask } = scriptedJev([...clicks, { operation: 'DONE' }]);
      const { tab, asTab, acted } = fakeTab([page({ fingerprint: 'before' }), page({ fingerprint: 'after' })]);
      tab.stale = 10;
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([{ label: PAY }]);
      expect(summary.status).toBe('done');
    });

    it('hands back blocked once clicks have been refused more than 2 times maxSteps', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4' }]);
      const { tab, asTab, acted } = fakeTab();
      tab.stale = 1000;
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({
        status: 'blocked',
        reason: `The page kept changing under the click: "${PAY}" was refused 11 times as stale`,
      });
      expect(tab.calls).toHaveLength(11);
      expect(acted).toEqual([]);
    });

    it('still ends step_budget when decisions are spent without a refusal', async () => {
      // A stop the page has already moved past is re-decided without acting; none of that is a refusal, so the 10-decision budget holds.
      const { ask, requests } = scriptedJev([{ operation: 'BLOCKED' }]);
      const { tab, asTab } = fakeTab();
      tab.fresh = async () => false;
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({ status: 'step_budget', reason: 'Made 10 decisions without finishing' });
      expect(requests).toHaveLength(10);
    });
  });
});

describe('screenshots', () => {
  const shaky: Record<string, string | number>[] = [{ operation: 'CLICK', click_target: '1', confidence: 0.1 }, { operation: 'DONE' }];

  it('off: a low-confidence step hands back without a screenshot', async () => {
    const { ask, requests } = scriptedJev(shaky);
    const { tab, asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('uncertain');
    expect(tab.screenshots).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('fallback: re-decides the shaky step with a marked screenshot, then acts on that decision', async () => {
    const { ask, requests } = scriptedJev([...shaky.slice(0, 1), { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', screenshots: 'fallback' }).run();
    expect(summary).toMatchObject({ status: 'done', jev: { requests: 2, screenshots: 1 } });
    expect(Array.isArray(requests[0].state)).toBe(false);
    expect((requests[1].state as any)[0].type).toBe('image_url');
    expect(tab.screenshots).toBe(1);
  });

  it('fallback: a confident step stays text-only', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE' }]);
    const { tab, asTab } = fakeTab();
    await new BrowserTask(asTab, ask, { goal: 'Open', screenshots: 'fallback' }).run();
    expect(tab.screenshots).toBe(0);
  });

  it('always: every decision carries a screenshot', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    await new BrowserTask(asTab, ask, { goal: 'Open', screenshots: 'always' }).run();
    expect(requests.every((request) => Array.isArray(request.state))).toBe(true);
  });

  it('records a sharp shot before each action and of the final page, never sent to the model', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-record-'));
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', recordDir }).run();
    expect(summary.status).toBe('done');
    expect(tab.recorded).toBe(2);
    expect(tab.screenshots).toBe(0);
    expect(requests.some((request) => Array.isArray(request.state))).toBe(false);
    expect(readdirSync(recordDir).sort()).toEqual(['calls', 'final.jpg', 'index.html', 'manifest.json', 'steps', 'summary.json']);
    expect(readdirSync(join(recordDir, 'steps')).sort()).toEqual(['01-click-open-full-name.jpg', '02-finished-done.jpg']);
    const { steps } = JSON.parse(readFileSync(join(recordDir, 'summary.json'), 'utf8'));
    expect(steps.map((s: { operation: string }) => s.operation)).toEqual(['CLICK', 'done']);
    expect(steps[0].description).toMatch(/^Click "/);
    expect(readFileSync(join(recordDir, 'index.html'), 'utf8')).toContain('<img src="steps/01-click-open-full-name.jpg"');
  });

  it('returns the run\'s own status when its recording cannot start or take the final shot', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE' }]);
    const { tab, asTab } = fakeTab();
    const dropped = async () => {
      throw new Error('Browser connection closed');
    };
    tab.send = dropped;
    tab.markedScreenshot = async (_marks, _viewport, options) => {
      if (options?.sharp) return dropped();
      return 'SCREENSHOT';
    };
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-record-'));
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', recordDir }).run();
    expect(summary.status).toBe('done');
    // The run folder still holds the summary the failed recording never wrote.
    expect(JSON.parse(readFileSync(join(recordDir, 'summary.json'), 'utf8')).summaries[0].status).toBe('done');
  });

  it('holds each video frame until the next, without freezing on idle stretches', () => {
    expect(frameDurations([10, 10.2, 19, 19.01]).map((s) => Number(s.toFixed(3)))).toEqual([0.2, 1.5, 0.033, 1.5]);
  });

  it('places each step in the video by the frames shown before it', () => {
    const times = [100, 100.5, 110];
    expect(videoOffset(times, frameDurations(times), 105)).toBe(2);
  });

  it('describes steps as plain sentences, cutting long row labels at a word', () => {
    expect(describeStep({ operation: 'TYPE_TEXT', element: 'Search', valueKey: 'search_query' })).toBe(
      'Type the "search_query" value into "Search"',
    );
    const row = describeStep({ operation: 'CLICK', element: `2026-10-15 15:19:13 handle-chatbot-message ${'x '.repeat(60)}` });
    expect(row).toMatch(/^Click "2026-10-15 15:19:13 handle-chatbot-message[^"]*…"$/);
    expect(row.length).toBeLessThan(85);
  });

  it('replaces the shot of an action the page moved away from with its retry', async () => {
    const click = { operation: 'CLICK', click_target: '1' };
    const { ask } = scriptedJev([click, click, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    tab.staleOnce = true;
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-record-'));
    await new BrowserTask(asTab, ask, { goal: 'Open', recordDir }).run();
    const { steps } = JSON.parse(readFileSync(join(recordDir, 'summary.json'), 'utf8'));
    expect(steps.map((s: { file: string; operation: string }) => [s.file, s.operation])).toEqual([
      ['steps/01-click-open-full-name.jpg', 'CLICK'],
      ['steps/02-finished-done.jpg', 'done'],
    ]);
    // The refused shot's file went with it.
    expect(readdirSync(join(recordDir, 'steps')).sort()).toEqual(['01-click-open-full-name.jpg', '02-finished-done.jpg']);
  });
});

describe('a summary carries the model it used and its estimated cost', () => {
  const bookedPage = () => page({ text: 'Staylist\nBooking confirmed', url: 'http://fixture/stays#booking', fingerprint: 'booked' });
  const run = (model?: string) => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    return new BrowserTask(fakeTab([bookedPage()]).asTab, ask, { goal: 'Book', doneWhen: 'Booking confirmed', changeWaitMs: 0, model }).run();
  };

  it("names the model and prices every request, the done's evidence request included", async () => {
    const summary = await run('jev-1.14.0');
    expect(summary.status).toBe('done');
    expect(summary.jev).toMatchObject({ requests: 2, input_tokens: 200, model: 'jev-1.14.0', est_cost_usd: 0.000008 });
  });

  it('has no cost for a model without a price, and no model when the task was given none', async () => {
    expect((await run('cloudflare/clef-omni')).jev).toMatchObject({ model: 'cloudflare/clef-omni', est_cost_usd: null });
    expect((await run()).jev).toMatchObject({ model: null, est_cost_usd: null });
  });
});

describe('real-site robustness', () => {
  const searchPage = (overrides: Partial<PageState> = {}) =>
    page({
      actions: [
        { id: 'e1', kind: 'fill', node: 10, role: 'searchbox', label: 'Search packages', value: '' },
        { id: 'e2', kind: 'fill', node: 11, role: 'textbox', label: 'Email address', value: '' },
        { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
      ],
      ...overrides,
    });

  it('offers Enter only right after typing into a search-like field, and presses it on that field', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'query' },
      { operation: 'PRESS_ENTER' },
      { operation: 'DONE' },
    ]);
    const { asTab, acted } = fakeTab([searchPage({ fingerprint: 'a' }), searchPage({ fingerprint: 'b' }), searchPage({ fingerprint: 'c' })]);
    await new BrowserTask(asTab, ask, { goal: 'Find zod', values: { query: 'zod' } }).run();
    expect(Object.keys((requests[0].questions.operation as any).criteria)).not.toContain('PRESS_ENTER');
    expect(Object.keys((requests[1].questions.operation as any).criteria)).toContain('PRESS_ENTER');
    expect(acted).toEqual([
      { label: 'Search packages', text: 'zod' },
      { label: 'Press Enter in "Search packages" to submit what was typed' },
    ]);
  });

  it('offers Enter after typing into a filter field, whose list only filters on Enter', async () => {
    const filterPage = (fingerprint: string) =>
      page({
        fingerprint,
        actions: [
          { id: 'e1', kind: 'fill', node: 10, role: 'textbox', label: 'Filter by name...', value: '' },
          { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
        ],
      });
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'query' },
      { operation: 'PRESS_ENTER' },
      { operation: 'DONE' },
    ]);
    const { asTab, acted } = fakeTab([filterPage('a'), filterPage('b'), filterPage('c')]);
    await new BrowserTask(asTab, ask, { goal: 'Filter alerts by cpu', values: { query: 'cpu' } }).run();
    expect(Object.keys((requests[1].questions.operation as any).criteria)).toContain('PRESS_ENTER');
    expect(acted).toEqual([
      { label: 'Filter by name...', text: 'cpu' },
      { label: 'Press Enter in "Filter by name..." to submit what was typed' },
    ]);
  });

  it('never offers Enter after typing into a field that is not search-like', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'DONE' },
    ]);
    const { asTab } = fakeTab([searchPage({ fingerprint: 'a' }), searchPage({ fingerprint: 'b' })]);
    await new BrowserTask(asTab, ask, { goal: 'Enter email', values: { email: 'a@b.co' } }).run();
    expect(Object.keys((requests[1].questions.operation as any).criteria)).not.toContain('PRESS_ENTER');
  });

  it("ends as done when the caller's completion evidence is plainly met, without acting", async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.95 }]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open it', doneWhen: 'It is open' }).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.95 });
    expect(acted).toEqual([]);
  });

  it('records when a typed value did not stick, so Jev does not treat the field as filled', async () => {
    const { ask } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'DONE' },
    ]);
    // The field still reads empty after typing: a popup swallowed the input.
    const { asTab } = fakeTab([searchPage({ fingerprint: 'a' }), searchPage({ fingerprint: 'b' })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Enter email', values: { email: 'a@b.co' } }).run();
    expect(summary.steps[0]).toMatchObject({ operation: 'TYPE_TEXT', value_kept: false });
  });
});

describe('errors become hand-backs', () => {
  const SETTLE_TIMEOUT = 'Page did not settle within 1s';
  const click = { operation: 'CLICK', click_target: '1' };

  /** A model that fails with `message` for its first `failures` calls, then answers DONE. */
  const failingJev = (failures: number, message: string) => {
    const scripted = scriptedJev([{ operation: 'DONE' }]);
    const state = { calls: 0 };
    const ask: Ask = async (request) => {
      if (++state.calls <= failures) throw new Error(message);
      return scripted.ask(request);
    };
    return { ask, state };
  };

  afterEach(() => vi.useRealTimers());

  it('ends as blocked when the first observe never settles', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { tab, asTab } = fakeTab();
    tab.observe = async () => {
      throw new StalePage(SETTLE_TIMEOUT);
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary).toMatchObject({ status: 'blocked', url: '', steps: [] });
    expect(summary.reason).toBe(`Browser error: ${SETTLE_TIMEOUT}`);
    expect(requests).toHaveLength(0);
  });

  it('ends as blocked, still reporting the executed action, when the page never settles after it', async () => {
    const { ask } = scriptedJev([click]);
    const { tab, asTab, acted } = fakeTab();
    let observed = 0;
    tab.observe = async () => {
      if (observed++) throw new StalePage(SETTLE_TIMEOUT);
      return page();
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('did not settle');
    expect(acted).toHaveLength(1);
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0]).toMatchObject({ operation: 'CLICK', element: acted[0].label });
    expect(summary.steps[0]).not.toHaveProperty('page_changed');
  });

  it('still reports a typed value when the page never settles after typing it', async () => {
    const { ask } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' }]);
    const { tab, asTab, acted } = fakeTab();
    let observed = 0;
    tab.observe = async () => {
      if (observed++) throw new StalePage(SETTLE_TIMEOUT);
      return page();
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Enter email', values: { email: 'ada@example.com' } }).run();
    expect(summary.status).toBe('blocked');
    expect(acted).toEqual([{ label: 'Email address', text: 'ada@example.com' }]);
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0]).toMatchObject({ operation: 'TYPE_TEXT', element: 'Email address', value_key: 'email' });
    expect(summary.steps[0]).not.toHaveProperty('page_changed');
    expect(summary.steps[0]).not.toHaveProperty('value_kept');
  });

  it('ends as blocked on a model 400 without retrying it', async () => {
    const { ask, state } = failingJev(Infinity, '400 {"detail":{"error_type":"max_tokens_exceeded"}}');
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toMatch(/^Model error: 400/);
    expect(state.calls).toBe(1);
  });

  it('retries a transient model error once and carries on', async () => {
    vi.useFakeTimers();
    const { ask, state } = failingJev(1, '503 Service Unavailable');
    const running = new BrowserTask(fakeTab().asTab, ask, { goal: 'Open' }).run();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await running).status).toBe('done');
    expect(state.calls).toBe(2);
  });

  it('retries a 499 "unexpected error" once like any transient model error', async () => {
    vi.useFakeTimers();
    const { ask, state } = failingJev(1, '499 An unexpected error occurred');
    const running = new BrowserTask(fakeTab().asTab, ask, { goal: 'Open' }).run();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await running).status).toBe('done');
    expect(state.calls).toBe(2);
  });

  it('ends as blocked when the model fails transiently twice in a row', async () => {
    vi.useFakeTimers();
    const { ask, state } = failingJev(Infinity, '503 Service Unavailable');
    const running = new BrowserTask(fakeTab().asTab, ask, { goal: 'Open' }).run();
    await vi.advanceTimersByTimeAsync(1000);
    const summary = await running;
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toMatch(/^Model error: 503/);
    expect(state.calls).toBe(2);
  });

  it('ends as blocked when the browser refuses an action for a reason other than a stale page', async () => {
    const { ask } = scriptedJev([click]);
    const { tab, asTab } = fakeTab();
    tab.act = async () => {
      throw new Error('Dropdown execution was not confirmed; inspect before retrying.');
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('Dropdown execution');
  });
});

describe("a summary carries the final page's text", () => {
  const TEXT_CAP = 2500;

  it('gives a done summary the final page text, so a caller can read what the page shows', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab([page({ text: 'ada\napp — Demo app\nscratch — Scratch repository' })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'List the repositories', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.page_text).toBe('ada\napp — Demo app\nscratch — Scratch repository');
  });

  it(`cuts a longer page text at ${TEXT_CAP} characters and says how much it left out`, async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const text = 'line of page text\n'.repeat(200).slice(0, 3000);
    const { asTab } = fakeTab([page({ text })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Read it', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.page_text).toBe(`${text.slice(0, TEXT_CAP)}\n…[500 more characters not shown]`);
  });

  it(`leaves a page text of ${TEXT_CAP} characters or fewer as it is, with no marker`, async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const text = 'line of page text\n'.repeat(200).slice(0, TEXT_CAP);
    const { asTab } = fakeTab([page({ text })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Read it', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.page_text).toBe(text);
  });

  it('puts the page text on a blocked summary at the top level, not inside stuck', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { tab, asTab } = fakeTab([page({ text: 'Danger zone\nDelete this repository' })]);
    tab.unreachable = 10;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.page_text).toBe('Danger zone\nDelete this repository');
    expect(summary.stuck).toMatchObject({ operation: 'CLICK', candidates: expect.any(Array) });
    expect(summary.stuck).toHaveProperty('element');
    expect(summary.stuck).not.toHaveProperty('page_text');
  });
});

describe('page dialogs', () => {
  /** A CDP connection that records calls and lets a test emit protocol events on the tab's session. */
  const fakeCdp = (handlers: Record<string, () => unknown> = {}) => {
    const calls: string[] = [];
    const answered: { accept: boolean }[] = [];
    const listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
    const cdp = {
      send: async (method: string, params: any = {}) => {
        calls.push(method);
        if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
        if (method === 'Page.handleJavaScriptDialog') answered.push({ accept: params.accept });
        return handlers[method]?.() ?? {};
      },
      onEvent: (listener: (method: string, params: any, sessionId?: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emit = (method: string, params: object) => listeners.forEach((listener) => listener(method, params, 'S1'));
    return { cdp: cdp as unknown as CdpConnection, calls, answered, emit };
  };

  const opening = (type: string, message = '') => ({ type, message, url: 'http://fixture/', hasBrowserHandler: true });

  it('answers every dialog at once with the choice that changes nothing: OK only for an alert', async () => {
    const { cdp, answered, emit } = fakeCdp();
    const tab = await Tab.attach(cdp, 'T1');
    for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) emit('Page.javascriptDialogOpening', opening(type, `${type} text`));
    expect(answered).toEqual([{ accept: true }, { accept: false }, { accept: false }, { accept: false }]);
    expect(tab.takeDialogs()).toEqual([
      { type: 'alert', message: 'alert text', accepted: true },
      { type: 'confirm', message: 'confirm text', accepted: false },
      { type: 'prompt', message: 'prompt text', accepted: false },
      { type: 'beforeunload', message: 'beforeunload text', accepted: false },
    ]);
    expect(tab.takeDialogs()).toEqual([]);
  });

  it('keeps going when the browser refuses the answer', async () => {
    const { cdp, emit } = fakeCdp({
      'Page.handleJavaScriptDialog': () => {
        throw new CdpError('No dialog is showing');
      },
    });
    const tab = await Tab.attach(cdp, 'T1');
    emit('Page.javascriptDialogOpening', opening('confirm', 'Sure?'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tab.takeDialogs()).toHaveLength(1);
  });

  describe('a page that stops answering', () => {
    const settled = (promise: Promise<unknown>) => promise.then((value) => ({ value }), (error) => ({ error }));

    it('ends observe() with the browser error at once instead of retrying every timeout as a stale page', async () => {
      let evaluates = 0;
      const { cdp, calls } = fakeCdp({
        'Runtime.evaluate': () => {
          evaluates++;
          throw new CdpError('Runtime.evaluate timed out after 30000 ms');
        },
      });
      const tab = await Tab.attach(cdp, 'T1');
      const before = calls.length;
      evaluates = 0;
      const outcome: any = await settled(tab.observe());
      expect(outcome.error).toBeInstanceOf(CdpError);
      expect(outcome.error).not.toBeInstanceOf(StalePage);
      expect(outcome.error.message).toBe('Runtime.evaluate timed out after 30000 ms');
      expect(evaluates).toBe(1);
      expect(calls.length).toBeGreaterThan(before);
    });

    it('still retries a protocol error that really means the page is changing', async () => {
      let evaluates = 0;
      const { cdp } = fakeCdp({
        'Runtime.evaluate': () => {
          evaluates++;
          throw new CdpError('Cannot find context with specified id');
        },
      });
      const tab = await Tab.attach(cdp, 'T1');
      evaluates = 0;
      const outcome: any = await settled(tab.observe());
      expect(outcome.error).toBeInstanceOf(StalePage);
      expect(evaluates).toBeGreaterThan(1);
    });

    it('gives up on navigate() at its deadline even when one evaluate never answers', async () => {
      vi.useFakeTimers();
      try {
        let hung = false;
        const { cdp } = fakeCdp({
          'Runtime.evaluate': () => (hung ? new Promise(() => undefined) : {}),
        });
        const tab = await Tab.attach(cdp, 'T1');
        hung = true;
        let returned = false;
        void tab.navigate('http://fixture/').then(() => (returned = true));
        await vi.advanceTimersByTimeAsync(16_000);
        expect(returned).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('in a run', () => {
    const confirmAfterEachClick = (tab: ReturnType<typeof fakeTab>['tab'], message = 'Discard the draft?', type = 'confirm') => {
      const act = tab.act;
      tab.act = async (...args: Parameters<typeof act>) => {
        await act(...args);
        tab.dialogs.push({ type, message, accepted: type === 'alert' });
      };
    };
    const fourPages = ['a', 'b', 'c', 'd'].map((fingerprint) => page({ fingerprint }));

    it("tells Jev about a dialog the page opened after a step, and how it was answered", async () => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE', done_check: 0.9 }]);
      const { tab, asTab } = fakeTab(fourPages);
      confirmAfterEachClick(tab);
      const summary = await new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'x', changeWaitMs: 0 }).run();
      expect(summary.status).toBe('done');
      expect(summary.steps[0].element).toBe('Open Full name (the page then asked "Discard the draft?" in a confirm dialog; answered Cancel)');
      expect(JSON.stringify(requests.at(-1))).toContain('answered Cancel');
    });

    it('describes an alert and a leave-the-page prompt in their own words', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'CLICK', click_target: '4', commit_risk: 0 }, { operation: 'DONE', done_check: 0.9 }]);
      const { tab, asTab } = fakeTab(fourPages);
      const dialogs = [
        { type: 'alert', message: 'Saved', accepted: true },
        { type: 'beforeunload', message: '', accepted: false },
      ];
      const act = tab.act;
      tab.act = async (...args: Parameters<typeof act>) => {
        await act(...args);
        tab.dialogs.push(dialogs.shift()!);
      };
      const summary = await new BrowserTask(asTab, ask, { goal: 'Save', doneWhen: 'x', changeWaitMs: 0 }).run();
      expect(summary.steps[0].element).toContain('(the page then showed an alert "Saved"; answered OK)');
      expect(summary.steps[1].element).toContain('(the page then asked whether to leave the page; stayed on it)');
    });

    it('reports a dialog that was already open when the call started on the first step it takes', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE', done_check: 0.9 }]);
      const { tab, asTab } = fakeTab(fourPages);
      tab.dialogs.push({ type: 'confirm', message: 'Leave the page?', accepted: false });
      const summary = await new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'x', changeWaitMs: 0 }).run();
      expect(summary.steps[0].element).toContain('the page then asked "Leave the page?" in a confirm dialog; answered Cancel');
    });

    it('hands back when the page keeps asking the same confirm: it is only ever answered Cancel', async () => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
      const { tab, asTab, acted } = fakeTab(fourPages);
      confirmAfterEachClick(tab);
      const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
      expect(summary.status).toBe('blocked');
      expect(summary.reason).toBe(
        'The page keeps asking "Discard the draft?" (confirm dialog). jevway only answers Cancel to these; ask the user how to proceed.',
      );
      expect(acted).toHaveLength(2);
      expect(requests).toHaveLength(2);
    });

    it('does not count a repeated alert as a loop: OK is its only button and changes nothing', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'CLICK', click_target: '1' }, { operation: 'DONE', done_check: 0.9 }]);
      const { tab, asTab } = fakeTab(fourPages);
      confirmAfterEachClick(tab, 'Saved', 'alert');
      const summary = await new BrowserTask(asTab, ask, { goal: 'Save', doneWhen: 'x', changeWaitMs: 0 }).run();
      expect(summary.status).toBe('done');
    });

    describe('a click the page asks about before leaving', () => {
      const link = (label: string, node: number): PageAction => ({ id: `e${node}`, kind: 'click', node, role: 'link', label });
      // Repository settings: a description, two links away and Save. Every page differs, so no step looks like a no-op.
      const settingsPages = () =>
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((fingerprint) =>
          page({
            fingerprint,
            actions: [
              { id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'Description', value: '' },
              link('Wiki', 2),
              link('Issues', 3),
              { id: 'e4', kind: 'click', node: 4, role: 'button', label: 'Save settings' },
            ],
          }),
        );
      // The page's own guard: leaving by these links raises a leave-the-page prompt, answered Stay.
      const guardLinks = (tab: ReturnType<typeof fakeTab>['tab'], ...labels: string[]) => {
        const act = tab.act;
        tab.act = async (...args: Parameters<typeof act>) => {
          await act(...args);
          if (labels.includes(args[0].label)) tab.dialogs.push({ type: 'beforeunload', message: '', accepted: false });
        };
      };
      const typeDescription = { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'description' };
      const wiki = { operation: 'CLICK', click_target: '2' };
      const issues = { operation: 'CLICK', click_target: '3' };
      const save = { operation: 'CLICK', click_target: '4', commit_risk: 0.1 };
      const options = { goal: 'Update the settings', values: { description: 'Battle-tested demo' }, changeWaitMs: 0 };
      const SAVE_FIRST = (what: string, unsaved: string) =>
        `${what} would leave the page with ${unsaved}; save it first (a Save or Update button), or answer BLOCKED`;
      const DESCRIPTION = 'unsaved text in "Description"';

      it('feeds a click back as "save first" naming the field typed, and goes on', async () => {
        const { ask, requests } = scriptedJev([typeDescription, wiki, save]);
        const { tab, asTab, acted } = fakeTab(settingsPages());
        guardLinks(tab, 'Wiki');
        const summary = await new BrowserTask(asTab, ask, { ...options, maxSteps: 3 }).run();
        expect(summary.status).not.toBe('blocked');
        expect(summary.steps[1]).toMatchObject({ operation: 'CLICK', not_executed: SAVE_FIRST('this link', DESCRIPTION) });
        expect(summary.steps[1].element).toContain('(the page then asked whether to leave the page; stayed on it)');
        expect(JSON.stringify(requests[2])).toContain('save it first');
        expect(acted.map((a) => a.label)).toEqual(['Description', 'Wiki', 'Save settings']);
      });

      it('names a ticked box when that is the unsaved change', async () => {
        const boxPages = ['a', 'b', 'c', 'd'].map((fingerprint) =>
          page({
            fingerprint,
            actions: [{ id: 'e1', kind: 'click', node: 1, role: 'checkbox', label: 'Enable repository wiki', checked: 'false' }, link('Issues', 2)],
          }),
        );
        const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'CLICK', click_target: '2' }]);
        const { tab, asTab } = fakeTab(boxPages);
        guardLinks(tab, 'Issues');
        const summary = await new BrowserTask(asTab, ask, { goal: 'Turn the wiki off', changeWaitMs: 0, maxSteps: 2 }).run();
        expect(summary.steps[1]).toMatchObject({ not_executed: SAVE_FIRST('this link', 'unsaved changes to "Enable repository wiki"') });
      });

      it('hands back naming the field when the same click raises the prompt again', async () => {
        const { ask } = scriptedJev([typeDescription, wiki]);
        const { tab, asTab } = fakeTab(settingsPages());
        guardLinks(tab, 'Wiki');
        const summary = await new BrowserTask(asTab, ask, options).run();
        expect(summary.status).toBe('blocked');
        expect(summary.reason).toBe(
          'Leaving the page would discard the unsaved text in "Description" (the page asked before leaving); save it first, or ask the user whether to discard it.',
        );
      });

      it('gives each link its own "save first" before handing back', async () => {
        const { ask } = scriptedJev([typeDescription, wiki, issues, issues]);
        const { tab, asTab } = fakeTab(settingsPages());
        guardLinks(tab, 'Wiki', 'Issues');
        const summary = await new BrowserTask(asTab, ask, options).run();
        expect(summary.steps[1].not_executed).toBe(SAVE_FIRST('this link', DESCRIPTION));
        expect(summary.steps[2].not_executed).toBe(SAVE_FIRST('this link', DESCRIPTION));
        expect(summary.status).toBe('blocked');
        expect(summary.reason).toContain('Leaving the page would discard the unsaved text in "Description"');
      });

      it('keeps the generic reply when nothing was typed or ticked', async () => {
        const { ask } = scriptedJev([wiki]);
        const { tab, asTab } = fakeTab(settingsPages());
        guardLinks(tab, 'Wiki');
        const summary = await new BrowserTask(asTab, ask, options).run();
        expect(summary.steps[0].not_executed).toBeUndefined();
        expect(summary.status).toBe('blocked');
        expect(summary.reason).toBe(
          'The page keeps asking (beforeunload dialog). jevway only answers Cancel to these; ask the user how to proceed.',
        );
      });
    });
  });
});

describe('a scroll that moved nothing says so', () => {
  const SCROLL: PageAction = { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 };
  const scrolling = (fingerprint: string) => page({ actions: [...bookingActions, SCROLL], fingerprint });
  const lastAction = (request: any) => request.state.recent_actions.at(-1);

  it('tells Jev a scroll moved nothing, so it stops repeating it', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'SCROLL_DOWN' }, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([scrolling('a'), scrolling('b')]);
    tab.scrolled = 0;
    await new BrowserTask(asTab, ask, { goal: 'Find the row', changeWaitMs: 0 }).run();
    expect(lastAction(requests[1])).toMatchObject({
      operation: 'SCROLL_DOWN',
      element: 'Scroll down (nothing moved: there is no more to scroll this way)',
    });
  });

  it('keeps the plain label for a scroll that moved', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'SCROLL_DOWN' }, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([scrolling('a'), scrolling('b')]);
    tab.scrolled = 448;
    await new BrowserTask(asTab, ask, { goal: 'Find the row', changeWaitMs: 0 }).run();
    expect(lastAction(requests[1])).toMatchObject({ operation: 'SCROLL_DOWN', element: 'Scroll down', page_changed: true });
  });
});

describe('a tab the run\'s tab opens is followed', () => {
  const DOCS_LINK: PageAction = { id: 'docs', kind: 'click', node: 50, role: 'link', label: 'API documentation' };
  const BACK: PageAction = { id: 'close', kind: 'click', node: 60, role: 'button', label: 'Close this window' };
  const dashboard = (fingerprint: string) => page({ url: 'http://fixture/dashboard', title: 'Dashboard', actions: [DOCS_LINK], fingerprint });
  const docs = (fingerprint: string) => page({ url: 'http://fixture/docs', title: 'Docs', text: 'Getting started', actions: [BACK], fingerprint });
  const openingDocs = () => {
    const opener = fakeTab([dashboard('d1')]);
    const popup = fakeTab([docs('p1'), docs('p2')]);
    opener.tab.opensTabOn = DOCS_LINK.label;
    opener.tab.next = popup.asTab;
    return { opener, popup };
  };
  const recent = (request: any) => request.state.recent_actions;

  it('continues on the new tab and says so in history', async () => {
    const { opener, popup } = openingDocs();
    const { ask, requests } = scriptedJev([{ operation: 'CLICK' }, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Open the docs', changeWaitMs: 0 });
    const summary = await task.run();
    expect(requests[1].state.page.url).toBe('http://fixture/docs');
    expect(recent(requests[1]).at(-1)).toMatchObject({
      operation: 'CLICK',
      element: 'API documentation (new tab opened: http://fixture/docs)',
      page_changed: true,
    });
    expect(summary).toMatchObject({ status: 'done', url: 'http://fixture/docs' });
    expect(task.tab).toBe(popup.asTab);
    expect(task.tabs).toEqual([opener.asTab, popup.asTab]);
  });

  it('goes back to the tab that opened it when it closes', async () => {
    const { opener, popup } = openingDocs();
    const { ask, requests } = scriptedJev([{ operation: 'CLICK' }, { operation: 'CLICK' }, { operation: 'DONE' }]);
    const closeOnClick = popup.tab.act;
    popup.tab.act = async (...args: Parameters<typeof closeOnClick>) => {
      await closeOnClick(...args);
      popup.tab.closed = true;
    };
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Read the docs, then close them', changeWaitMs: 0 });
    await task.run();
    expect(requests[2].state.page.url).toBe('http://fixture/dashboard');
    expect(recent(requests[2]).at(-1).element).toBe('Close this window (the tab closed; back on http://fixture/dashboard)');
    expect(task.tab).toBe(opener.asTab);
  });

  it('closes the tabs it followed when the session ends, and the first one only when asked', async () => {
    const { opener, popup } = openingDocs();
    const { ask } = scriptedJev([{ operation: 'CLICK' }, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Open the docs', changeWaitMs: 0 });
    await task.run();
    await task.closeTabs({ keepFirst: true });
    expect([opener.tab.closes, popup.tab.closes]).toEqual([0, 1]);
    await task.closeTabs({ keepFirst: false });
    expect(opener.tab.closes).toBe(1);
  });

  it('leaves no confirm arm on the tab it switched away from', async () => {
    const PAY_THERE: PageAction = { id: 'pay', kind: 'click', node: 51, role: 'link', label: 'Pay in a new tab' };
    const opener = fakeTab([page({ url: 'http://fixture/stays', title: 'Staylist', actions: [PAY_THERE], fingerprint: 'o1' })]);
    const popup = fakeTab([docs('p1'), docs('p2')]);
    opener.tab.opensTabOn = PAY_THERE.label;
    opener.tab.next = popup.asTab;
    const { ask } = scriptedJev([{ operation: 'CLICK', commit_risk: 0.9 }, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Pay for the Staylist booking', changeWaitMs: 0 });
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    await task.run();
    expect(opener.tab.armedAtAct).toEqual([[STAYLIST, PAY_THERE.label]]);
    expect(opener.tab.armed).toBeUndefined();
    expect(popup.tab.armed).toBeUndefined();
  });

  it('hands back blocked with a browser error when the new tab never answers', async () => {
    const { opener } = openingDocs();
    opener.tab.follow = async () => {
      throw new CdpError('The new tab did not answer within 5 s: it may be showing a dialog it raised before jevway could answer it');
    };
    const { ask } = scriptedJev([{ operation: 'CLICK' }, { operation: 'DONE' }]);
    const summary = await new BrowserTask(opener.asTab, ask, { goal: 'Open the docs', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toMatch(/^Browser error: The new tab did not answer within 5 s/);
    expect(summary.steps.map((step) => step.element)).toEqual(['API documentation']);
  });

  it('keeps a confirmation given before the switch for the new tab', async () => {
    const PAY: PageAction = { id: 'pay', kind: 'click', node: 70, role: 'button', label: 'Pay €412' };
    const opener = fakeTab([dashboard('d1')]);
    const popup = fakeTab([page({ url: 'http://fixture/pay', title: 'Staylist payment', actions: [PAY], fingerprint: 'p1' }), page({ fingerprint: 'p2' })]);
    opener.tab.opensTabOn = DOCS_LINK.label;
    opener.tab.next = popup.asTab;
    const { ask } = scriptedJev([{ operation: 'CLICK' }, { operation: 'CLICK', commit_risk: 0.9 }, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Pay for the Staylist booking', changeWaitMs: 0 });
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(popup.acted.map((a) => a.label)).toEqual(['Pay €412']);
  });
});

describe('an upload uses a file the caller declared', () => {
  const AVATAR = new URL('../../verify/fixture/capabilities/avatar.png', import.meta.url).pathname;
  const PICKER: PageAction = { id: 'e9', kind: 'upload', node: 80, role: 'file', label: 'Upload a profile picture (file field)', value: '' };
  const CHOOSE: PageAction = { id: 'e10', kind: 'click', node: 81, role: 'button', label: 'Upload a profile picture' };
  const profile = (fingerprint: string) => page({ url: 'http://fixture/profile', title: 'Profile', actions: [CHOOSE, PICKER], fingerprint });
  const upload = { operation: 'UPLOAD', file_for_2: 'avatar' };

  it('offers UPLOAD with file heads over the declared keys, sending each file\'s name and never its path', () => {
    const space = buildActionSpace(profile('a').actions);
    const request = buildRequest({ page: profile('a'), goal: 'Set my picture', history: [], checkCommitRisk: true, values: {}, files: { avatar: 'avatar.png' } }, space);
    expect(Object.keys((request.questions.operation as any).criteria)).toContain('UPLOAD');
    expect(Object.keys((request.questions.file_for_2 as any).criteria)).toEqual(['avatar', NO_SUPPLIED_FILE]);
    expect((request.state as any).supplied_files).toEqual({ avatar: 'avatar.png' });
  });

  it('sets the declared path on the chosen field and says which key it used', async () => {
    const { ask, requests } = scriptedJev([upload, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([profile('a'), profile('b')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Set my picture', files: { avatar: AVATAR }, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(tab.wantedFiles).toBe(true);
    expect(tab.uploads).toEqual([{ label: PICKER.label, path: AVATAR }]);
    expect(summary.steps[0]).toMatchObject({ operation: 'UPLOAD', element: PICKER.label, file_key: 'avatar' });
    for (const request of requests) expect(JSON.stringify(request)).not.toContain(AVATAR);
  });

  it('feeds back a field no declared file fits once, then asks the caller', async () => {
    const noFile = { operation: 'UPLOAD', file_for_2: NO_SUPPLIED_FILE };
    const { ask, requests } = scriptedJev([noFile, noFile]);
    const { tab, asTab } = fakeTab([profile('a'), profile('b'), profile('c')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Attach my CV', files: { avatar: AVATAR }, changeWaitMs: 0 }).run();
    expect(requests[1].state.recent_actions.at(-1).not_executed).toMatch(/^no supplied file fits this field/);
    expect(summary).toMatchObject({ status: 'needs_input', reason: `No supplied file fits the file field "${PICKER.label}"` });
    expect(tab.uploads).toEqual([]);
  });

  it('never uploads a value: a key from values is not a file', async () => {
    const { ask } = scriptedJev([{ operation: 'UPLOAD', file_for_2: 'secret' }]);
    const { tab, asTab } = fakeTab([profile('a')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Set my picture', values: { secret: '/etc/passwd' }, files: { avatar: AVATAR }, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(tab.uploads).toEqual([]);
  });

  it('lists no file fields and offers no UPLOAD when no files are declared', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([page()]);
    await new BrowserTask(asTab, ask, { goal: 'Book it', changeWaitMs: 0 }).run();
    expect(tab.wantedFiles).toBe(false);
    expect(Object.keys((requests[0].questions.operation as any).criteria)).not.toContain('UPLOAD');
    expect(requests[0].state).not.toHaveProperty('supplied_files');
  });
});

describe('a run stops when the caller cancels or the time budget passes, never mid-input', () => {
  const CANCELLED = 'Cancelled by the caller';
  const click = { operation: 'CLICK', click_target: '1' };
  const changingPages = () => 'abcdefghijklmnop'.split('').map((fingerprint) => page({ fingerprint }));

  afterEach(() => vi.useRealTimers());

  it('stops before the first decision when the caller already cancelled', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { asTab, acted } = fakeTab(changingPages());
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 0 }).run({ signal: AbortSignal.abort() });
    expect(summary).toMatchObject({ status: 'blocked', reason: CANCELLED, steps: [] });
    expect(requests).toHaveLength(0);
    expect(acted).toEqual([]);
  });

  it('stops inside a wait instead of waiting it out', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'WAIT' }]);
    const { asTab } = fakeTab([page({ fingerprint: 'same' })]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 30_000 }).run({ signal: controller.signal });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(summary).toMatchObject({ status: 'blocked', reason: CANCELLED });
    expect(requests).toHaveLength(1);
  });

  it('cancels a Jev request in flight and never reports it as a model error', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    // A request that never answers, whatever its signal does: the run must not wait for it.
    const ask: Ask = (_request, options) => {
      signals.push(options?.signal);
      return new Promise(() => undefined);
    };
    const { asTab, acted } = fakeTab();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 0 }).run({ signal: controller.signal });
    expect(summary).toMatchObject({ status: 'blocked', reason: CANCELLED });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(acted).toEqual([]);
  });

  it('ends step_budget, naming the time budget, when max_seconds passes mid-run', async () => {
    vi.useFakeTimers();
    const scripted = scriptedJev([click]);
    // Each decision takes a second.
    const ask: Ask = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return scripted.ask(request);
    };
    const { asTab, acted } = fakeTab(changingPages());
    const running = new BrowserTask(asTab, ask, { goal: 'Open', maxSeconds: 2.5, changeWaitMs: 0 }).run();
    await vi.advanceTimersByTimeAsync(5000);
    const summary = await running;
    expect(summary.status).toBe('step_budget');
    expect(summary.reason).toBe('Reached the time budget of 2.5 s (max_seconds) after 2 actions without finishing');
    expect(acted).toHaveLength(2);
  });

  it('lets an input in flight finish, reports it, and runs nothing after it', async () => {
    const { ask } = scriptedJev([click]);
    const { tab, asTab, acted } = fakeTab(changingPages());
    const controller = new AbortController();
    const act = tab.act;
    tab.act = async (...args) => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return act(...args);
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 30_000 }).run({ signal: controller.signal });
    expect(summary).toMatchObject({ status: 'blocked', reason: CANCELLED });
    expect(acted).toEqual([{ label: 'Open Full name' }]);
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0]).toMatchObject({ operation: 'CLICK', element: 'Open Full name', page_changed: true });
  });

  it('runs the session normally on the next call after a cancel', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.95 }]);
    const { asTab } = fakeTab();
    const task = new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'Open', changeWaitMs: 0 });
    expect((await task.run({ signal: AbortSignal.abort() })).reason).toBe(CANCELLED);
    expect((await task.run()).status).toBe('done');
  });
});

describe('a run stays on the allowed hosts and off the blocked ones', () => {
  const click = { operation: 'CLICK', click_target: '1' };
  const ON_SITE = { allowed: ['fixture'], blocked: [] };
  const offSite = (url: string) => page({ url, fingerprint: url });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('ends blocked, naming the host, when a click lands on another host, and decides nothing there', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { asTab, acted } = fakeTab([page(), offSite('https://partner.example/offer')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Claim the offer', hosts: ON_SITE, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toBe(
      "After \"Open Full name\" the page is outside this run's hosts: partner.example is outside the allowed hosts (fixture); the run stopped without going back",
    );
    expect(summary.url).toBe('https://partner.example/offer');
    expect(acted).toEqual([{ label: 'Open Full name' }]);
    expect(requests).toHaveLength(1);
  });

  it('ends blocked before any request when the page is already outside (an open tab, a redirect)', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { asTab, acted } = fakeTab([offSite('https://sso.example/login')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', hosts: ON_SITE, changeWaitMs: 0 }).run();
    expect(summary).toMatchObject({
      status: 'blocked',
      reason: "The page is outside this run's hosts: sso.example is outside the allowed hosts (fixture); the run stopped without going back",
    });
    expect(requests).toHaveLength(0);
    expect(acted).toEqual([]);
  });

  it('ends blocked on a blocked host matched by a wildcard', async () => {
    const { ask } = scriptedJev([click]);
    const { asTab } = fakeTab([page(), offSite('https://ads.tracker.io/r')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', hosts: { blocked: ['*.tracker.io'] }, changeWaitMs: 0 }).run();
    expect(summary.reason).toBe(
      "After \"Open Full name\" the page is outside this run's hosts: ads.tracker.io is a blocked host (*.tracker.io); the run stopped without going back",
    );
  });

  it('carries on across hosts when no lists are set', async () => {
    const { ask } = scriptedJev([click, { operation: 'DONE', done_check: 0.95 }]);
    const { asTab } = fakeTab([page(), offSite('https://partner.example/offer')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'Open', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
  });

  it('lets a later call narrow the lists, and refuses one that widens them', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { asTab } = fakeTab([page()]);
    const task = new BrowserTask(asTab, ask, { goal: 'Open', hosts: { allowed: ['fixture', 'other.example'], blocked: [] }, maxSteps: 1, changeWaitMs: 0 });
    expect(() => task.update({ allowedHosts: ['*.fixture'] })).toThrow(/a call can only narrow them/);
    task.update({ allowedHosts: ['other.example'] });
    const summary = await task.run();
    expect(summary.reason).toBe("The page is outside this run's hosts: fixture is outside the allowed hosts (other.example); the run stopped without going back");
    expect(requests).toHaveLength(0);
  });

  describe('a new session started through the runner', () => {
    const startAt = async (url: string, hosts: { allowedHosts?: string[]; blockedHosts?: string[] }) => {
      vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
      const { ask } = scriptedJev([click]);
      vi.spyOn(model, 'createAsk').mockReturnValue(ask);
      vi.spyOn(chrome, 'connectChrome').mockResolvedValue({ cdp: {} } as chrome.ChromeHandle);
      const open = vi.spyOn(Tab, 'open').mockResolvedValue(fakeTab([page({ url })]).asTab);
      const task = createRunner('launch-headless').start({ goal: 'Open', url, maxSteps: 1, changeWaitMs: 0, ...hosts });
      return { task, open };
    };

    it('never opens a start URL outside the allowed hosts', async () => {
      const { task, open } = await startAt('https://evil.example/', { allowedHosts: ['fixture'] });
      await expect(task).rejects.toThrow('Not opened: evil.example is outside the allowed hosts (fixture)');
      expect(open).not.toHaveBeenCalled();
    });

    it("applies the server's JEVWAY_ALLOWED_HOSTS and JEVWAY_BLOCKED_HOSTS, which a call can narrow but never widen", async () => {
      vi.stubEnv('JEVWAY_ALLOWED_HOSTS', '*.example.com');
      vi.stubEnv('JEVWAY_BLOCKED_HOSTS', 'ads.example.com');
      await expect((await startAt('https://evil.example/', {})).task).rejects.toThrow('evil.example is outside the allowed hosts (*.example.com)');
      await expect((await startAt('https://ads.example.com/', {})).task).rejects.toThrow('ads.example.com is a blocked host (ads.example.com)');
      await expect((await startAt('https://shop.example.com/', { allowedHosts: ['evil.example'] })).task).rejects.toThrow(
        /a call can only narrow them/,
      );
      const { task, open } = await startAt('https://shop.example.com/', { allowedHosts: ['shop.example.com'] });
      await expect(task).resolves.toBeInstanceOf(BrowserTask);
      expect(open).toHaveBeenCalled();
    });
  });
});

describe('a bot wall', () => {
  // npm's Cloudflare challenge as headless Chrome saw it: nothing on it to act on but a wait.
  const wallPage = (fingerprint = 'wall') =>
    page({
      url: 'https://www.npmjs.com/',
      title: 'Just a moment...',
      text: 'www.npmjs.com\nPerforming security verification\nThis website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.\nRay ID:\na4c627515b445548\nPerformance and Security by\nCloudflare\nPrivacy',
      actions: [{ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }],
      fingerprint,
    });
  const realPage = (fingerprint = 'real') => page({ url: 'https://www.npmjs.com/package/zod', title: 'zod - npm', text: 'zod\nTypeScript-first schema validation', fingerprint });

  it('ends the run blocked, naming the wall, without spending a decision on it', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'WAIT' }]);
    const { asTab, acted } = fakeTab([wallPage()]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('bot check (Cloudflare;');
    expect(summary.reason).toContain('jevway never tries to get past one');
    expect(summary.wall).toEqual({ kind: 'bot_check', origin: 'https://www.npmjs.com', name: 'cloudflare' });
    expect(summary.page_text).toContain('Performing security verification');
    expect(requests).toHaveLength(0);
    expect(acted).toEqual([]);
  });

  it('waits out a check that clears by itself, then goes on without having asked Jev about it', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab([wallPage('w1'), wallPage('w2'), realPage()]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 5000 }).run();
    expect(summary.status).toBe('done');
    expect(summary.title).toBe('zod - npm');
    expect(summary.wall).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain('Performing security verification');
  });

  it('never ends done on a page that turned into a check while Jev decided', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.95 }]);
    const { tab, asTab } = fakeTab([realPage(), wallPage()]);
    tab.fresh = async () => false;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('bot check (Cloudflare;');
    expect(summary.title).toBe('Just a moment...');
    expect(summary.wall).toMatchObject({ kind: 'bot_check', name: 'cloudflare' });
  });

  it('does not wait out a check a second time when it comes back in the same call', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { asTab } = fakeTab([wallPage('w1'), realPage(), wallPage('w2')]);
    const started = performance.now();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 1000 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('bot check (Cloudflare;');
    expect(requests).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('stops waiting out a check as soon as the caller cancels, and reports the cancel', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'WAIT' }]);
    const { asTab } = fakeTab([wallPage()]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 30_000 }).run({
      signal: controller.signal,
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(summary).toMatchObject({ status: 'blocked', reason: 'Cancelled by the caller' });
    expect(requests).toHaveLength(0);
  });

  it('runs a page that only discusses captchas as any other page', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const thread = page({
      title: 'Ask HN: Are captchas still worth it? | Hacker News',
      text: 'Ask HN: Are captchas still worth it?\nWe dropped Google Captcha v3. The "I am not a robot" checkbox costs more signups than the bots it stops; verify you are human pages punish VPN users.',
    });
    const { asTab } = fakeTab([thread]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open the thread', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.wall).toBeUndefined();
    expect(requests).toHaveLength(1);
  });
});

describe('a needs_input names the fields it wants', () => {
  it('names the field Jev chose when no supplied value fits it', async () => {
    const { ask } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE }]);
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 0 }).run();
    expect(summary.reason).toBe('No supplied value fits the field "Email address"');
    expect(summary.missing).toEqual([{ label: 'Email address', role: 'textbox', path: '/stays' }]);
  });

  it('names every empty field a BLOCKED has no value for, in page order', async () => {
    const { ask } = scriptedJev([{ operation: 'BLOCKED' }]);
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Book', changeWaitMs: 0 }).run();
    expect(summary.reason).toBe('Blocked: no supplied value for "Full name", "Email address"');
    expect(summary.missing).toEqual([
      { label: 'Full name', role: 'textbox', path: '/stays' },
      { label: 'Email address', role: 'textbox', path: '/stays' },
    ]);
  });

  it('leaves it out of any other hand-back', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Pay', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('needs_confirmation');
    expect(summary).not.toHaveProperty('missing');
  });
});

describe("the caller's checks on the final page", () => {
  const confirmed = { type: 'text_contains', text: 'Booking confirmed' } as const;
  const onStays = { type: 'url_contains', text: '/stays' } as const;
  const showsDetails = { type: 'text_contains', text: 'your details' } as const;

  it('turns a done whose check fails into uncertain, naming the failed check', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [confirmed, onStays], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('uncertain');
    expect(summary.reason).toMatch(/^Jev reported done, but 1 of 2 checks failed on the final page: text_contains "Booking confirmed"/);
    expect(summary.checks).toEqual([
      expect.objectContaining({ type: 'text_contains', text: 'Booking confirmed', pass: false }),
      expect.objectContaining({ type: 'url_contains', text: '/stays', pass: true }),
    ]);
  });

  it('keeps a done whose checks all pass, and returns each result', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays, showsDetails], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.checks?.map((check) => check.pass)).toEqual([true, true]);
  });

  it('turns an unsure hand-back into done when every check passes and done_when scored 0.5+ on that page', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.6 }]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'The details form shows', checks: [onStays, showsDetails], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.reason).toMatch(/^All 2 checks passed on the final page and "The details form shows" scored 0\.6 there \(the run had ended uncertain: /);
    expect(summary).not.toHaveProperty('stuck');
    expect(acted).toEqual([]);
  });

  it('turns a blocked run into done the same way', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.6 }]);
    const { tab, asTab } = fakeTab(['a', 'b', 'c', 'd'].map((fingerprint) => page({ fingerprint })));
    tab.unreachable = 10;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [showsDetails], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.reason).toMatch(/the run had ended blocked: "Open Full name" could not be reached 3 times/);
  });

  it('never turns a hand-back into done without done_when', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.9 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', checks: [onStays, showsDetails], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('uncertain');
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
  });

  it('never turns a hand-back into done when done_when scored under 0.5', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.3 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('uncertain');
  });

  it('never counts a done_when score made before the last action ran', async () => {
    // Three clicks change nothing; the last look scores 0.3, so the guard stops on the third click's decision (0.6, made before it ran).
    const { ask } = scriptedJev([
      { operation: 'CLICK', click_target: '1', done_check: 0.6 },
      { operation: 'CLICK', click_target: '1', done_check: 0.6 },
      { operation: 'CLICK', click_target: '1', done_check: 0.6 },
      { operation: 'CLICK', click_target: '1', done_check: 0.3 },
    ]);
    const { asTab, acted } = fakeTab(['a', 'a', 'a', 'a', 'a'].map((fingerprint) => page({ fingerprint })));
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays], changeWaitMs: 0 }).run();
    expect(acted).toHaveLength(3);
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toBe('The last 3 actions did not change the page');
  });

  it('needs the done_when score at 0.75 while an edit is unsaved', async () => {
    const run = async (doneCheck: number) => {
      const { ask } = scriptedJev([
        { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'name' },
        { operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: doneCheck },
      ]);
      const { asTab } = fakeTab(['a', 'b', 'c'].map((fingerprint) => page({ fingerprint })));
      return new BrowserTask(asTab, ask, { goal: 'Name', values: { name: 'Ada' }, doneWhen: 'x', checks: [onStays], changeWaitMs: 0 }).run();
    };
    expect((await run(0.6)).status).toBe('uncertain');
    expect((await run(0.8)).status).toBe('done');
  });

  it('never turns a stop that is not a judgment of progress into done, whatever the checks say', async () => {
    // The page re-renders under every click: a browser-level stop, decided on the final page with done_when at 0.6.
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.6 }]);
    const { tab, asTab, acted } = fakeTab(Array.from({ length: 8 }, (_, i) => page({ fingerprint: String(i) })));
    tab.stale = 100;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays, showsDetails], maxSteps: 1, changeWaitMs: 0 }).run();
    expect(acted).toEqual([]);
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toMatch(/^The page kept changing under the click/);
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
  });

  it('leaves a question for the caller as it is, whatever the checks say', async () => {
    const { ask } = scriptedJev([{ operation: 'BLOCKED', done_check: 0.6 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('needs_input');
    expect(summary.checks?.[0].pass).toBe(true);
  });

  it("never sends the checks to Jev", async () => {
    const { ask, requests, evidenceRequests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab();
    await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [{ type: 'text_absent', text: 'zebra-crossing' }], changeWaitMs: 0 }).run();
    expect(evidenceRequests).toHaveLength(1);
    expect(JSON.stringify([...requests, ...evidenceRequests])).not.toContain('zebra-crossing');
  });

  it('keeps the checks for the session until a call replaces them', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab();
    const task = new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [confirmed], changeWaitMs: 0 });
    expect((await task.run()).status).toBe('uncertain');
    task.update({ goal: 'Book again' });
    expect((await task.run()).status).toBe('uncertain');
    task.update({ checks: [] });
    const cleared = await task.run();
    expect(cleared.status).toBe('done');
    expect(cleared).not.toHaveProperty('checks');
  });
});

describe('a done carries the page quote that proves it', () => {
  const CONFIRMATION = 'Staylist\nBooking confirmed\nReference JV-1042. A receipt is on its way.';
  const confirmedPage = (fingerprint = 'confirmed') => page({ text: CONFIRMATION, url: 'http://fixture/stays#booking', fingerprint });
  /** Answers the evidence question as given, and every other question as the script says. */
  const withEvidence =
    (ask: Ask, evidence: { choice: string; confidence: number } | Error): Ask =>
    async (request) => {
      const question: any = request.questions.evidence;
      if (!question) return ask(request);
      if (evidence instanceof Error) throw evidence;
      const ids = Object.keys(question.criteria);
      return { answers: { evidence: answer(evidence.choice, ids, evidence.confidence) }, usage: { input_tokens: 40 } };
    };

  it('asks Jev once which span shows done_when, offering the spans and absent last', async () => {
    const { ask, requests, evidenceRequests } = scriptedJev([{ operation: 'DONE', done_check: 0.9, evidence: '3' }]);
    const summary = await new BrowserTask(fakeTab([confirmedPage()]).asTab, ask, { goal: 'Book', doneWhen: 'A booking reference is showing', changeWaitMs: 0 }).run();
    expect(requests).toHaveLength(1);
    expect(evidenceRequests).toHaveLength(1);
    const question: any = evidenceRequests[0].questions.evidence;
    expect(Object.keys(evidenceRequests[0].questions)).toEqual(['evidence']);
    expect(evidenceRequests[0].state).toEqual({ page: { url: 'http://fixture/stays#booking', title: 'Staylist' } });
    expect(question.criteria).toMatchObject({ '1': 'Staylist', '2': 'Booking confirmed', '3': 'Reference JV-1042.', '4': 'A receipt is on its way.' });
    expect(Object.keys(question.criteria).at(-1)).toBe('absent');
    expect(JSON.stringify(question.instructions)).toContain('A booking reference is showing');
    expect(summary.status).toBe('done');
    expect(summary.evidence).toEqual({
      quote: 'Reference JV-1042.',
      url: 'http://fixture/stays#booking',
      deep_link: 'http://fixture/stays#booking:~:text=Reference%20JV%2D1042.',
      confidence: 0.95,
    });
    expect(summary.jev.requests).toBe(2);
    expect(summary.jev.input_tokens).toBe(200);
  });

  it('copies the chosen span word for word, never text Jev wrote', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9, evidence: '2' }]);
    const summary = await new BrowserTask(fakeTab([confirmedPage()]).asTab, ask, { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.evidence?.quote).toBe('Booking confirmed');
    expect(CONFIRMATION).toContain(summary.evidence!.quote);
  });

  it.each([
    ['absent', { choice: 'absent', confidence: 0.95 }],
    ['an unsure answer', { choice: '2', confidence: 0.2 }],
    ['a failed request', new Error('503 upstream')],
  ])('leaves the evidence out on %s, and the run stays done', async (_case, evidence) => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const summary = await new BrowserTask(fakeTab([confirmedPage()]).asTab, withEvidence(ask, evidence), { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary).not.toHaveProperty('evidence');
  });

  it('asks nothing more without done_when, or when the run hands back', async () => {
    const plain = scriptedJev([{ operation: 'DONE' }]);
    const noDoneWhen = await new BrowserTask(fakeTab([confirmedPage()]).asTab, plain.ask, { goal: 'Book', changeWaitMs: 0 }).run();
    expect(noDoneWhen.status).toBe('done');
    expect(plain.evidenceRequests).toHaveLength(0);

    const unsure = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.2 }]);
    const handedBack = await new BrowserTask(fakeTab([confirmedPage()]).asTab, unsure.ask, { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(handedBack.status).toBe('uncertain');
    expect(unsure.evidenceRequests).toHaveLength(0);
    expect(handedBack).not.toHaveProperty('evidence');
  });

  it("quotes a done the caller's checks reached too", async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.6, evidence: '2' }]);
    const summary = await new BrowserTask(fakeTab([confirmedPage()]).asTab, ask, {
      goal: 'Book',
      doneWhen: 'x',
      checks: [{ type: 'text_contains', text: 'Booking confirmed' }],
      changeWaitMs: 0,
    }).run();
    expect(summary.status).toBe('done');
    expect(summary.evidence?.quote).toBe('Booking confirmed');
  });

  it('records the evidence request in the trace with its cost', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9, evidence: '2' }]);
    const task = new BrowserTask(fakeTab([confirmedPage()]).asTab, ask, { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 });
    await task.run();
    expect(task.trace.at(-1)).toMatchObject({ decision: { operation: 'EVIDENCE', confidence: 0.95, inputTokens: 100, requests: 1 }, executed: false });
  });
});

describe('stops that are final stay final, whatever the caller checks say', () => {
  // Every check passes and done_when scored 0.6 on the page the run stopped on: enough to finish a progress guard's stop.
  const passing = [{ type: 'url_contains', text: '/' }] as const;

  it('keeps a cancel that came between the decision and its input blocked', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.6 }]);
    const { tab, asTab } = fakeTab();
    const controller = new AbortController();
    // The cancel lands while the click is refused as covered: the run stops at the check before the popup is closed.
    tab.act = async () => {
      controller.abort();
      throw new TargetUnreachable('covered', true, []);
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [...passing], changeWaitMs: 0 }).run({ signal: controller.signal });
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
    expect(summary).toMatchObject({ status: 'blocked', reason: 'Cancelled by the caller' });
  });

  it('keeps a stop for leaving the hosts blocked', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.6 }]);
    const { asTab } = fakeTab([page(), page({ url: 'https://partner.example/offer', fingerprint: 'partner' })]);
    const hosts = { allowed: ['fixture'], blocked: [] };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [...passing], hosts, changeWaitMs: 0 }).run();
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain("outside this run's hosts");
  });

  it('keeps a bot wall blocked', async () => {
    const wall = page({
      url: 'https://www.npmjs.com/',
      title: 'Just a moment...',
      text: 'www.npmjs.com\nPerforming security verification\nThis website uses a security service to protect against malicious bots.\nRay ID:\na4c627515b445548\nPerformance and Security by\nCloudflare',
      actions: [{ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }],
      fingerprint: 'wall',
    });
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.95 }]);
    const { tab, asTab } = fakeTab([page(), wall]);
    tab.fresh = async () => false;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [...passing], changeWaitMs: 0, wallWaitMs: 0 }).run();
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
    expect(summary.status).toBe('blocked');
    expect(summary.wall).toMatchObject({ kind: 'bot_check' });
  });
});

describe("the done's evidence request", () => {
  const TOKEN = 'tok Zq/81x';
  const tokenPage = page({ text: `Staylist\nBooking confirmed with token ${TOKEN}\nReference JV-1042.`, url: 'http://fixture/stays#booking' });

  it('never carries a secret, and neither does the evidence, the checks or the trace it returns', async () => {
    const { ask, evidenceRequests } = scriptedJev([{ operation: 'DONE', done_check: 0.95, evidence: '2' }]);
    const task = new BrowserTask(fakeTab([tokenPage]).asTab, ask, {
      goal: 'Book',
      doneWhen: 'Booking confirmed',
      values: { token: TOKEN },
      secretKeys: ['token'],
      checks: [{ type: 'text_contains', text: TOKEN }],
      changeWaitMs: 0,
    });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(evidenceRequests).toHaveLength(1);
    expect(summary.evidence?.quote).toContain('[secret:token]');
    for (const output of [evidenceRequests, summary, task.trace]) expect(JSON.stringify(output).toLowerCase()).not.toContain('zq/81x');
  });

  it('is cancelled with the run, and the run stays done without evidence', async () => {
    const scripted = scriptedJev([{ operation: 'DONE', done_check: 0.95 }]);
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    // The evidence request never answers, whatever its signal does: the run must not wait for it.
    const ask: Ask = (request, options) => {
      if (!request.questions.evidence) return scripted.ask(request);
      signals.push(options?.signal);
      setTimeout(() => controller.abort(), 50);
      return new Promise(() => undefined);
    };
    const started = performance.now();
    const summary = await new BrowserTask(fakeTab([tokenPage]).asTab, ask, { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 }).run({ signal: controller.signal });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(summary.status).toBe('done');
    expect(summary).not.toHaveProperty('evidence');
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('a confirmation and a host list follow the run onto a tab it opened', () => {
  const NEW_TAB: PageAction = { id: 'open', kind: 'click', node: 50, role: 'link', label: 'Open checkout in a new tab' };
  const PAY: PageAction = { id: 'pay', kind: 'click', node: 70, role: 'button', label: 'Pay €412' };
  const CANCEL_BOOKING: PageAction = { id: 'cancel', kind: 'click', node: 71, role: 'button', label: 'Cancel the booking' };
  const stays = page({ url: 'http://fixture/stays', title: 'Staylist', actions: [NEW_TAB, PAY], fingerprint: 's1' });
  const opening = (popupPages: PageState[]) => {
    const opener = fakeTab([stays, page({ ...stays, fingerprint: 's2' })]);
    const popup = fakeTab(popupPages);
    opener.tab.opensTabOn = NEW_TAB.label;
    opener.tab.next = popup.asTab;
    return { opener, popup };
  };
  // Call 1 flags "Pay €412" on /stays; call 2 confirms it, opens the new tab, then picks the script's control there.
  const flagThenConfirm = async (opener: ReturnType<typeof fakeTab>, onPopup: Record<string, any>) => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '2', commit_risk: 0.9 }, { operation: 'CLICK', click_target: '1' }, onPopup, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Pay for the Staylist booking', changeWaitMs: 0 });
    const flagged = await task.run();
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    return { flagged, summary: await task.run() };
  };

  it('allows on the new tab only the control that was flagged, and arms only the tab in use', async () => {
    const { opener, popup } = opening([page({ url: 'http://fixture/stays?step=pay', title: 'Staylist', actions: [PAY], fingerprint: 'p1' }), page({ fingerprint: 'p2' })]);
    const { flagged, summary } = await flagThenConfirm(opener, { operation: 'CLICK', click_target: '1', commit_risk: 0.9 });
    expect(flagged.status).toBe('needs_confirmation');
    expect(summary.status).toBe('done');
    expect(popup.acted.map((a) => a.label)).toEqual([PAY.label]);
    expect(popup.tab.armedAtAct).toEqual([[STAYLIST, PAY.label]]);
    expect(opener.tab.armedAtAct.every((armed) => armed === undefined)).toBe(true);
    expect(opener.tab.armed).toBeUndefined();
  });

  it('hands back a different risky control on the new tab as a new question', async () => {
    const { opener, popup } = opening([page({ url: 'http://fixture/stays?step=pay', title: 'Staylist', actions: [CANCEL_BOOKING], fingerprint: 'p1' })]);
    const { summary } = await flagThenConfirm(opener, { operation: 'CLICK', click_target: '1', commit_risk: 0.9 });
    expect(summary.status).toBe('needs_confirmation');
    expect(summary.reason).toContain('"Pay €412"');
    expect(popup.acted).toEqual([]);
  });

  it('ends blocked when the tab a click opened is on another host, deciding nothing there', async () => {
    const { opener, popup } = opening([page({ url: 'https://partner.example/pay', fingerprint: 'p1' })]);
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const hosts = { allowed: ['fixture'], blocked: [] };
    const summary = await new BrowserTask(opener.asTab, ask, { goal: 'Pay', hosts, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('partner.example is outside the allowed hosts');
    expect(summary.url).toBe('https://partner.example/pay');
    expect(requests).toHaveLength(1);
    expect(popup.acted).toEqual([]);
  });

  it('ends blocked when a tab a late script opened is on another host, before any decision', async () => {
    const { opener, popup } = opening([page({ url: 'https://partner.example/pay', fingerprint: 'p1' })]);
    opener.tab.opened = ['late'];
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const hosts = { allowed: ['fixture'], blocked: [] };
    const summary = await new BrowserTask(opener.asTab, ask, { goal: 'Pay', hosts, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.url).toBe('https://partner.example/pay');
    expect(requests).toHaveLength(0);
    expect(popup.acted).toEqual([]);
  });
});

describe("the call's stop signal and its tabs", () => {
  it('lends the signal to the tab in use while the call runs, and takes it back after', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE', done_check: 0.95 }]);
    const { tab, asTab } = fakeTab([page(), page({ fingerprint: 'b' })]);
    let during: unknown;
    const act = tab.act;
    tab.act = async (...args: Parameters<typeof act>) => {
      during = (tab as { stopSignal?: AbortSignal }).stopSignal;
      return act(...args);
    };
    await new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(during).toBeInstanceOf(AbortSignal);
    expect((tab as { stopSignal?: AbortSignal }).stopSignal).toBeUndefined();
  });
});

describe('a page error or a sign-in wall ends the run', () => {
  const FORM = 'http://fixture/repo/new';
  const nameField = (value: string): PageAction => ({ id: 'n', kind: 'fill', node: 1, role: 'textbox', label: 'Repository name', value });
  const create: PageAction = { id: 'c', kind: 'click', node: 2, role: 'button', label: 'Create repository' };
  const check: PageAction = { id: 'k', kind: 'click', node: 3, role: 'button', label: 'Check name' };
  const formPage = (fingerprint: string, text: string, value = 'my repo') =>
    page({ url: FORM, fingerprint, text, actions: [nameField(value), create, check] });
  const options = { goal: 'Create a repository named my repo', doneWhen: 'The repository page is open', changeWaitMs: 0 };
  const ERROR = 0.99;

  it('quotes the page message after a confirmed submit the page rejected', async () => {
    const { ask } = scriptedJev([
      { operation: 'CLICK', click_target: '2', commit_risk: 0.9 },
      { operation: 'CLICK', click_target: '3', page_error: ERROR },
    ]);
    const { asTab, acted } = fakeTab([formPage('a', 'New repository'), formPage('b', 'New repository\nThe repository name is invalid.')]);
    const task = new BrowserTask(asTab, ask, options);
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toBe(
      'The page shows an error after "Create repository": "The repository name is invalid."; tell the user what it says, or call again with other values.',
    );
    expect(acted.map((a) => a.label)).toEqual(['Create repository']);
  });

  it('quotes the new words the last action brought when no page message is shown', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '3' }, { operation: 'CLICK', click_target: '2', page_error: ERROR }]);
    const { asTab } = fakeTab([formPage('a', 'New repository'), formPage('b', 'New repository\nName already taken')]);
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('after "Check name": "Name already taken"');
  });

  it('goes on when nothing new on the page could be the error', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '3' }, { operation: 'DONE', page_error: ERROR, done_check: 0.95 }]);
    const { asTab } = fakeTab([formPage('a', 'New repository\nNames must be lowercase'), formPage('b', 'New repository\nNames must be lowercase')]);
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary.status).toBe('done');
  });

  it('never stops before this call has acted', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '3', page_error: ERROR }, { operation: 'DONE', done_check: 0.95 }]);
    const { asTab, acted } = fakeTab([formPage('a', 'New repository\nName already taken'), formPage('b', 'Repository created')]);
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary.status).toBe('done');
    expect(acted.map((a) => a.label)).toEqual(['Check name']);
  });

  it('lets a met completion condition win over an error score', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '3' }, { operation: 'DONE', page_error: ERROR, done_check: 0.95 }]);
    const { asTab } = fakeTab([formPage('a', 'New repository'), formPage('b', 'Repository created\nWarning: no README')]);
    expect((await new BrowserTask(asTab, ask, options).run()).status).toBe('done');
  });

  describe('a sign-in wall', () => {
    const SIGN_IN = 'http://fixture/user/login?redirect_to=%2Frepo%2Fnew';
    const loginField = (label: string, node: number, value = ''): PageAction => ({ id: `l${node}`, kind: 'fill', node, role: 'textbox', label, value });
    const signIn: PageAction = { id: 's', kind: 'click', node: 9, role: 'button', label: 'Sign in' };
    const loginPage = (username = '', password = false) =>
      page({
        url: SIGN_IN,
        fingerprint: `login-${username}-${password}`,
        text: 'Sign in',
        actions: [loginField('Username or email address', 5, username), signIn],
        passwordFields: [{ name: 'Password', filled: password }],
      });

    it('hands back naming the wall when no supplied value fits its fields', async () => {
      const { ask } = scriptedJev([{ operation: 'BLOCKED', sign_in_wall: ERROR }]);
      const { asTab } = fakeTab([loginPage()]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({
        status: 'blocked',
        reason: 'The page asks to sign in at http://fixture and no supplied value fits its fields; sign in there (or pass the values), then call again.',
        wall: { kind: 'sign_in', origin: 'http://fixture' },
      });
    });

    it('goes on when a supplied value fits the sign-in field', async () => {
      const { ask } = scriptedJev([
        { operation: 'TYPE_TEXT', sign_in_wall: ERROR, value_for_1: 'username' },
        { operation: 'DONE', done_check: 0.95 },
      ]);
      const { asTab, acted } = fakeTab([loginPage(), loginPage('ada', true)]);
      const summary = await new BrowserTask(asTab, ask, { ...options, values: { username: 'ada' } }).run();
      expect(summary).not.toHaveProperty('wall');
      expect(acted).toEqual([{ label: 'Username or email address', text: 'ada' }]);
    });

    it('goes on when the user already filled every field ("I typed the password; sign in")', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '2', sign_in_wall: ERROR }, { operation: 'DONE', done_check: 0.95 }]);
      const { asTab, acted } = fakeTab([loginPage('ada', true), page({ fingerprint: 'in', text: 'Dashboard' })]);
      const summary = await new BrowserTask(asTab, ask, { ...options, goal: 'Sign in' }).run();
      expect(summary.status).toBe('done');
      expect(acted.map((a) => a.label)).toEqual(['Sign in']);
    });
  });
});

describe('a continuing call with a new goal', () => {
  it("drops the old done_when, so an already met condition can't end the new goal at once", async () => {
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', done_check: 0.95 }]);
    const task = new BrowserTask(fakeTab([page()]).asTab, ask, { goal: 'Open the article', doneWhen: 'The article is open', changeWaitMs: 0 });
    await task.run();
    expect(requests[0].questions.done_check).toBeDefined();
    task.update({ goal: 'Open the section about its rediscovery' });
    const summary = await task.run();
    expect(requests.at(-1).questions.done_check).toBeUndefined();
    expect(summary.status).not.toBe('done');
  });

  it('keeps done_when for the same goal, and takes a new one when the call passes it', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED' }]);
    const task = new BrowserTask(fakeTab([page()]).asTab, ask, { goal: 'Open the article', doneWhen: 'The article is open', changeWaitMs: 0 });
    await task.run();
    task.update({ goal: 'Open the article' });
    await task.run();
    expect((requests.at(-1).questions.done_check as any).instructions.completion_condition).toBe('The article is open');
    task.update({ goal: 'Open the rediscovery section', doneWhen: 'The rediscovery section is shown' });
    await task.run();
    expect((requests.at(-1).questions.done_check as any).instructions.completion_condition).toBe('The rediscovery section is shown');
  });
});
