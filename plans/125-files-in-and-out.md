# Plan 125: files in and out — downloads, URL uploads, uploads in frames and drop zones, a PDF of the page

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/browser/tab.ts` `upload()` must refuse a frame's node with `"… is inside a frame, and jevway uploads only to file fields in the page itself"`.
> - `src/browser/frames.ts` `#readOne` must set `__jevIdBase`, `__jevView` and `__jevWanted`, and not `__jevFiles`.
> - `src/task/upload-files.ts` must export `checkUploadFiles` refusing a relative path.
> - No code calls `Browser.setDownloadBehavior` or `Page.printToPDF`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: L (2 days) · **Risk**: MED (browser-wide download behaviour; a fetch the caller names) · **Category**: capability
- **Planned at**: commit `75fa054`, 2026-11-02

## Why this matters

Round 14 closes the gaps that make a person step in. Files are one: an invoice download, a CV the user keeps online,
an upload form inside an embedded (often cross-origin) widget, a drag-and-drop zone with no file input, a printable copy
of a page. Today (plan 097) uploads take declared local paths only, go into the page itself only, need a file input, and
nothing comes back out of the browser.

## Current state

- `checkUploadFiles` (sync, constructor and `update()`) accepts absolute readable files only.
- `Tab.upload` throws `TargetUnreachable` for a node inside a frame; `Frames.#readOne` never sets `__jevFiles`, so frame
  file inputs are never even listed; adopted out-of-process frames never intercept the file chooser.
- `snapshot.js` lists a drop zone only as the stand-in for a hidden file input inside it.
- No download handling: in a launched Chrome a download goes nowhere jevway knows of; in the user's Chrome to their
  Downloads folder, unreported.
- `jevway_look` / `jevway look` return the page as text only.

