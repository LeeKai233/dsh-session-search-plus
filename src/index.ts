/**
 * Host half of dsh-session-search-plus.
 *
 * Two responsibilities:
 * 1. Maintain a private in-memory content index over user/assistant message
 *    TEXT only (user prompts, agent.inject() context notices, assistant
 *    answers — no tool arguments, tool results, todos, or reasoning noise),
 *    built at boot from the persistence service and kept incremental through
 *    the `session/event` feed with (sessionId, seq) deduplication.
 * 2. Serve POST /api/search-plus/query for the client takeover panel:
 *    substring or fzf-style fuzzy subsequence matching, case-sensitivity
 *    flag, per-session grouped hits with windowed snippets and match
 *    offsets — all against the in-memory index, so queries cost
 *    milliseconds instead of the official engine's per-call reconcile.
 *
 * The official-index boot warmup lives in the sibling plugin
 * dsh-session-search-warmup; the two compose (warmup keeps the official
 * surface fast everywhere this plugin does not take over).
 *
 * The boot build is cached: documents are persisted keyed by each log's
 * persistence revision, so an unchanged session costs one `stat` instead of a
 * full decode+parse. See ./doc-cache.ts for the invalidation rules and
 * ./doc-scan.ts for why the verbatim-artifact read replaced the logical one.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  buildCache,
  planReconcile,
  readCache,
  resolveCachePath,
  writeCache,
  type SnapshotLike,
} from './doc-cache.ts'
import { eventSearchText, scanRawArtifact, scannedDocOf, type ScannedDoc } from './doc-scan.ts'

// Real imports with local re-exports: a bare `export { x } from './m.ts'`
// creates no local binding, and any in-module use would then be a free
// variable the bundler is free to tree-shake away.
export { eventSearchText, scanRawArtifact, scannedDocOf }
export type { ScannedDoc }

//#region search index types

/** One searchable document: a single message's extracted text. */
export interface SearchDoc {
  sessionId: string
  seq: number
  time: number
  text: string
  /** Lowercased copy, precomputed for case-insensitive queries. */
  lower: string
}

/** One contiguous matched run inside a document. */
export interface MatchRun {
  start: number
  end: number
}

export interface QueryRequest {
  query: string
  fuzzy: boolean
  caseSensitive: boolean
  /** Whole-word: a hit must not touch ASCII word chars on either side. Ignored under fuzzy. */
  wholeWord: boolean
  /** Query is a regular expression (mutually exclusive with fuzzy; wholeWord wraps it in `\b`). */
  regex: boolean
  /** 'all' merges content with client-side title matching; 'content' is content-only. */
  scope: 'all' | 'content'
  /** Cap on returned sessions; per-session hits are capped separately. */
  limit: number
}

/** One hit inside a session group, JSON-safe for the wire. */
export interface SearchHit {
  seq: number
  time: number
  snippet: string
  /** Offsets of every matched run inside `snippet` (code units). */
  matchRuns: MatchRun[]
  /** Which occurrence of the query this hit is within its own event text. */
  occurrenceIndex: number
}

export interface SessionGroup {
  sessionId: string
  /** Best hit's snippet, for the collapsed row. */
  snippet: string
  /** Best hit's runs, for the collapsed row coloring. */
  matchRuns: MatchRun[]
  /** All hits in this session (≤ 8). */
  matches: SearchHit[]
}

//#endregion

//#region matcher

export interface FindResult {
  runs: MatchRun[]
  score: number
}

/** ASCII word char: letters, digits, underscore. CJK etc. count as boundaries. */
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  const code = ch.codePointAt(0) ?? 0
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

/** First `needle` occurrence in `hay` (from `from`) with non-word chars on both sides. */
function wholeWordIndexOf(hay: string, needle: string, from: number): number {
  let index = hay.indexOf(needle, from)
  while (index !== -1) {
    if (!isWordChar(hay[index - 1]) && !isWordChar(hay[index + needle.length])) return index
    index = hay.indexOf(needle, index + 1)
  }
  return -1
}

