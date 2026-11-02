import { describe, expect, it } from 'vitest';
import type { PageAction, PageState } from '../../src/browser/tab.ts';
import { buildActionSpace } from '../../src/jev/action-space.ts';
import { PAGE_ERROR, SIGN_IN_WALL, STUCK, STUCK_MEANING } from '../../src/jev/instructions.ts';
import { buildRequest, decide, foldedFavourite, NO_SUPPLIED_VALUE, overflowFolds, readDecision, validChoice, type Ask } from '../../src/jev/decide.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { answer, bookingActions, boxAt, clickTargetOf, fakeTab, foldedPage, overflowChip, overflowPage, page, PAY_RECT, scriptedJev } from '../fakes.ts';

describe('Jev request', () => {
  const input = { page: page(), goal: 'Book it', history: [], checkCommitRisk: true };

  it('asks value heads only when the agent supplied values', () => {
    const space = buildActionSpace(bookingActions);
    expect(Object.keys(buildRequest({ ...input, values: {} }, space).questions)).toEqual([
      'operation',
      'type_text_target',
      'click_target',
      'commit_risk',
      'page_error',
      'sign_in_wall',
      'stuck',
    ]);
    const withValues = buildRequest({ ...input, values: { email: 'a@b.co' }, doneWhen: 'Confirmed' }, space);
    expect(withValues.questions).toHaveProperty('value_for_1');
    expect(withValues.questions).toHaveProperty('done_check');
    expect(Object.keys((withValues.questions.value_for_2 as any).criteria)).toEqual(['email', NO_SUPPLIED_VALUE]);
  });

  it('picks a lone candidate outright instead of asking a one-option question', () => {
    // Clef rejects choices with fewer than two options; the guests select here has exactly one.
    const space = buildActionSpace(bookingActions);
    const decisionInput = { ...input, values: {} };
    const operation = answer('SELECT', ['CLICK', 'TYPE_TEXT', 'SELECT', 'WAIT', 'DONE', 'BLOCKED']);
    const decision = readDecision(decisionInput, space, { operation });
    expect(decision).toMatchObject({ operation: 'SELECT', targetConfidence: 1 });
    expect(decision.action?.label).toBe('Guests → 2 guests');
  });

  it('puts a marked screenshot ahead of the JSON state as an image part', () => {
    const space = buildActionSpace(bookingActions);
    const { state } = buildRequest({ ...input, values: {}, screenshot: 'AAAA' }, space) as any;
    expect(state[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    expect(state[1]).toMatchObject({ elements: space.elements, screenshot: expect.stringContaining('numbered box') });
    expect(Array.isArray(buildRequest({ ...input, values: {} }, space).state)).toBe(false);
  });

  it('carries password field state as data, and no key when the page has none', () => {
    const space = buildActionSpace(bookingActions);
    const withFields = page({ passwordFields: [{ name: 'Password', filled: true }] });
    expect((buildRequest({ ...input, page: withFields, values: {} }, space).state as any).password_fields).toEqual([
      { name: 'Password', filled: true },
    ]);
    expect(buildRequest({ ...input, values: {} }, space).state).not.toHaveProperty('password_fields');
    expect(buildRequest({ ...input, page: page({ passwordFields: [] }), values: {} }, space).state).not.toHaveProperty('password_fields');
  });

  it('counts generic overflow labels as folds, and no other collapsed label', () => {
    // One chip per page, so the cap on how many folds are returned does not hide a match.
    const foldsOn = (chip: PageAction) => {
      const clicks = buildActionSpace(overflowPage('a', [chip]).actions).targets.CLICK!;
      const ids = Object.keys(clicks);
      return overflowFolds({ click_target: answer(ids[0], ids) }, clicks).length;
    };
    const labels = ['+1', 'Show 2 more tags', 'More', 'more options', '…', '⋯', '⋮', '...', 'ellipsis icon', 'Filters', 'Show more details', 'More details', 'Moreover'];
    expect(labels.filter((label) => foldsOn(overflowChip(32, label)))).toEqual(labels.slice(0, 9));
    expect(foldsOn(overflowChip(32, 'More', 'true'))).toBe(0);
  });

  it('ranks count chips ahead of the other overflow controls, the click head breaking ties, and keeps three', () => {
    const chips = [overflowChip(32, 'More actions'), overflowChip(33, '⋯'), overflowChip(34, '+2'), overflowChip(35, 'Show 3 more tags')];
    const clicks = buildActionSpace(overflowPage('a', chips).actions).targets.CLICK!;
    // Elements 1 and 2 are the header menus; 3 to 6 are the chips in the order above.
    const probabilities = { '1': 0.3, '2': 0.3, '3': 0.2, '4': 0.15, '5': 0.01, '6': 0.04 };
    const head = { type: 'choice', choice: '1', confidence: 0.3, probabilities };
    expect(overflowFolds({ click_target: head }, clicks).map((fold) => fold.action.label)).toEqual(['Show 3 more tags', '+2', 'More actions']);
  });

  it('counts a hover-only overflow control, whose label carries the hover suffix', () => {
    const hoverChip = { ...overflowChip(32, 'More actions (appears on hover)'), hover: true };
    const clicks = buildActionSpace(overflowPage('a', [hoverChip]).actions).targets.CLICK!;
    const ids = Object.keys(clicks);
    expect(overflowFolds({ click_target: answer(ids[0], ids) }, clicks)).toHaveLength(1);
    // The suffix is only stripped where the snapshot added it.
    const plain = buildActionSpace(overflowPage('a', [overflowChip(32, 'More actions (appears on hover)')]).actions).targets.CLICK!;
    expect(overflowFolds({ click_target: answer(Object.keys(plain)[0], Object.keys(plain)) }, plain)).toHaveLength(0);
  });

  describe('the signed-in user\'s account menu is no fold to open', () => {
    // The click head puts all its weight on the last control on the page, collapsed.
    const clicksWith = (label: string) => {
      const clicks = buildActionSpace(overflowPage('a', [overflowChip(32, label)]).actions).targets.CLICK!;
      return { clicks, ids: Object.keys(clicks) };
    };
    const favouriteOn = (label: string) => {
      const { clicks, ids } = clicksWith(label);
      return foldedFavourite({ click_target: answer(ids[ids.length - 1], ids) }, clicks) !== undefined;
    };

    it('does not favour a menu named for the account, user or profile', () => {
      const accountMenus = ['Account menu', 'User menu', 'Open user navigation menu', 'Profile menu'];
      expect(accountMenus.filter(favouriteOn)).toEqual([]);
    });

    it('still favours a collapsed control that only mentions a user, a session or an action', () => {
      const folds = ['Show 1 more session details', 'User details', 'More actions', 'Filters 1'];
      expect(folds.filter((label) => !favouriteOn(label))).toEqual([]);
    });

    it('is no overflow pick either, even one drawn as an ellipsis icon', () => {
      const { clicks, ids } = clicksWith('User menu ellipsis');
      expect(overflowFolds({ click_target: answer(ids[ids.length - 1], ids) }, clicks)).toHaveLength(0);
    });
  });

  it('rejects malformed answers so nothing executes', () => {
    expect(() => validChoice({ choice: 'X', confidence: 1, probabilities: { A: 1 } }, ['A'])).toThrow(/no action/);
    expect(() => validChoice({ choice: 'A', confidence: 1, probabilities: { A: 0.5, B: 0.1 } }, ['A', 'B'])).toThrow();
    expect(validChoice(answer('A', ['A', 'B']), ['A', 'B']).choice).toBe('A');
  });
});

describe('per-element commit risk', () => {
  const input = { page: page(), goal: 'Book', values: {}, history: [], checkCommitRisk: true };

  it('drops the page-level guess and asks about the chosen click by name', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '4', risk_4: 0.92 }]);
    const decision = await decide(ask, { ...input, elementRisk: 'chosen' });
    expect(requests[0].questions).not.toHaveProperty('commit_risk');
    expect(Object.keys(requests[1].questions)).toEqual(['risk_4']);
    expect((requests[1].questions.risk_4 as any).instructions.element.element).toBe('[4] Confirm booking and pay €412');
    expect(decision).toMatchObject({ commitRisk: 0.92, elementRisks: { '4': 0.92 }, requests: 2 });
  });

  it('asks about a collapsed control the click head favours when the operation is BLOCKED, and about no other', async () => {
    const folded = foldedPage('a', 'false');
    const more = clickTargetOf(folded, 'Show more details');
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', click_target: more, [`risk_${more}`]: 0.02 }]);
    const decision = await decide(ask, { ...input, page: folded, elementRisk: 'chosen' });
    expect(Object.keys(requests[1].questions)).toEqual([`risk_${more}`]);
    expect(decision).toMatchObject({ operation: 'BLOCKED', elementRisks: { [more]: 0.02 }, requests: 2 });

    const plain = foldedPage('a');
    const unfolded = scriptedJev([{ operation: 'BLOCKED', click_target: clickTargetOf(plain, 'Show more details') }]);
    expect((await decide(unfolded.ask, { ...input, page: plain, elementRisk: 'chosen' })).requests).toBe(1);
  });

  it('asks about every collapsed overflow control when the operation is BLOCKED, and about no other collapsed one', async () => {
    const chips = [overflowChip(32, 'Show 3 more tags'), overflowChip(33, '⋯'), overflowChip(34, 'Filters')];
    const state = overflowPage('a', chips);
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', click_target: clickTargetOf(state, 'Open menu') }]);
    const decision = await decide(ask, { ...input, page: state, elementRisk: 'chosen' });
    const judged = ['Show 3 more tags', '⋯'].map((label) => clickTargetOf(state, label));
    expect(Object.keys(requests[1].questions)).toEqual(judged.map((index) => `risk_${index}`));
    expect(Object.keys(decision.elementRisks!)).toEqual(judged);
  });

  it('judges the overflow controls for an unsure step once the bar is passed, and for a confident one never', async () => {
    const state = overflowPage('a', [overflowChip(32, 'Show 1 more session details'), overflowChip(33, 'More actions')]);
    const menu = clickTargetOf(state, 'Open menu');
    const chips = ['Show 1 more session details', 'More actions'].map((label) => clickTargetOf(state, label));
    const judged = async (confidence: number, unsureBelow?: number) => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', confidence, click_target: menu }]);
      await decide(ask, { ...input, page: state, elementRisk: 'chosen', unsureBelow });
      return Object.keys(requests[1].questions);
    };
    expect(await judged(0.22, 0.3)).toEqual([menu, ...chips].map((index) => `risk_${index}`));
    expect(await judged(0.95, 0.3)).toEqual([`risk_${menu}`]);
    expect(await judged(0.22)).toEqual([`risk_${menu}`]);
  });

  describe('with a collapsed "More actions" on each of five rows', () => {
    const chips = [0, 1, 2, 3, 4].map((row) => overflowChip(32 + row, 'More actions'));
    const state = overflowPage('a', chips);
    // The two header menus take indexes 1 and 2, so row n's chip is element 3 + n.
    const rowChip = (row: number) => String(3 + row);

    it('judges only three of them by name when the operation is BLOCKED', async () => {
      const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', click_target: clickTargetOf(state, 'Open menu') }]);
      await decide(ask, { ...input, page: state, elementRisk: 'chosen' });
      expect(Object.keys(requests[1].questions)).toEqual([0, 1, 2].map((row) => `risk_${rowChip(row)}`));
    });

    it('picks the three the click head ranks highest', async () => {
      const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', click_target: rowChip(4) }]);
      await decide(ask, { ...input, page: state, elementRisk: 'chosen' });
      expect(Object.keys(requests[1].questions).sort()).toEqual([4, 0, 1].map((row) => `risk_${rowChip(row)}`).sort());
    });
  });

  it('scores the ranked taps for the autopilot, and a malformed score counts as risky', async () => {
    const ask: Ask = async (request) => {
      if (!('operation' in request.questions)) return { answers: { risk_1: { noul: 0.1 } }, usage: { input_tokens: 1 } };
      return scriptedJev([{ operation: 'WAIT' }]).ask(request);
    };
    const decision = await decide(ask, { ...input, elementRisk: 'ranked' });
    expect(decision.elementRisks).toEqual({ '1': 0.1, '4': 1 });
  });

  describe('with the page-level question kept (Jev)', () => {
    const run = async (script: Record<string, any>) => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', ...script }]);
      const { asTab, acted } = fakeTab();
      const summary = await new BrowserTask(asTab, ask, { goal: 'Pay', maxSteps: 1, elementRisk: true, pageRisk: true, changeWaitMs: 0 }).run();
      return { summary, acted };
    };

    it('holds the click when only the chosen element looks irreversible', async () => {
      const { summary, acted } = await run({ commit_risk: 0.2, risk_4: 0.8 });
      expect(summary.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
    });

    it('holds the click when only the page looks irreversible: the higher of the two wins', async () => {
      const { summary, acted } = await run({ commit_risk: 0.8, risk_4: 0.1 });
      expect(summary.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
    });

    it('lets the click through when both questions find it safe', async () => {
      const { acted } = await run({ commit_risk: 0.1, risk_4: 0.1 });
      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
    });

    it('asks the page-level question only when pageRisk is on', () => {
      const space = buildActionSpace(bookingActions);
      expect(buildRequest({ ...input, elementRisk: 'chosen', pageRisk: true }, space).questions).toHaveProperty('commit_risk');
      expect(buildRequest({ ...input, elementRisk: 'chosen', pageRisk: false }, space).questions).not.toHaveProperty('commit_risk');
    });

    // An issue form: a Labels dropdown beside a Create button, so the page-level question reads the Create button.
    describe('opening a collapsed control', () => {
      const issueForm = (expanded?: string) =>
        page({
          actions: [
            { id: 'labels', kind: 'click', node: 10, role: 'button', label: 'Labels', ...(expanded && { expanded }) },
            { id: 'create', kind: 'click', node: 11, role: 'button', label: 'Create issue' },
            { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
          ],
        });
      const opening = async (form: PageState, script: Record<string, any>) => {
        const labels = clickTargetOf(form, 'Labels');
        const { ask } = scriptedJev([{ operation: 'CLICK', click_target: labels, [`risk_${labels}`]: 0.01, ...script }]);
        const { asTab, acted } = fakeTab([form]);
        const options = { goal: 'Label the issue', maxSteps: 1, elementRisk: true, pageRisk: true, changeWaitMs: 0 };
        const task = new BrowserTask(asTab, ask, options);
        const summary = await task.run();
        return { summary, acted, commitRisk: task.trace[0].decision.commitRisk };
      };

      it('is judged by its name alone: the page-level question reads the Create button, not the dropdown', async () => {
        const { summary, acted, commitRisk } = await opening(issueForm('false'), { commit_risk: 0.55 });
        expect(commitRisk).toBe(0.01);
        expect(acted).toEqual([{ label: 'Labels' }]);
        expect(summary.status).not.toBe('needs_confirmation');
      });

      it('keeps the higher of the two for a control that is not collapsed', async () => {
        const { summary, acted, commitRisk } = await opening(issueForm(), { commit_risk: 0.55 });
        expect(commitRisk).toBe(0.55);
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });

      it('keeps the higher of the two for a control that is already open', async () => {
        const { summary, acted } = await opening(issueForm('true'), { commit_risk: 0.55 });
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });

      it('still asks for confirmation when its name says irreversible', async () => {
        const form = issueForm('false');
        const { summary, acted } = await opening(form, { commit_risk: 0.1, [`risk_${clickTargetOf(form, 'Labels')}`]: 0.7 });
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });
    });

    // The same form with its Labels list open: the page-level question still reads the Create button, not the row picked.
    describe('picking from an open list', () => {
      const openList = (row: { role: string; label: string }, listExpanded?: string) =>
        page({
          actions: [
            { id: 'labels', kind: 'click', node: 10, role: 'combobox', label: 'Labels', ...(listExpanded && { expanded: listExpanded }) },
            { id: 'row', kind: 'click', node: 12, ...row },
            { id: 'other', kind: 'click', node: 13, role: row.role, label: 'help wanted' },
            { id: 'create', kind: 'click', node: 11, role: 'button', label: 'Create issue' },
            { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
          ],
        });
      const picking = async (form: PageState, label: string, script: Record<string, any>) => {
        const row = clickTargetOf(form, label);
        const { ask } = scriptedJev([{ operation: 'CLICK', click_target: row, commit_risk: 0.55, [`risk_${row}`]: 0.01, ...script }]);
        const { asTab, acted } = fakeTab([form]);
        const options = { goal: 'Label the issue', maxSteps: 1, elementRisk: true, pageRisk: true, changeWaitMs: 0 };
        const task = new BrowserTask(asTab, ask, options);
        const summary = await task.run();
        return { summary, acted, commitRisk: task.trace[0].decision.commitRisk };
      };

      it('is judged by its own name: the page-level question reads the Create button, not the row', async () => {
        const form = openList({ role: 'option', label: 'bug' }, 'true');
        const { summary, acted, commitRisk } = await picking(form, 'bug', {});
        expect(commitRisk).toBe(0.01);
        expect(acted).toEqual([{ label: 'bug' }]);
        expect(summary.status).not.toBe('needs_confirmation');
      });

      it.each(['menuitemcheckbox', 'menuitemradio'])('judges a %s row the same way', async (role) => {
        const form = openList({ role, label: 'bug' }, 'true');
        const { summary, acted, commitRisk } = await picking(form, 'bug', {});
        expect(commitRisk).toBe(0.01);
        expect(acted).toEqual([{ label: 'bug' }]);
        expect(summary.status).not.toBe('needs_confirmation');
      });

      it.each([
        ['menuitem', 'Delete'],
        ['checkbox', 'Subscribe'],
      ])('keeps the higher of the two for a %s row, which performs an action', async (role, label) => {
        const form = openList({ role, label }, 'true');
        const { summary, acted, commitRisk } = await picking(form, label, {});
        expect(commitRisk).toBe(0.55);
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });

      it.each([undefined, 'false'])('keeps the higher of the two for an option when no list is open (expanded %s)', async (listExpanded) => {
        const form = openList({ role: 'option', label: 'bug' }, listExpanded);
        const { summary, acted, commitRisk } = await picking(form, 'bug', {});
        expect(commitRisk).toBe(0.55);
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });

      it('still asks for confirmation when the option name says irreversible', async () => {
        const form = openList({ role: 'option', label: 'Delete project' }, 'true');
        const { summary, acted, commitRisk } = await picking(form, 'Delete project', { commit_risk: 0.1, [`risk_${clickTargetOf(form, 'Delete project')}`]: 0.8 });
        expect(commitRisk).toBe(0.8);
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });
    });
  });
});

describe('screenshots as TypeSafe assets, with Box', () => {
  const input = { page: page(), goal: 'Pay', values: {}, history: [], checkCommitRisk: true };

  it('places the screenshot as an asset under `screenshot` and asks where the next click belongs', () => {
    const space = buildActionSpace(bookingActions);
    const { state, questions } = buildRequest(
      { ...input, screenshot: 'AAAA', imageTransport: 'assets', box: true },
      space,
    ) as any;
    expect(Array.isArray(state)).toBe(false);
    expect(state.screenshot.constructor.name).toBe('Image');
    expect(questions.next_click_box).toMatchObject({ type: 'box' });
    expect(questions).toHaveProperty('next_click_present');
    expect(questions).toHaveProperty('next_click_commit_risk');
  });

  it('turns the next-click box into the observed target it covers, and checks the chosen click', async () => {
    const { ask, requests } = scriptedJev([
      {
        operation: 'CLICK',
        click_target: '4',
        next_click_box: boxAt(PAY_RECT),
        next_click_present: 0.95,
        next_click_commit_risk: 0.97,
        target_visible: 0.99,
        target_box: boxAt(PAY_RECT),
      },
    ]);
    const decision = await decide(ask, { ...input, screenshot: 'AAAA', imageTransport: 'assets', box: true });
    expect(decision.nextClick).toMatchObject({ match: '4', present: 0.95, commitRisk: 0.97 });
    expect(Object.keys(requests[1].questions)).toEqual(['target_visible', 'target_box']);
    expect(decision.targetCheck!.visible).toBe(0.99);
    expect(decision.targetCheck!.overlap).toBeCloseTo(1);
  });

  it('asks the risk of the element the box covers by name, even when no click was chosen', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'BLOCKED', next_click_box: boxAt(PAY_RECT), next_click_present: 0.9, next_click_commit_risk: 0.02, risk_4: 0.95 },
    ]);
    const decision = await decide(ask, { ...input, screenshot: 'AAAA', imageTransport: 'assets', box: true, elementRisk: 'chosen' });
    expect(Object.keys(requests[1].questions)).toEqual(['risk_4']);
    expect(decision).toMatchObject({ nextClick: { match: '4', commitRisk: 0.02 }, elementRisks: { '4': 0.95 }, requests: 2 });
  });
});

