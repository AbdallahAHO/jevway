import { choice, noul, type Question } from '@typesafe-ai/sdk';
import type { PageState } from '../browser/tab.ts';
import type { Diagnostics } from './diagnostics.ts';

export const SCREEN_TYPES = {
  home: 'Landing or home screen: the entry point with top-level navigation and featured content.',
  search: 'A search input screen or search sheet where the user enters a query, destination, or dates.',
  results: 'A list or grid of search results, listings, products, or articles to choose from.',
  detail: 'A single item in depth: product, listing, article, profile of one entity.',
  filters: 'Controls to narrow or sort results: filter sheet, sort menu, facets.',
  map: 'A map-centred view of places or results.',
  form: 'A data-entry form that is not login or payment: contact, booking details, preferences.',
  auth: 'Login, sign-up, or account verification wall.',
  checkout: 'Cart, reservation summary, payment, or checkout step.',
  confirmation: 'Success or confirmation after completing an action.',
  account: 'The signed-in user area: profile, trips, orders, wishlists, settings.',
  navigation_menu: 'An open navigation menu or drawer listing site sections.',
  modal: 'A dialog, popup, cookie/consent banner, or bottom sheet covering the page that is not one of the above.',
  onboarding: 'Intro, tutorial, or feature announcement steps.',
  content: 'Informational or editorial content: help, about, blog, policy.',
  error: 'An error page or failure state: 404, crash, access denied.',
} as const;

export type ScreenType = keyof typeof SCREEN_TYPES;

export const PATTERNS = {
  bottom_navigation: 'A persistent bottom tab bar with section icons.',
  top_app_bar: 'A header bar with logo, title, or back button.',
  menu_button: 'A hamburger or overflow menu button that opens navigation.',
  search_bar: 'A visible search field or search pill.',
  card_list: 'A vertical list or grid of repeated cards.',
  carousel: 'A horizontally scrolling row of items or images.',
  filter_chips: 'Tappable chips or pills that filter or switch categories.',
  sheet_or_dialog: 'A bottom sheet, modal dialog, or overlay covering content.',
  date_picker: 'A calendar or date range picker.',
  map_view: 'An interactive map.',
  form_fields: 'Several text inputs, selects, or toggles to fill in.',
  primary_cta: 'One dominant call-to-action button (Reserve, Buy, Continue, Sign up).',
  consent_banner: 'A cookie or privacy consent banner.',
  price_display: 'Prices, totals, or fees shown to the user.',
} as const;

export interface VisitedScreen {
  id: string;
  type: ScreenType;
  title: string;
  url: string;
  excerpt: string;
}

export interface ScreenJudgments {
  type: ScreenType;
  typeConfidence: number;
  patterns: (keyof typeof PATTERNS)[];
  /** An existing screen id when Jev judges this to be the same screen (same purpose and content), else null. */
  sameAs: string | null;
  authWall: number;
  errorState: number;
  emptyState: number;
  deadEnd: number;
}

const NEW_SCREEN = 'NEW_SCREEN';

/**
 * Screen understanding asked in the same Jev request as the next-step decision: what screen this is,
 * which UI patterns it uses, whether it repeats a visited screen, and QA states worth flagging.
 *
 * @example
 * decide(ask, { ...input, extraQuestions: screenQuestions(visited) }) // still one round trip
 */
export const screenQuestions = (visited: VisitedScreen[]): Record<string, Question> => ({
  screen_type: choice(
    'What kind of screen is the user looking at right now? Judge the dominant purpose of the visible content and controls (page.text and elements). The URL and title are weak evidence: sheets, dialogs and single-page apps often keep the previous URL and title.',
    SCREEN_TYPES,
  ),
  ...Object.fromEntries(
    Object.entries(PATTERNS).map(([pattern, definition]) => [
      `pattern_${pattern}`,
      noul({ question: 'Is this UI pattern visible on the current screen?', pattern: definition }),
    ]),
  ),
  ...(visited.length && {
    same_screen: choice(
      {
        question:
          "Is the current page the same screen as one already visited? Compare the visible content and controls with each visited screen's excerpt. Same screen means the same purpose and same main content, even if scroll position, a counter, or rotating images differ. A sheet or dialog opened over a page is a DIFFERENT screen from that page, even with the same URL and title. Different items of the same kind (another listing, another article) are NOT the same screen.",
        visited_screens: visited.slice(-20) as any,
      },
      {
        ...Object.fromEntries(visited.slice(-20).map((screen) => [screen.id, `${screen.type}: ${screen.title}`])),
        [NEW_SCREEN]: 'A screen that has not been visited yet.',
      },
    ),
  }),
  auth_wall: noul('Does the current screen require logging in or signing up before the user can continue?'),
  error_state: noul('Does the screen show an error message, failure, or broken state to the user?'),
  empty_state: noul(
    'Does the screen show an empty state: an area meant to list content says or shows there is nothing (no results, nothing saved, no trips)? An unfilled form or search field is NOT an empty state.',
  ),
  dead_end: noul('Is this a dead end for a mobile user: no clear way forward and no visible way back or to navigate?'),
});

