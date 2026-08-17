# dsh-session-search-plus

In-place enhancement of the official DSH sidebar search box (host + browser
halves):

- **In-place enhancement of the official search box**: the browser half is a
  fork of the official `@deepseek-ai/dsh-client-ui-workspace@0.1.0-rc.6`
  compiled bundle (WorkspaceBrowser/WorkspacePicker ported wholesale; the
  profile disables the official `ui-workspace` row, see
  `~/.dsh/profiles/web/cordis.patch.yml`). The expand animation, in-place
  results replacing the session list, Esc/outside-click collapse and all
  other official behavior stay byte-identical; only the search path gets
  surgical changes (marked `// [search-plus]`): vscode-style inline mode
  toggles at the right end of the input (Aa case / ab whole word —
  pnpm/batnpmdom no longer hit npm / .* regex / fz fuzzy subsequence),
  the vscode preview window (word-bounded lcut lead + single-line
  ellipsis), and a per-session hit dropdown (up to 8, indent guide on
  hover) on each result row;
- **Private fast index**: only user/context/assistant message TEXT blocks are
  indexed (no tool arguments, results, or reasoning noise); millisecond
  queries bypass the official engine's per-call reconcile;
- **Per-session hit dropdown**: a chevron on each result row expands all
  matches in that session (up to 8);
- **Jump + highlight**: clicking a hit opens the session, locates the
  message, fills the selected occurrence (rgba(65,118,230,.16) background,
  #2b5bb8 text) and boxes every other occurrence (1px
  rgba(65,118,230,.55) border) — clearable with one click.

> Fork baseline: official package 0.1.0-rc.6 (recorded in the header comment
> of `src/client/workspace-browser.js`); unmodified regions are
> byte-identical to the official bundle and every change is marked
> `// [search-plus]`. An official upgrade requires re-porting against the new
> baseline.

## Architecture

- **Host half** (`src/index.ts`): maintains a private in-memory content
  index, built at boot from the persistence service and kept incremental
  through the `session/event` feed with (sessionId, seq) deduplication;
  serves `POST /api/search-plus/query` (substring or fzf-style fuzzy
  subsequence, case-sensitivity flag, per-session grouped hits with windowed
  snippets and match offsets).
- **Browser half** (`src/client/`): the WorkspaceBrowser fork above; content
  queries go to `/api/search-plus/query`, title filtering stays client-side.

## Related plugins

The official-index boot warmup lives in the sibling plugin
**dsh-session-search-warmup**: it commits the official SQLite FTS5 index
during the quiet boot window so the official search surface (rail mode,
fallback paths this plugin does not take over) works on first query. The two
compose; install both for the full experience.

## Install

From the profile directory:

```sh
dsh plugin --profile web add dsh-session-search-plus
# or: add "dsh-session-search-plus": "file:/path/to/this/package" to
# package.json dependencies + the dsh.profile.bundles list, then
# pnpm install
```

Do **not** also insert the `session-search-plus` row into the profile's own
`cordis.patch.yml` — the loader refuses duplicate insert ids.

The profile must also disable the official `ui-workspace` row (the fork
replaces it), see `~/.dsh/profiles/web/cordis.patch.yml`.

## Verify

```sh
dsh --profile web --dump-config   # shows the session-search-plus row
```

After boot, watch the host log for:

```
[search-plus] content index built: N docs from M sessions in Xms
```

then type into the sidebar search box: content hits with colored snippets
and per-session dropdowns confirm the takeover.

## Development

```sh
pnpm install
pnpm run bundle   # build lib/
pnpm test
```