/**
 * Locate a query in one document.
 * @param text - raw text.
 * @param lower - precomputed lowercase text.
 * @param query - caller query (already trimmed, non-empty).
 * @param fuzzy - subsequence matching with consecutive-run bonuses.
 * @param caseSensitive - exact-case comparison.
 * @param wholeWord - hits must sit on word boundaries (regex: wraps the pattern in `\b`; ignored under fuzzy).
 * @param regex - query is a regular expression (mutually exclusive with fuzzy).
 * @returns matched runs and a score (higher is better), or null.
 */
export function findRuns(text: string, lower: string, query: string, fuzzy: boolean, caseSensitive: boolean, wholeWord = false, regex = false): FindResult | null {
  if (query.length === 0 || text.length === 0) return null
  if (regex) {
    let re: RegExp
    try {
      re = new RegExp(wholeWord ? `\\b(?:${query})\\b` : query, caseSensitive ? '' : 'i')
    } catch {
      return null
    }
    const match = re.exec(text)
    if (match === null || match[0].length === 0) return null
    return { runs: [{ start: match.index, end: match.index + match[0].length }], score: 0 }
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  const hay = caseSensitive ? text : lower
  if (needle.length === 0 || hay.length === 0) return null
  if (!fuzzy) {
    const index = wholeWord ? wholeWordIndexOf(hay, needle, 0) : hay.indexOf(needle)
    if (index === -1) return null
    return { runs: [{ start: index, end: index + needle.length }], score: 0 }
  }
  const positions: number[] = []
  let cursor = 0
  for (const ch of needle) {
    let found = -1
    for (let i = cursor; i < hay.length; i++) {
      if (hay[i] === ch) {
        found = i
        break
      }
    }
    if (found === -1) return null
    positions.push(found)
    cursor = found + 1
  }
  // Score: earlier matches and consecutive runs win; gaps cost.
  let score = 0
  let prev = positions[0] - 1
  for (const p of positions) {
    if (p === prev + 1) score += 5
    else score -= p - prev - 1
    prev = p
  }
  score -= Math.floor(positions[0] / 16)
  const runs: MatchRun[] = []
  for (const p of positions) {
    const last = runs[runs.length - 1]
    if (last !== undefined && p === last.end) last.end = p + 1
    else runs.push({ start: p, end: p + 1 })
  }
  return { runs, score }
}

//#endregion

//#region snippet builder

export interface Snippet {
  text: string
  /** Every matched run, snippet-relative (fuzzy queries may produce several). */
  matchRuns: MatchRun[]
}

/**
 * vscode-style left cut (strings.ts lcut): keep the LAST ≤n chars of `text`,
 * cut at a `\b` word boundary, prefixed when actually cut. Deviation: text
 * without any word boundary (e.g. long CJK runs) is hard-cut to n chars —
 * vscode's no-boundary passthrough assumes single-line inputs, ours is a
 * full message body.
 */
function lcut(text: string, n: number, prefix = ''): string {
  const trimmed = text.trimStart()
  if (trimmed.length < n) return trimmed
  const re = /\b/g
  let i = 0
  while (re.test(trimmed)) {
    if (trimmed.length - re.lastIndex < n) break
    i = re.lastIndex
    re.lastIndex += 1
  }
  if (i === 0) return prefix + trimmed.slice(trimmed.length - n)
  return prefix + trimmed.substring(i).trimStart()
}

/**
 * Window the document around the matched runs, mirroring vscode's
 * `MatchImpl.preview()`: `before` keeps the last ≤`lead` word-bounded chars
 * with a leading ellipsis; `inside`+`after` fill the rest of the `cap`
 * budget; visible clipping is CSS's job (single nowrap-ellipsis container).
 */
export function snippetOf(text: string, runs: MatchRun[], lead = 26, cap = 250): Snippet {
  const first = runs[0]
  const last = runs[runs.length - 1]
  const before = lcut(text.slice(0, first.start), lead, '…')
  let remaining = Math.max(0, cap - before.length)
  const bodyFull = text.slice(first.start, last.end)
  const body = bodyFull.slice(0, remaining)
  remaining -= body.length
  const afterFull = text.slice(last.end)
  const after = afterFull.slice(0, remaining)
  const suffix = after.length < afterFull.length ? '…' : ''
  return {
    text: before + body + after + suffix,
    matchRuns: runs
      .map((run) => ({
        start: run.start - first.start + before.length,
        end: Math.min(run.end, first.start + body.length) - first.start + before.length,
      }))
      .filter((run) => run.end > run.start),
  }
}

//#endregion

//#region in-memory index

export class SearchIndex {
  /** sessionId -> seq -> doc (seq dedupes boot build against the live feed). */
  private readonly bySession = new Map<string, Map<number, SearchDoc>>()

  put(sessionId: string, seq: number, time: number, text: string): void {
    let session = this.bySession.get(sessionId)
    if (session === undefined) {
      session = new Map()
      this.bySession.set(sessionId, session)
    }
    if (session.has(seq)) return
    session.set(seq, { sessionId, seq, time, text, lower: text.toLowerCase() })
  }

  size(): number {
    let total = 0
    for (const session of this.bySession.values()) total += session.size
    return total
  }

  query(request: QueryRequest): SessionGroup[] {
    const { query, fuzzy, caseSensitive, wholeWord, regex } = request
    const limit = Math.max(1, Math.min(request.limit, 200))
    const PER_SESSION_HITS = 8
    const needle = query.trim()
    if (needle.length === 0) return []
    const sessions: Array<{ sessionId: string; best: number; time: number; hits: SearchHit[] }> = []
    for (const [sessionId, docs] of this.bySession) {
      let best = Number.NEGATIVE_INFINITY
      let latest = 0
      const hits: SearchHit[] = []
      // Identical snippets (re-injected contexts, quoted docs) collapse to one row.
      const seenSnippets = new Set<string>()
      for (const doc of docs.values()) {
        const found = findRuns(doc.text, doc.lower, needle, fuzzy, caseSensitive, wholeWord, regex)
        if (found === null) continue
        if (found.score > best) best = found.score
        if (doc.time > latest) latest = doc.time
        // Occurrence index within this event: count earlier matches.
        let occurrenceIndex = 0
        if (!fuzzy && !caseSensitive && !regex) {
          const term = needle.toLowerCase()
          let cursor = wholeWord ? wholeWordIndexOf(doc.lower, term, 0) : doc.lower.indexOf(term)
          while (cursor !== -1 && cursor < found.runs[0].start) {
            occurrenceIndex += 1
            cursor = wholeWord ? wholeWordIndexOf(doc.lower, term, cursor + term.length) : doc.lower.indexOf(term, cursor + term.length)
          }
        }
        const snippet = snippetOf(doc.text, found.runs)
        if (seenSnippets.has(snippet.text)) continue
        seenSnippets.add(snippet.text)
        hits.push({
          seq: doc.seq,
          time: doc.time,
          snippet: snippet.text,
          matchRuns: snippet.matchRuns,
          occurrenceIndex,
        })
        if (hits.length >= PER_SESSION_HITS) break
      }
      if (hits.length === 0) continue
      sessions.push({ sessionId, best, time: latest, hits })
    }
    sessions.sort((a, b) => (b.best - a.best) || (b.time - a.time))
    return sessions.slice(0, limit).map(({ sessionId, hits }) => ({
      sessionId,
      snippet: hits[0].snippet,
      matchRuns: hits[0].matchRuns,
      matches: hits,
    }))
  }
}

//#endregion

//#region http route

/** Trusted same-origin callers of the local search route. */
function isTrustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  return origin === 'http://127.0.0.1:3080' || origin === 'http://localhost:3080'
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer)
    total += buffer.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Exported for tests: one POST /query exchange against the in-memory index. */
