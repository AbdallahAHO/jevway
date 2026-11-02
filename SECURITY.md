# Security policy

jevway drives a real browser, often one that is signed in to the user's accounts. A bug that lets a web page push a run
past the limits its caller set is a security bug, and is handled privately.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/AbdallahAHO/jevway/security/advisories/new) (the repository's **Security**
tab, then **Report a vulnerability**).

Please don't open a public issue, pull request or discussion for it. Include:

- the jevway version (`npm ls -g jevway`, or the version `npx` fetched) and the model (`JEVWAY_MODEL`, default `jev`);
- the smallest page or steps that reproduce it, and the summary jevway returned;
- what the run did, and what the caller's settings should have stopped.

You'll get a reply within a week. Fixes ship as a patch release, and the advisory is published once a fixed version is
on npm. Reporters are credited unless they ask not to be.

## Supported versions

Only the latest release on npm gets security fixes while jevway is below 1.0.

## What counts

A page, or a model answer, that makes jevway do something its caller didn't allow:

- an irreversible click (pay, send, delete, submit) without `confirm_irreversible`, or on a control other than the one
  the `needs_confirmation` named;
- leaving `allowed_hosts`, or reaching a host in `blocked_hosts`, without the run ending `blocked`;
- typing text that isn't one of the caller's `values`, or uploading a file not declared in `files`;
- model output turned into a selector, a script, typed text, or a coordinate outside the opt-in coordinate click;
- a value named in `secret_keys` appearing unmasked in a summary, a trace, `summary.json` or `index.html`;
- a password field's value, or its length, reaching a model request;
- an API key printed by `jevway doctor`, an error message or a recording.

## What doesn't count

- Page content changing which allowed action Jev picks inside the run's limits. Page text is untrusted data by design;
  the limits above are what stop a page from going further.
- Screenshots and `run.mp4` showing a secret typed into a visible field. Recordings are pixels of the page, and the
  documentation says they aren't masked.
- Bot checks and CAPTCHAs that jevway doesn't get past. It never tries to, by design.
- Bugs in Chrome, the TypeSafe API or OpenRouter. Report those to their owners.
