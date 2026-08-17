/**
 * Jump-to-match and in-conversation marking.
 *
 * Location is anchor-based, not text-based: every conversation row carries
 * `data-chat-anchor-key`, and the runtime session snapshot's chat nodes map
 * keys to `anchorSeq` values that equal the event seq for user messages and
 * settled assistant messages. A hit's seq therefore selects its row
 * deterministically — duplicate texts and split text nodes cannot mislead
 * the jump the way the old snippet-fingerprint heuristic did.
 */
import { wholeWordIndexOf } from './matcher.ts'

export interface JumpTarget {
  sessionId: string
  /** Event seq of the hit — drives both history paging and the row anchor. */
  seq?: number
  query: string
  /** Which occurrence inside the anchored row gets the filled mark. */
  occurrenceIndex: number
  /** Search-time flags so conversation marks honor the same matching mode. */
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

export interface JumpStatus {
  found: boolean
  occurrences: number
}

const SCROLL_SELECTOR = '.Md3f7G_scroll'
const MARK_CLASS = 'dsh-search-hit'
const BOX_CLASS = 'dsh-search-hit-box'
/** Upper bound on history pages pulled while chasing a deep hit (50 messages per page). */
const MAX_JUMP_PAGES = 100

export interface TextMatch {
  start: number
  end: number
}

/** All query matches in one text, honoring the search-time flags (regex included; zero-width matches are skipped defensively). */
export function matchRunsOf(text: string, query: string, caseSensitive: boolean, wholeWord: boolean, regex = false): TextMatch[] {
  if (query.length === 0 || text.length === 0) return []
  if (regex) {
    let re: RegExp
    try {
      re = new RegExp(wholeWord ? `\\b(?:${query})\\b` : query, caseSensitive ? 'g' : 'gi')
    } catch {
      return []
    }
    const runs: TextMatch[] = []
    for (;;) {
      const match = re.exec(text)
      if (match === null) return runs
      if (match[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      runs.push({ start: match.index, end: match.index + match[0].length })
      if (runs.length >= 1000) return runs
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  const hay = caseSensitive ? text : text.toLowerCase()
  const runs: TextMatch[] = []
  if (needle.length === 0 || hay.length === 0) return runs
  let from = 0
  for (;;) {
    const index = wholeWord ? wholeWordIndexOf(hay, needle, from) : hay.indexOf(needle, from)
    if (index === -1) return runs
    runs.push({ start: index, end: index + needle.length })
    from = index + needle.length
  }
}

/** Start offsets of every query match (see matchRunsOf). */
export function matchIndices(text: string, query: string, caseSensitive: boolean, wholeWord: boolean, regex = false): number[] {
  return matchRunsOf(text, query, caseSensitive, wholeWord, regex).map((run) => run.start)
}

export function scrollContainer(): Element | null {
  if (typeof document === 'undefined') return null
  return document.querySelector(SCROLL_SELECTOR)
}

function walkTextNodes(root: Element): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

function isInsideMark(node: Text): boolean {
  return node.parentElement?.closest(`.${MARK_CLASS}, .${BOX_CLASS}`) !== null
}

/** Wrap one text range in a span with the given class. */
function wrapRange(node: Text, start: number, end: number, className: string): void {
  const range = document.createRange()
  range.setStart(node, Math.min(start, node.length))
  range.setEnd(node, Math.min(end, node.length))
  const span = document.createElement('span')
  span.className = className
  try {
    range.surroundContents(span)
  } catch {
    /* crossing an element boundary — skip this node */
  }
}

/** Wrap every match in one text node, LAST match first so earlier offsets stay valid. */
function wrapNodeMatches(node: Text, marks: Array<{ index: number; length: number; className: string }>): void {
  for (const mark of [...marks].sort((a, b) => b.index - a.index)) {
    wrapRange(node, mark.index, mark.index + mark.length, mark.className)
  }
}

/** Remove every mark this plugin created, re-merging split text nodes. */
export function clearMarks(): void {
  if (typeof document === 'undefined') return
  const parents = new Set<Node>()
  for (const selector of [`.${MARK_CLASS}`, `.${BOX_CLASS}`]) {
    for (const span of Array.from(document.querySelectorAll(selector))) {
      const parent = span.parentNode
      if (parent === null) continue
      while (span.firstChild !== null) parent.insertBefore(span.firstChild, span)
      parent.removeChild(span)
      parents.add(parent)
    }
  }
  for (const parent of parents) parent.normalize()
}

export function hasMarks(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(`.${MARK_CLASS}`) !== null
}

/** Chat snapshot subset this feature reads (SessionRuntime.snapshotCache.chat). */
export interface ChatSnapshotLike {
  order?: unknown
  nodes?: { get(key: unknown): { anchorSeq?: unknown } | undefined }
}

/** Node key whose anchorSeq equals the hit's event seq, or null. */
export function findAnchorKey(chat: ChatSnapshotLike | null | undefined, seq: number): string | null {
  const order = chat?.order
  const nodes = chat?.nodes
  if (!Array.isArray(order) || nodes === undefined || nodes === null) return null
  for (const key of order) {
    if (typeof key !== 'string') continue
    if (nodes.get(key)?.anchorSeq === seq) return key
  }
  return null
}

/** Rendered row for one anchor key, if currently in the DOM. */
export function rowByAnchorKey(container: Element, key: string): Element | null {
  for (const row of container.querySelectorAll('[data-chat-anchor-key]')) {
    if ((row as HTMLElement).dataset.chatAnchorKey === key) return row
  }
  return null
}

/**
 * Mark the conversation: the clicked occurrence inside the anchored row gets
 * the filled mark; every other occurrence on the page gets a box. Existing
 * marks are cleared first so repeated calls stay exact.
 */
export function markConversation(container: Element, row: Element, target: JumpTarget): JumpStatus {
  clearMarks()
  const caseSensitive = target.caseSensitive === true
  const wholeWord = target.wholeWord === true
  const regex = target.regex === true
  let occurrences = 0
  let selected = false
  // The anchored row: occurrence #occurrenceIndex is filled, the rest boxed.
  for (const node of walkTextNodes(row)) {
    if (isInsideMark(node)) continue
    const text = node.textContent ?? ''
    if (text.length === 0) continue
    const marks = matchRunsOf(text, target.query, caseSensitive, wholeWord, regex).map((run) => {
      const className = !selected && occurrences === target.occurrenceIndex ? MARK_CLASS : BOX_CLASS
      if (className === MARK_CLASS) selected = true
      occurrences += 1
      return { index: run.start, length: run.end - run.start, className }
    })
    wrapNodeMatches(node, marks)
  }
  // The rest of the page: boxes only.
  for (const node of walkTextNodes(container)) {
    if (row.contains(node) || isInsideMark(node)) continue
    const text = node.textContent ?? ''
    if (text.length === 0) continue
    const marks = matchRunsOf(text, target.query, caseSensitive, wholeWord, regex).map((run) => ({ index: run.start, length: run.end - run.start, className: BOX_CLASS }))
    occurrences += marks.length
    wrapNodeMatches(node, marks)
  }
  return { found: true, occurrences }
}

export interface SessionWindowLike {
  open(): Promise<void>
  loadOlder(): Promise<void>
  readonly hasMore?: boolean
  /** First seq of the loaded window; the target renders once baseSeq <= target.seq. */
  readonly baseSeq?: number
  /** Latest session snapshot; its chat nodes map anchor keys to anchorSeqs. */
  readonly snapshotCache?: { chat?: ChatSnapshotLike }
}

export interface SessionsLike {
  open(id: string): void
  binding(id: string): { session?: SessionWindowLike } | undefined
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Locate the currently rendered row for a target, or null when not rendered yet. */
function locateRow(sessions: SessionsLike, target: JumpTarget): { container: Element; row: Element; key: string } | null {
  if (target.seq === undefined) return null
  const container = scrollContainer()
  if (container === null) return null
  const chat = sessions.binding(target.sessionId)?.session?.snapshotCache?.chat
  const key = findAnchorKey(chat, target.seq)
  if (key === null) return null
  const row = rowByAnchorKey(container, key)
  return row === null ? null : { container, row, key }
}

/** Re-mark after React re-renders wiped the spans; never pages or scrolls. */
export function remark(sessions: SessionsLike, target: JumpTarget): void {
  const located = locateRow(sessions, target)
  if (located === null) return
  markConversation(located.container, located.row, target)
}

/** Occurrences of the query anywhere inside one row, honoring the search-time flags. */
function rowMatchCount(row: Element, target: JumpTarget): number {
  return matchIndices(row.textContent ?? '', target.query, target.caseSensitive === true, target.wholeWord === true, target.regex === true).length
}

/**
 * Context-injection rows render as a collapsed DisclosureRow — the body (and
 * therefore the hit text) enters the DOM only after expansion. Expand such a
 * row and wait for the hit text to materialize. Returns the row to mark
 * (re-resolved by anchor key, since React may swap the node) or null.
 */
async function expandRowIfCollapsed(sessions: SessionsLike, target: JumpTarget, located: { container: Element; row: Element; key: string }): Promise<{ container: Element; row: Element } | null> {
  if (rowMatchCount(located.row, target) > 0) return located
  const trigger = located.row.querySelector('[data-disclosure-row][data-expandable][aria-expanded="false"]')
  if (!(trigger instanceof HTMLElement)) return located
  trigger.click()
  return waitFor(() => {
    const container = scrollContainer()
    if (container === null) return null
    const row = rowByAnchorKey(container, located.key)
    return row !== null && rowMatchCount(row, target) > 0 ? { container, row } : null
  }, 2000)
}

/**
 * Open the session, page history up until the hit's seq enters the loaded
 * window, poll for the anchored row to render, center it, then mark.
 */
export async function jumpToMatch(sessions: SessionsLike, target: JumpTarget): Promise<JumpStatus> {
  sessions.open(target.sessionId)
  const session = sessions.binding(target.sessionId)?.session
  if (session?.open !== undefined) {
    try {
      await session.open()
      if (target.seq !== undefined && session.loadOlder !== undefined) {
        for (let page = 0; page < MAX_JUMP_PAGES; page++) {
          if (session.hasMore !== true || session.baseSeq === undefined || session.baseSeq <= target.seq) break
          await session.loadOlder()
        }
      }
    } catch {
      /* fall through to the DOM probe — a paging failure must not hang the jump */
    }
  }
  const located = await waitFor(() => locateRow(sessions, target), 8000)
  if (located === null) return { found: false, occurrences: 0 }
  const ready = await expandRowIfCollapsed(sessions, target, located)
  if (ready === null) return { found: false, occurrences: 0 }
  const status = markConversation(ready.container, ready.row, target)
  // Center the filled mark itself (it may sit inside the context body's own
  // 141px scrollport); fall back to the row when nothing was markable.
  const mark = ready.container.querySelector(`.${MARK_CLASS}`)
  ;(mark ?? ready.row).scrollIntoView({ block: 'center', behavior: 'smooth' })
  return status
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== null) return value
    if (Date.now() > deadline) return null
    await sleep(120)
  }
}
