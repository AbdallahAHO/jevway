# Plan 050: The checkout harness starts each shopper run already signed in, without SauceDemo's login transition

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat a1477ce..HEAD -- verify/checkout.ts` must be empty; otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: LOW (one suite's harness) · **Category**: tests
- **Planned at**: commit `a1477ce`, 2026-10-16

## Why this matters

Gate R3 (`pnpm verify:checkout`) measures shopping on SauceDemo up to the payment gate. The harness signs in on the
login page, because jev-browse never lists password fields. SauceDemo then moves to `/inventory.html` as an SPA
route change in the same document.

Probes on 2026-10-16 found that after that transition, any CDP click issued about 800 ms or more later is dropped by
the browser and never reaches the page. This holds even with raw `Input.dispatchMouseEvent` and none of jev-browse's
code. Three variations deliver the click:
- a click at about 0 ms;
- a click on the login page itself;
- loading `/inventory.html` **directly** with the `session-username` cookie set, then clicking 1.5 s later (delivered
  twice).

The root cause is open; it comes and goes through the day. Plan 048 now reports such a drop honestly ("the browser
dropped it, so nothing was clicked"), so the suite fails with an accurate reason, and the latest run showed 15 of 18
failures with that reason. The shopping chore is what R3 tests, not the sign-in. A calling agent that has signed in
with its own tool hands jev-browse a signed-in shop. The harness should do the same in a way that avoids the
transition.

## Current state

`verify/checkout.ts` (excerpt):
```ts
// The shop keeps the sign-in in a cookie, which the runner's per-run storage clearing leaves alone: drop it, then sign in.
before: async (tab) => {
  await tab.evaluate("document.cookie = 'session-username=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'");
  await tab.navigate(START_URL);
  await signIn(tab, ACCOUNT_BY_JOB[jobInRun] ?? SHOPPER_ACCOUNT);
},
```
`signIn` fills the form with a script and clicks Login synthetically, then waits for `PRODUCT_LIST` or the lock-out
error. `ACCOUNT_BY_JOB` maps `locked-out` to the locked account. The locked-out job must keep using the login page,
because its pass check is the lock-out error on `/`. `Tab.send(method, params)` is public. SauceDemo's sign-in cookie
is `session-username=<username>` on `www.saucedemo.com`, path `/`.

## Scope

**In scope**: `verify/checkout.ts` (the `before` hook, plus a helper if needed), `AGENTS.md` (the `verify:checkout` bullet, one
clause). **Out of scope**: jobs, goals, `doneWhen`, `expect`, `passes`, `src/`. Do not run `verify:langfuse` or touch the Chromes on
9333 and 9444.

## Git workflow

Commit: `test: start checkout runs signed in instead of through the login transition`. No AI attribution. Do NOT push.

## Steps

1. In `before`, for every job except the one whose account is the locked-out account:
   - clear the cookie as today;
   - set `session-username=<SHOPPER_ACCOUNT>`, either with `Network.setCookie` (domain `www.saucedemo.com`, path `/`) or
     with `document.cookie` on the origin;
   - `tab.navigate` to the product-list URL;
   - check that the product list is shown (`location.pathname === PRODUCT_LIST` and at least one "Add to cart"
     button), and throw a clear error otherwise.

   The locked-out job keeps the current `signIn` path. Keep the comment style; one line explains why: the login
   page's transition to the product list can leave the tab dropping CDP input (plan 048), and a calling agent that
   signed in hands over a signed-in shop anyway. `pnpm typecheck` → 0.
2. In AGENTS.md's `verify:checkout` bullet, replace "the harness signs in with its published test account" with "the
   harness starts each shopper run signed in (SauceDemo's session cookie, its published test account) and signs in on
   the login page only for `locked-out`". Commit.
3. Measure: run `CI=1 JEV_CHECKOUT_RUNS=3 pnpm verify:checkout` twice, at least 5 minutes apart (36 runs). Report per job
   for each pass, and how many runs ended with "received no input". Headless; the model key is in the gitignored `.env`,
   so never read or print it.

## Done criteria

- [ ] `pnpm typecheck` exits 0; two checkout passes reported, with the "received no input" count; locked-out still 3/3
- [ ] `git diff --stat` lists only `verify/checkout.ts` and `AGENTS.md`

## STOP conditions

- The cookie route doesn't show the product list (SauceDemo changed its session mechanism): report what the page shows.

## Maintenance notes

- If SauceDemo's session cookie changes name or gains a signature, go back to `signIn` and accept the drops, which 048
  reports honestly.
