# dsh-session-search-plus

中文：[README.zh.md](./README.zh.md)

In-place upgrade of the official DSH sidebar search box: a private in-memory
index answers in milliseconds, and the search UI follows VS Code.

## What it does

- **Mode toggles** (right end of the input, VS Code style): `Aa` case-sensitive,
  `ab` whole word (`pnpm` no longer hits `npm`), `.*` regex, `fz` fuzzy
  subsequence. `ab` stacks with `.*` (the pattern is wrapped in `\b`); `fz` is
  exclusive with `ab` / `.*`. All off by default (plain substring).
- **Results**: the hit is colored; the snippet window uses the same algorithm as
  VS Code (word-bounded lead + single-line ellipsis). A session with several
  hits shows `▾ N` at the end of the row; expand to list every hit (up to 8,
  identical snippets deduped). Several dropdowns can stay open at once. The
  clicked hit row takes the selection background (the session header does not);
  that dropdown's indent guide stays on; hovering the result list reveals the
  guides on the other open dropdowns.
- **Jump + highlight**: a click locates the event by seq — older history is
  paged in automatically, and a collapsed context-injection row is expanded
  before marking. The chosen hit scrolls into the center and is filled; every
  other occurrence on the page is boxed. Switching sessions, or clicking
  anywhere on the page after the search box has collapsed, clears the marks.
- **Private fast index**: only user / assistant message TEXT blocks are indexed
  (injected context counts as a user message; tool arguments, results, and
  reasoning are left out). Queries answer in milliseconds and skip the official
  engine's per-call reconcile.

The official expand animation, in-place results replacing the session list, and
Esc / outside-click collapse stay as they are.

## Usage

The stock sidebar search box is the entry; there is no extra panel.

1. Open search. The default is a plain substring over titles (client) and
   content (host index).
2. Turn on `Aa` / `ab` / `.*` / `fz` at the right end of the input when needed.
   With `fz` on there is usually no contiguous string to mark in the page, so
   the view only scrolls near the hit.
3. Expand `▾ N` on a multi-hit session and click a row to jump to that message.
4. Press Esc or click outside the box to collapse. The next click anywhere on
   the page clears the fill and the boxes.

## Architecture

- **Host half** (`src/index.ts`): builds the in-memory index from the
  persistence service at boot, then keeps it incremental through the
  `session/event` feed with `(sessionId, seq)` deduplication. Serves
  `POST /api/search-plus/query` (substring / fuzzy subsequence / regex, with
  case and whole-word flags, per-session windowed snippets and match offsets).
  Host-half changes need a dsh restart.
- **Browser half** (`src/client/`): a fork of official
  `@deepseek-ai/dsh-client-ui-workspace@0.1.0-rc.6` WorkspaceBrowser. Unmodified
  regions stay byte-identical to the official bundle; every change is marked
  `// [search-plus]`. An official upgrade requires re-porting against the new
  baseline. Content queries go to `/api/search-plus/query`; title matching
  stays on the client. A page reload only picks up the frontend.

## Related plugins

Boot warmup of the official index lives in the sibling
**dsh-session-search-warmup**: it commits the official SQLite FTS5 index during
the quiet boot window so the official search surface this plugin does not take
over (rail mode, fallback paths) works on first query. The two compose; neither
requires the other.

## Install

```sh
dsh plugin --profile web add dsh-session-search-plus
```

Or manually: add this package to the web profile's `dsh.profile.bundles`,
install dependencies, restart dsh web.

Do not also insert a `session-search-plus` row into
`~/.dsh/profiles/web/cordis.patch.yml` — the loader refuses duplicate insert
ids. The fork replaces the official search slots, so the profile must also
disable the official `ui-workspace` row (same `cordis.patch.yml`).

## Verify

```sh
dsh --profile web --dump-config   # shows the session-search-plus row
```

After boot, watch the host log for:

```
[search-plus] content index built: N docs from M sessions in Xms
```

Then type into the sidebar search box: content hits with colored snippets and
per-session dropdowns confirm the takeover.

## Uninstall

```sh
dsh plugin --profile web remove dsh-session-search-plus
```

Restart dsh and restore the official `ui-workspace` row that the profile had
disabled. Sidebar search returns to the stock implementation.

## Known limits

- A hit deep in history (the start of a years-old session) has to page in the
  official 50-messages-per-page window and can take ten-odd seconds to land; a
  shallow hit is instant.
- `fz` defaults off: a fuzzy subsequence hit may contain no contiguous query
  string, so the page has nothing to mark.
- An invalid regex returns empty results with no red-box hint.

## Development

```sh
pnpm install
pnpm bundle
pnpm test
```