export const readScreenJudgments = (answers: Record<string, any>): ScreenJudgments => {
  const sameScreen = answers.same_screen;
  const sameConfident =
    sameScreen && sameScreen.choice !== NEW_SCREEN && sameScreen.probabilities[sameScreen.choice] >= 0.7;
  return {
    type: answers.screen_type.choice,
    typeConfidence: answers.screen_type.confidence,
    patterns: Object.keys(PATTERNS).filter(
      (pattern) => answers[`pattern_${pattern}`]?.noul >= 0.5,
    ) as ScreenJudgments['patterns'],
    sameAs: sameConfident ? sameScreen.choice : null,
    authWall: answers.auth_wall.noul,
    errorState: answers.error_state.noul,
    emptyState: answers.empty_state.noul,
    deadEnd: answers.dead_end.noul,
  };
};

export interface QaFinding {
  kind:
    | 'console_error'
    | 'failed_request'
    | 'horizontal_overflow'
    | 'small_tap_target'
    | 'unlabeled_control'
    | 'error_state'
    | 'empty_state'
    | 'dead_end';
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

const MIN_TAP_TARGET = 44;
const TAP_ROLES = new Set([
  'button',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'combobox',
  'textbox',
  'searchbox',
]);

/**
 * Deterministic mobile QA from the snapshot and diagnostics, plus Jev's state judgments.
 * Thresholds: 44×44 CSS px tap targets (Apple HIG), any horizontal overflow, Jev states ≥ 0.6.
 */
export const qaFindings = (
  page: PageState,
  diagnostics: Diagnostics,
  judgments: ScreenJudgments,
  overflowPx: number,
  mobile: boolean,
): QaFinding[] => {
  const findings: QaFinding[] = [];
  for (const error of diagnostics.consoleErrors)
    findings.push({ kind: 'console_error', severity: 'medium', detail: error });
  for (const failure of diagnostics.failedRequests) {
    findings.push({
      kind: 'failed_request',
      severity: failure.status && failure.status < 500 ? 'low' : 'medium',
      detail: `${failure.status ?? failure.error} ${failure.url}`,
    });
  }
  if (overflowPx > 1) {
    findings.push({
      kind: 'horizontal_overflow',
      severity: 'high',
      detail: `Page is ${Math.round(overflowPx)}px wider than the viewport`,
    });
  }

  const controls = uniqueByNode(page.actions.filter((action) => action.kind === 'click' || action.kind === 'fill'));
  if (mobile) {
    const small = controls.filter(
      (action) =>
        TAP_ROLES.has(action.role ?? '') &&
        action.rect &&
        (action.rect.w < MIN_TAP_TARGET || action.rect.h < MIN_TAP_TARGET),
    );
    if (small.length) {
      findings.push({
        kind: 'small_tap_target',
        severity: 'medium',
        detail: `${small.length} control(s) under ${MIN_TAP_TARGET}×${MIN_TAP_TARGET}px: ${small
          .slice(0, 5)
          .map((action) => `"${action.label}" ${Math.round(action.rect!.w)}×${Math.round(action.rect!.h)}`)
          .join(', ')}`,
      });
    }
  }
  const unlabeled = controls.filter((action) => action.label === action.role);
  if (unlabeled.length) {
    findings.push({
      kind: 'unlabeled_control',
      severity: 'medium',
      detail: `${unlabeled.length} control(s) without an accessible name (${[...new Set(unlabeled.map((a) => a.role))].join(', ')})`,
    });
  }

  const states = [
    ['error_state', judgments.errorState, 'high', 'Screen shows an error or broken state'],
    ['empty_state', judgments.emptyState, 'low', 'Screen shows an empty state'],
    ['dead_end', judgments.deadEnd, 'medium', 'No clear way forward or back'],
  ] as const;
  for (const [kind, probability, severity, detail] of states) {
    if (probability >= 0.6) findings.push({ kind, severity, detail: `${detail} (Jev ${probability.toFixed(2)})` });
  }
  return findings;
};

const uniqueByNode = <T extends { node?: number }>(actions: T[]) => [
  ...new Map(actions.map((a) => [a.node, a])).values(),
];