describe('a secret never reaches Jev through the keys other features add', () => {
  const TOKEN = 'ghp_9fK2xQv7LmN4pR8sT1wY6zB3cD5eH0jA2uI7kW4nM8qP';
  const secret = { values: { token: TOKEN }, secretKeys: ['token'] };
  const leaked = (anything: unknown) => {
    const text = JSON.stringify(anything);
    return [TOKEN, TOKEN.slice(0, 20)].filter((form) => text.includes(form));
  };

  it('keeps it out of a declared file name', () => {
    const PICKER: PageAction = { id: 'e9', kind: 'upload', node: 80, role: 'file', label: 'Upload a key (file field)', value: '' };
    const keyPage = page({ actions: [PICKER] });
    const request = buildRequest(
      { page: keyPage, goal: 'Upload my key', history: [], checkCommitRisk: true, ...secret, files: { key: `${TOKEN}.pem` } },
      buildActionSpace(keyPage.actions),
    );
    expect((request.state as any).supplied_files).toEqual({ key: '[secret:token].pem' });
    expect(leaked(request)).toEqual([]);
  });
});

describe('Jev is asked whether the page shows an error or a sign-in wall', () => {
  const input = { page: page(), goal: 'Book it', values: {}, history: [], checkCommitRisk: true };

  it('asks both on every step request, as yes/no questions about the current page', () => {
    const { questions } = buildRequest(input, buildActionSpace(bookingActions));
    expect(questions.page_error).toEqual({ type: 'noul', instructions: { goal: 'Book it', rules: PAGE_ERROR }, criteria: undefined });
    expect(questions.sign_in_wall).toEqual({ type: 'noul', instructions: { goal: 'Book it', rules: SIGN_IN_WALL }, criteria: undefined });
    expect(PAGE_ERROR).toContain('caused by the actions so far');
    expect(SIGN_IN_WALL).toContain('sign-in screen that blocks the goal');
  });

  it('records the answers in the trace and acts on neither yet', async () => {
    const steps = [{ operation: 'DONE', done_check: 0.9, page_error: 1, sign_in_wall: 1 }];
    const { ask } = scriptedJev(steps);
    const { asTab } = fakeTab([page({ fingerprint: 'a' })]);
    const task = new BrowserTask(asTab, ask, { goal: 'Book it', doneWhen: 'Booked', changeWaitMs: 0 });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(summary).not.toHaveProperty('wall');
    expect(task.trace[0].decision.answers).toMatchObject({ page_error: { noul: 1 }, sign_in_wall: { noul: 1 } });
  });
});

describe('Jev is asked whether the run is stuck, recorded only', () => {
  it('asks it on every step request with its rules and both meanings', () => {
    const { questions } = buildRequest({ page: page(), goal: 'Book it', values: {}, history: [], checkCommitRisk: true }, buildActionSpace(bookingActions));
    expect(questions.stuck).toEqual({ type: 'noul', instructions: { goal: 'Book it', rules: STUCK }, criteria: STUCK_MEANING });
    expect(STUCK_MEANING.true).toContain('a different approach is needed');
  });

  it('keeps the score in the trace and changes no status', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', stuck: 1 }, { operation: 'DONE', done_check: 0.95, stuck: 1 }]);
    const { asTab, acted } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    const task = new BrowserTask(asTab, ask, { goal: 'Open the booking', doneWhen: 'Open', changeWaitMs: 0 });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(acted).toHaveLength(1);
    // The done's evidence request is a separate question, with no stuck score.
    const steps = task.trace.filter((entry) => entry.decision.operation !== 'EVIDENCE');
    expect(steps.map((entry) => entry.decision.answers.stuck?.noul)).toEqual([1, 1]);
  });
});