Probes (headless and headed Chrome, 2026-11-02, this machine):
- `Browser.setDownloadBehavior({ behavior: 'allowAndName', downloadPath, eventsEnabled: true })` saves `<downloadPath>/<guid>`;
  `Browser.downloadWillBegin` carries `frameId` (the tab's target id for its main frame), `guid`, `suggestedFilename`;
  `Browser.downloadProgress` ends `completed` with `filePath`.
- `behavior: 'default'` with `eventsEnabled: true` leaves Chrome's own behaviour (the Downloads folder) and still sends
  the events, `filePath` included.
- `Input.dispatchDragEvent` (`dragEnter`, `dragOver`, `drop`) with `data.files: [path]` delivers a trusted `drop` whose
  `dataTransfer.files` holds the file.
- `Page.printToPDF` works in headless **and headed** Chrome (11 KB for the probe page). No headless restriction.

## Design (decided)

1. **Downloads, browser-wide behaviour (decided per source).** `Browser.setDownloadBehavior` is per browser context and
   one runner serves many sessions in one context, so a session's run folder can't be the download path.
   - `launch` / `launch-headless` (jevway's own throwaway browser): `allowAndName` into a staging folder made per
     connection (`<tmp>/jevway-downloads-XXXX`), so every download lands under its guid and nothing reaches the person's
     Downloads folder. A finished file is **moved** into the session's run folder.
   - `auto` and a debugging URL (the person's own Chrome): `behavior: 'default'` with events on. Their downloads keep
     going where Chrome puts them (including an "Ask where to save" dialog, if they set one); jevway only listens. A
     finished file of jevway's tab is **copied** into the run folder; the original stays where the person's Chrome and its
     download list expect it. Nothing to restore at the end (the behaviour is Chrome's default); the events stay on for
     the connection, which changes nothing a person sees. Last writer wins if another debugging client set its own path.
   - Set once when the runner connects; a failure to set it never fails a run (downloads just go unreported).
2. **Which tab a download belongs to.** The tab listens to `Browser.downloadWillBegin` and claims a download whose
   `frameId` is its own target id, one of its frames (`Frames.holds`), or a tab it opened (a `target=_blank` download
   link). Downloads in the user's other tabs are never claimed, read or moved.
3. **Waiting.** After an executed action, the run takes the downloads that began and waits for them to finish: at most
   30 s in all, ending early on the call's stop signal. A finished file goes to `<run>/downloads/<suggested name>`
   (`invoice.pdf`, then `invoice-2.pdf` on a collision); a cancelled or interrupted one is reported as such; one still
   running at the cap is reported as still downloading (its partial file is not moved). No new progress event type: 30 s
   is inside every MCP client's timeout, and the step event follows right after.
4. **What the caller sees.** The step's element gains `(downloaded invoice-1042.pdf, 84 KB)` (the existing note mechanism),
   so `story` reads `Clicked "Download invoice"; downloaded invoice-1042.pdf (84 KB).`, Jev's history carries it, and the
   page text Jev reads starts with `[Downloaded this call] invoice-1042.pdf (84 KB)` (the done check judges page text, and
   a download shows nothing on the page). The caller's `page_text` is unchanged. `files.downloads` lists every file in
   the run folder's `downloads/` as `{ path, name, bytes }`; `manifest.json` describes each as `kind: 'download'`.
   Without `output`, the file stays where Chrome saved it and the note still names it.
5. **URL uploads.** A `files` value may be an `https://` URL. `checkUploadFiles` checks its shape (https, a host, no
   credentials) and the run fetches it at the start of `run()`, before the loop, into `<run>/uploads/` (a temp folder
   without `output`), once per URL per session. The fetch: `https` only, at most 3 redirects with every hop checked again,
   each host resolved and **every** address refused when loopback, private, link-local, CGNAT, multicast, unspecified,
   or an IPv4-mapped/NAT64 form of one; the vetted address is the one connected to (`lookup` hands it back, so the name
   can't rebind between check and connect). 50 MB cap (Content-Length and a byte count while streaming), 60 s timeout.
   With host rules (the server's, narrowed by the call) the URL and every redirect must be inside them. The name comes
   from `Content-Disposition` (`filename*` then `filename`), else the URL path, made a safe base name, else the key.
   Every error starts `files.<key>: "<url>" …`. The model sees only the key and the file name, as before.
6. **Uploads in frames.** Frame reads get `__jevFiles`, so file inputs in a frame are listed the same way. `Tab.upload`
   resolves a frame's node in the frame's isolated world (an `objectId`, not by value) and calls `DOM.setFileInputFiles`
   on the frame's own session. Same freshness check (`#freshInFrame`). Adopted out-of-process frames intercept the file
   chooser too when files are declared. The declared-file rule is unchanged.
7. **Drop zones.** With files declared, `snapshot.js` lists a visible element (at least 40×40) as a drop zone only when it
   holds no file input and carries a conservative marker: an `ondrop` attribute; `dropzone`, `drop-zone`, `drop-area`,
   `droparea` or `file-drop` in its class, id or a `data-` attribute name; or its own short text (≤ 200 chars) reads
   "drag and drop", "drag & drop", "drop … file(s)" or "drop … here". The innermost such element wins. It is listed as
   `kind: 'upload'`, role `file`, `drop: true`, label `<its text or name> (drop zone)`. `Tab.upload` on it checks the
   target is fresh and uncovered (`RESOLVE_TARGET`), moves the point into the viewport for a frame, and dispatches
   `dragEnter`, `dragOver`, `drop` with `data.files: [path]` (trusted events). The page receiving the drop is checked in
   the target's world (a one-shot listener); none received is `TargetUnreachable` ("the drop zone did not take the file").
8. **PDF of the page.** `jevway_look` `pdf: true` / `jevway look --pdf`: `Page.printToPDF` (background printed, the page's
   own print CSS) on the tab read. A session look writes `<run>/looks/NN-<title slug>.pdf` and refreshes the manifest
   (`kind: 'pdf'`); a `url` or `tab` look writes `<out root>/looks/<stamp>_<host>_<4 random>/page.pdf`. The look result
   gains `pdf: <absolute path>`. Works headed and headless.

## Scope

**In scope:** `src/browser/downloads.ts` (new: behaviour per source), `tab.ts` (download tracking, frame upload, drop),
`frames.ts` (`__jevFiles`, `holds`, file chooser in adopted frames, a frame's `objectId`), `snapshot.js` (drop zones),
`src/task/upload-files.ts` (URL shape, fetch), `src/task/downloads.ts` (new: keep a finished download, its note),
`run-task.ts` (three narrow hooks: fetch URL files at `run()` start, take downloads after an action, the downloads line
in Jev's page text), `present.ts` (one note prefix), `start-task.ts` (behaviour at connect, `look({ pdf })`),
`session-service.ts` + `daemon/server.ts` (look `pdf`), `src/output/` (download/upload/pdf kinds, safe and unique
names, `files.downloads`, look PDF paths), MCP `pdf` on `jevway_look`, CLI `--pdf`, fixtures, tests, docs.

**Out of scope:** several files in one input or drop; answering an intercepted native file chooser; uploading a
downloaded file; per-session download folders; PDF options (paper size, ranges).

## Git workflow

1. `docs: add plan 125 files in and out`
2. `test: downloads, url uploads, frame uploads, drop zones and look pdfs`
3. `feat: keep downloads in the run folder and report them`
4. `feat: upload from https urls, inside frames and into drop zones`
5. `feat: save a pdf of the page from look`
6. `docs: files in and out`

Lowercase conventional commits. **No AI attribution of any kind**. Do NOT push.

## Steps

1. Tests first (no key, fakes): `test/task/upload-files.test.ts` (URL shape, public-address check, vetted lookup,
   redirects, size cap, names, host rules), `test/task/downloads.test.ts` (keep: move vs copy, collision suffix, note
   wording), `test/output/manifest.test.ts` (kinds), `test/browser/tab-capabilities.test.ts` (frame upload on the frame's
   session; drop events with the path; download claiming by frame id; the PDF call), `test/task/run-task.test.ts` (a
   download note on the step and the page-text line), `test/session/session-service.test.ts` (look pdf path). Red.
2. Implement as designed; `pnpm typecheck`, `pnpm test`.
3. MCP `pdf`, CLI `--pdf`, `files` docs; measure `tools/list` and raise the ceiling by exactly the delta.
4. Fixtures under `verify/fixture/capabilities/` (a download link, a drop zone, an upload inside a cross-origin iframe).
5. Live check (lock `live-1`/`live-2`, headless): download, URL upload, iframe upload, drop, look PDF.

## Done criteria

- [ ] Tests red first, then green; `pnpm release:check` passes
- [ ] Live: each of the five works on local fixtures in headless Chrome

## STOP conditions

- A path or URL reaches a model request (only keys and file names may).
- A download from a tab jevway does not drive is claimed, moved or copied.
- A request without files differs from main's (no drop zones or frame file fields listed without `files`).

## Maintenance note

If Chrome drops `filePath` from `Browser.downloadProgress`, the launched-browser case still works (`<staging>/<guid>`);
the user's-Chrome case then can only name the file, not copy it.
