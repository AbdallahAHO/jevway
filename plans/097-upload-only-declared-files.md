# Plan 097: Files upload only from paths the caller declares

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/browser/snapshot.js` must have `const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);`.
> - `src/jev/action-space.ts` must have `export type TargetOperation = 'CLICK' | 'TYPE_TEXT' | 'SELECT';`.
> - `verify/capabilities.ts` must have the task `upload` marked `gap: 'plan 097'`.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: M (1 day) · **Risk**: MED (a new operation in Jev's action space) · **Category**: capability
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

`docs/prior-art.md` [C3](../docs/prior-art.md#c3). Profile pictures, attachments, CSV imports and document forms need a
file; README "Limits" lists uploads as unsupported, and the reader drops every `type=file` input (`snapshot.js:12`).
Ying-Kai-Liao lists file inputs even when hidden behind a styled button (`src/page-script.mjs:56`), lets the model pick
one with an `upload` tool and sets it with Playwright's `setInputFiles` (`src/session.mjs:449-454`, `:560-563`). Their
path comes from the caller's values; ours must not: a text value is page-bound (it gets typed), and a path that came
from `values` could be typed into a field, or a typed value could become a path.

## Current state

- `values` is the only caller data the model can pick from (`value_for_<index>` heads; `NO_SUPPLIED_VALUE` →
  fed back once, then `needs_input`).
- `safe()` in `snapshot.js` excludes `password`, `file` and `hidden` inputs from listing and from the page key.
- No code calls `DOM.setFileInputFiles`. A probe (headless Chrome, 2026-11-01) showed it works with an `objectId` from
  `Runtime.evaluate`, without `DOM.enable`, on a `display:none` input, and fires the input's `change` event.

## Scope

**In scope:** `TaskOptions.files`, the MCP `files` parameter and the CLI `--files`; a file-path check
(`src/task/upload-files.ts`); `snapshot.js` (a separate pass for file inputs, `safe()` untouched); `Tab.want` and
`Tab.upload`; `action-space.ts` and `decide.ts` (the UPLOAD operation and its `file_for_` heads); `run-task.ts` (hand-
back, execution, history); tests; `verify/reader.ts`; docs; plan 094's `upload` gap.

**Out of scope:** drag-and-drop without a file input; several files in one input; a file chooser opened by a click
(intercepted, not answered); downloads.

## Design (decided)

1. **The caller declares files.** `files: { key: absolute_path }`, separate from `values` and never merged with it.
   Each path must be absolute, exist, be a regular file and be readable; otherwise the call fails before any browser
   work with the key and the reason. **Not restricted to the working directory:** the MCP server's working directory
   is wherever the agent's harness started it, unrelated to the user's files, and the restriction would only make the
   agent copy files around. The guard is that the model can only choose a key the caller declared; the skill tells
   the agent to declare only files the user asked to upload.
2. **Zero change when no files are declared.** File inputs are listed, and UPLOAD offered, only when the caller declared
   at least one file. Every existing suite passes no files, so its requests are byte-identical, and the "reject if it
   costs passes elsewhere" condition holds by construction; `verify:reader` proves both halves.
3. **The reader** (with files declared) lists each enabled `type=file` input as role `file`, kind `upload`:
   - a visible input by its own name and rect;
   - a hidden one (`display:none`, zero size, opacity 0) through what a person uses instead: its visible `<label>`, else
     the one visible button in its nearest container (3 levels at most, holding no other file input), else that
     visible container (a drop zone). Its label is the input's own name, else that stand-in's; its rect is the
     stand-in's. With no visible stand-in it isn't listed (a person couldn't reach it either).
   - The label ends with ` (file field)`, and its value is the names of the files already chosen.
4. **Jev's request** gains, only then: the operation `UPLOAD` ("Choose a file for a file field, using one of the supplied
   files."), an `upload_target` head when there are 2+ file fields, a speculative `file_for_<index>` head per field
   (8 at most) over the declared keys plus `NO_SUPPLIED_FILE`, and `supplied_files: { key: file name }` in the state.
   **The path never leaves the process**: only the key and the file's base name are sent.
5. **Execution.** `Tab.upload(action, page, path)`: the same element-level freshness check as a click, the observed node
   resolved to an `objectId` (it must still be an enabled file input), then `DOM.setFileInputFiles`. No press, so no
   input-delivery check. The step goes into history as `{ operation: 'UPLOAD', element, file_key }`.
6. **No fitting file** is the same as a value: `NO_SUPPLIED_FILE` is fed back once ("no supplied file fits this field;
   upload nothing here…"), and the second time it is `needs_input` naming the field.
7. **Native file pickers.** With files declared, the tab intercepts file choosers
   (`Page.setInterceptFileChooserDialog`), so a click on a styled "Upload" button never opens an OS dialog in the user's
   Chrome; the click simply changes nothing, and UPLOAD is the way in.

## Git workflow

1. `docs: add plan 097 upload only declared files`
2. `test: upload a declared file through its field, never a path from values`
3. `feat: upload files the caller declares`

Lowercase conventional commits. **No AI attribution of any kind**. Do NOT push.

## Steps

1. Tests first:
   - `test/upload-files.test.ts`: a relative path, a missing file, a directory, each refused naming its key; a good map
     passes through.
   - `test/jev-browse.test.ts`: with files, the request offers UPLOAD with `file_for_` heads and `supplied_files` holding
     names only (the serialized request never contains the path); without files, no UPLOAD; a chosen UPLOAD calls
     `tab.upload` with the declared path and records `file_key`; `NO_SUPPLIED_FILE` is fed back once, then
     `needs_input`; a `values` entry is never used as a path.
   - `test/tab-capabilities.test.ts`: `upload` resolves the node and calls `DOM.setFileInputFiles` with the path.
   - `verify/reader.ts`: a hidden input behind a styled button is listed (with files) at the button's rect and takes the
     file; without files the page lists exactly what it does today.
   Run them red.
2. Implement as designed; `pnpm typecheck`, `pnpm test`, `pnpm verify:reader` 100 %.
3. MCP `files`, CLI `--files`, tool description, README "Limits", `skill/jev-browse/SKILL.md`, `AGENTS.md`
   Invariants; remove the `upload` gap.

## Measure

`pnpm verify:capabilities` (false done 0, `upload` correct ≥ 2/3), then on the final branch `pnpm verify` 8/8,
`verify:redteam` 0, `verify:gotchas` strict, `JEV_CHECKOUT_RUNS=3 pnpm verify:checkout`. **REJECT** if any of those
loses a pass against main (it shouldn't: none declares files).

## Done criteria

- [ ] Tests red first, then green; typecheck clean; reader 100 %
- [ ] `upload` correct, false done 0; gates unchanged

## STOP conditions

- A path appears in any request to the model, or a `values` entry is ever used as a path.
- Any suite without files sends a request that differs from main's.

## Maintenance note

If a site's only way in is a click that opens the file chooser (no input in the DOM until then), answer the intercepted
chooser (`Page.fileChooserOpened` gives its `backendNodeId`) the same way, still only with a declared key.