export async function handleSearchRequest(index: SearchIndex, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isTrustedOrigin(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return
  }
  // The prefix router passes the FULL pathname (e.g. /api/search-plus/query).
  const pathname = (req.url ?? '').split('?')[0]
  if (req.method !== 'POST' || !pathname.endsWith('/query')) {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`bad request: ${String((error as Error | null)?.message ?? error)}`)
    return
  }
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const query = typeof raw.query === 'string' ? raw.query.slice(0, 500) : ''
  const request: QueryRequest = {
    query,
    fuzzy: raw.fuzzy !== false,
    caseSensitive: raw.caseSensitive === true,
    wholeWord: raw.wholeWord === true,
    regex: raw.regex === true,
    scope: raw.scope === 'content' ? 'content' : 'all',
    limit: typeof raw.limit === 'number' && Number.isSafeInteger(raw.limit) ? raw.limit : 50,
  }
  const started = Date.now()
  const items = index.query(request)
  const payload = JSON.stringify({ items, tookMs: Date.now() - started })
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

//#endregion

/** Host plugin configuration. */
export interface Config {
  /**
   * Override the cache file location. Defaults to
   * `<harness home>/session-search-plus-cache.json.zstd`.
   */
  cachePath?: string
  /**
   * Read each session's verbatim artifact instead of its logical event log
   * (default `true`). Turn it off to force the logical `inspect` path — the
   * escape hatch if a future harness packs message rows the way it already
   * packs delta chunks.
   */
  rawScan?: boolean
}

