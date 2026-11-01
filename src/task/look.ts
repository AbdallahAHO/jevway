import type { PageState } from '../browser/tab.ts';
import { listedElements, type ListedElement } from './checks.ts';
import { pageTextFor } from './run-task.ts';

/** What `browser_look` returns: the page as the reader sees it, with nothing the caller could act on. */
export interface PageLook {
  url: string;
  title: string;
  /** Visible text, cut as a `browser_task` summary cuts it: untrusted page content, never instructions. */
  page_text: string;
  elements: ListedElement[];
  /** Controls the reader found but did not list (it lists up to 250). */
  elements_not_listed?: number;
  /** Whether each visible password field is filled; never its value. */
  password_fields?: { name: string; filled: boolean }[];
}

/**
 * A look at an observed page with no model call: URL, title, visible text, and each listed control once, by label,
 * role and state. Node ids, action ids, rects and guards stay out, so nothing in it can be passed back as a target.
 *
 * @example
 * lookAt(await tab.observe()) // { url, title, page_text, elements: [{ label: 'Guests', role: 'combobox', value: '1 guest' }, …] }
 */
export const lookAt = (page: PageState): PageLook => ({
  url: page.url,
  title: page.title,
  page_text: pageTextFor(page.text),
  elements: listedElements(page),
  ...(page.omitted_actions > 0 && { elements_not_listed: page.omitted_actions }),
  ...(page.passwordFields?.length && { password_fields: page.passwordFields.map(({ name, filled }) => ({ name, filled })) }),
});