/**
 * Assemble the host plugin.
 * @param ctx - host cordis context.
 * @param config - optional host configuration.
 */
export function apply(ctx: Context, config?: Config | null): void {
  const index = new SearchIndex()
  // A loader row written as a bare `config:` key parses to null, and a default
  // parameter only covers undefined — so normalize before reading any field.
  const settings: Config = typeof config === 'object' && config !== null ? config : {}
  const cachePath = resolveCachePath(typeof settings.cachePath === 'string' ? settings.cachePath : undefined)
  const rawScanEnabled = settings.rawScan !== false

  interface PersistenceLike {
    readonly supportsRawArtifacts?: boolean
    list(signal?: AbortSignal): Promise<Array<{ id: string }>>
    listSnapshots?(signal?: AbortSignal): Promise<Array<{ header: { id: string }; revision: string }>>
    readRaw?(id: string, signal?: AbortSignal): Promise<{ content: string } | undefined>
    inspect(id: string, signal?: AbortSignal): Promise<{ events: ReadonlyArray<unknown> }>
  }

  interface WebServerLike {
    register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
  }

  ctx.inject(['sessionPersistence'], (rawPersistenceCtx) => {
    const persistenceCtx = rawPersistenceCtx as Context & { sessionPersistence: PersistenceLike }
    const persistence = persistenceCtx.sessionPersistence
    const sessions = persistenceCtx.get('sessions') as
      | { list(): Array<{ id: string; events: ReadonlyArray<unknown> }> }
      | undefined

    // Incremental live feed first, so boot-build events dedupe by seq.
    const onEvent = (session: unknown, event: unknown): void => {
      const record = event as { seq?: number; time?: number } | null
      if (typeof record?.seq !== 'number' || typeof record.time !== 'number') return
      const sessionRecord = session as { id?: string } | null
      if (typeof sessionRecord?.id !== 'string') return
      const text = eventSearchText(event)
      if (text === undefined) return
      index.put(sessionRecord.id, record.seq, record.time, text)
    }
    const offEvent = ctx.on('session/event' as never, onEvent as never)

    /**
     * Read one persisted session's documents.
     *
     * Prefers the verbatim artifact (no chunk-row unpacking); falls back to the
     * logical log when the backend exposes no raw artifact, when the raw read
     * fails, or when `rawScan` is off.
     */
    const readDocs = async (sessionId: string): Promise<ScannedDoc[]> => {
      if (rawScanEnabled && persistence.supportsRawArtifacts === true && typeof persistence.readRaw === 'function') {
        try {
          const artifact = await persistence.readRaw(sessionId)
          if (artifact !== undefined) return scanRawArtifact(artifact.content)
        } catch (error) {
          console.warn(`[search-plus] raw read failed for "${sessionId}", falling back to inspect: ${String((error as Error | null)?.message ?? error)}`)
        }
      }
      const inspection = await persistence.inspect(sessionId)
      const docs: ScannedDoc[] = []
      for (const event of inspection.events) {
        const doc = scannedDocOf(event)
        if (doc !== undefined) docs.push(doc)
      }
      return docs
    }

    /**
     * List sessions with their change tokens. Falls back to the plain listing
     * (every session re-read, nothing cached) when snapshots are unavailable.
     */
    const listSnapshots = async (): Promise<{ snapshots: SnapshotLike[]; revisioned: boolean }> => {
      if (typeof persistence.listSnapshots === 'function') {
        try {
          const raw = await persistence.listSnapshots()
          return { snapshots: raw.map((entry) => ({ sessionId: entry.header.id, rev: String(entry.revision) })), revisioned: true }
        } catch (error) {
          console.warn(`[search-plus] cannot list session revisions, falling back to a full rebuild: ${String((error as Error | null)?.message ?? error)}`)
        }
      }
      try {
        const headers = await persistence.list()
        return { snapshots: headers.map((header) => ({ sessionId: header.id, rev: '' })), revisioned: false }
      } catch (error) {
        console.warn(`[search-plus] cannot list persisted sessions: ${String((error as Error | null)?.message ?? error)}`)
        return { snapshots: [], revisioned: false }
      }
    }

    const build = async (): Promise<void> => {
      const started = Date.now()
      const cache = readCache(cachePath)
      const { snapshots, revisioned } = await listSnapshots()
      // Without revisions nothing may be reused: an unknown token must never
      // compare equal to a stored one.
      const plan = planReconcile(revisioned ? cache : undefined, snapshots)

      // Revision-and-documents pairs captured from durable reads this boot.
      const observed = new Map<string, { rev: string; docs: readonly ScannedDoc[] }>()

      for (const entry of plan.reuse) {
        for (const [seq, time, text] of entry.docs) index.put(entry.sessionId, seq, time, text)
        observed.set(entry.sessionId, {
          rev: entry.rev,
          docs: entry.docs.map(([seq, time, text]) => ({ seq, time, text })),
        })
      }

      let failed = 0
      for (const snapshot of plan.reread) {
        try {
          const docs = await readDocs(snapshot.sessionId)
          for (const doc of docs) index.put(snapshot.sessionId, doc.seq, doc.time, doc.text)
          // The revision was observed BEFORE this read, so the pair can only
          // be conservatively stale — never ahead of the log.
          if (revisioned) observed.set(snapshot.sessionId, { rev: snapshot.rev, docs })
        } catch (error) {
          failed += 1
          console.warn(`[search-plus] failed to index session "${snapshot.sessionId}": ${String((error as Error | null)?.message ?? error)}`)
        }
      }

      // Live sessions last: their in-memory tail may lead the committed log,
      // and these documents are deliberately never cached.
      for (const session of sessions?.list() ?? []) {
        for (const event of session.events) {
          const doc = scannedDocOf(event)
          if (doc !== undefined) index.put(session.id, doc.seq, doc.time, doc.text)
        }
      }

      const elapsed = Date.now() - started
      console.log(
        `[search-plus] content index ready: ${index.size()} docs, ${plan.reuse.length} sessions from cache, `
        + `${plan.reread.length - failed} re-read${failed > 0 ? `, ${failed} failed` : ''}`
        + `${plan.drop.length > 0 ? `, ${plan.drop.length} stale dropped` : ''} in ${elapsed}ms`,
      )

      // One write, right after the build: a later hard kill still leaves the
      // next boot a usable cache. Fail-soft — a lost write costs one rebuild.
      if (revisioned) {
        try {
          writeCache(cachePath, buildCache(observed))
        } catch (error) {
          console.warn(`[search-plus] could not persist the index cache: ${String((error as Error | null)?.message ?? error)}`)
        }
      }
    }
    void build()

    persistenceCtx.effect(() => () => {
      offEvent()
    }, 'search-plus: event feed')
  })

  ctx.inject(['webServer'], (rawWebCtx) => {
    const webCtx = rawWebCtx as Context & { webServer: WebServerLike }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/api/search-plus',
      handler: (req: IncomingMessage, res: ServerResponse) => handleSearchRequest(index, req, res),
    }), 'search-plus: /api/search-plus route')
  })
}
