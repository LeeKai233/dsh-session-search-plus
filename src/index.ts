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
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
 * @param wholeWord - substring hits must sit on word boundaries (ignored under fuzzy).
 * @returns matched runs and a score (higher is better), or null.
 */
export function findRuns(text: string, lower: string, query: string, fuzzy: boolean, caseSensitive: boolean, wholeWord = false): FindResult | null {
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
 * Window the document around the matched runs with ellipses, so the
 * sidebar row always shows the actual matching content (not a truncated
 * tail). The match sits near the FRONT of the window (`context` lead
 * chars): sidebar rows clip after ~40 visible chars, so a deep offset
 * would hide the hit entirely. Bounded to `cap` code units.
 */
export function snippetOf(text: string, runs: MatchRun[], context = 16, cap = 240): Snippet {
  const first = runs[0]
  const last = runs[runs.length - 1]
  let start = Math.max(0, first.start - context)
  let end = Math.min(text.length, last.end + context)
  if (end - start > cap) {
    // Keep the match near the front of the window.
    end = Math.min(text.length, start + cap)
    if (last.end > end) {
      end = Math.min(text.length, last.end + 12)
      start = Math.max(0, end - cap)
    }
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const body = text.slice(start, end)
  return {
    text: prefix + body + suffix,
    matchRuns: runs
      .filter((run) => run.end > start && run.start < end)
      .map((run) => ({
        start: Math.max(0, run.start - start) + prefix.length,
        end: Math.min(body.length, run.end - start) + prefix.length,
      })),
  }
}

//#endregion

//#region document extraction

type JsonRecord = Record<string, unknown>

/** Only plain text blocks are searchable: no reasoning, tool calls, or results. */
function blockText(block: unknown): string[] {
  if (typeof block !== 'object' || block === null) return []
  const record = block as JsonRecord
  if (record.type !== 'text') return []
  const text = record.text
  return typeof text === 'string' && text.trim().length > 0 ? [text.trim()] : []
}

function joinText(parts: string[]): string {
  return parts.join('\n').trim()
}

/**
 * Extract searchable text for exactly the events the feature cares about:
 * user messages (direct prompts AND agent.inject() context notices — both
 * are `user/message`) and assembled assistant messages. Everything else
 * (tool/call, tool/result, todo/write, turn/end, …) is excluded.
 */
export function eventSearchText(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as JsonRecord
  const type = record.type
  if (type !== 'user/message' && type !== 'assistant/message') return undefined
  const content = type === 'user/message'
    ? record.data !== undefined && typeof record.data === 'object' ? ((record.data as JsonRecord).content ?? []) : []
    : record.data !== undefined && typeof record.data === 'object'
      ? (((record.data as JsonRecord).message as JsonRecord | undefined)?.content ?? [])
      : []
  if (!Array.isArray(content)) return undefined
  const text = joinText(content.flatMap((block) => blockText(block)))
  return text.length === 0 ? undefined : text
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
    const { query, fuzzy, caseSensitive, wholeWord } = request
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
        const found = findRuns(doc.text, doc.lower, needle, fuzzy, caseSensitive, wholeWord)
        if (found === null) continue
        if (found.score > best) best = found.score
        if (doc.time > latest) latest = doc.time
        // Occurrence index within this event: count earlier matches.
        let occurrenceIndex = 0
        if (!fuzzy && !caseSensitive) {
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

/**
 * Assemble the host plugin.
 * @param ctx - host cordis context.
 */
export function apply(ctx: Context): void {
  const index = new SearchIndex()

  interface PersistenceLike {
    list(signal?: AbortSignal): Promise<Array<{ id: string }>>
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

    const build = async (): Promise<void> => {
      const started = Date.now()
      let headers: Array<{ id: string }> = []
      try {
        headers = await persistence.list()
      } catch (error) {
        console.warn(`[search-plus] cannot list persisted sessions: ${String((error as Error | null)?.message ?? error)}`)
      }
      let loaded = 0
      for (const header of headers) {
        try {
          const inspection = await persistence.inspect(header.id)
          for (const event of inspection.events) {
            const record = event as { seq?: number; time?: number } | null
            if (typeof record?.seq !== 'number' || typeof record.time !== 'number') continue
            const text = eventSearchText(event)
            if (text !== undefined) index.put(header.id, record.seq, record.time, text)
          }
          loaded += 1
        } catch (error) {
          console.warn(`[search-plus] failed to index session "${header.id}": ${String((error as Error | null)?.message ?? error)}`)
        }
      }
      for (const session of sessions?.list() ?? []) {
        for (const event of session.events) {
          const record = event as { seq?: number; time?: number } | null
          if (typeof record?.seq !== 'number' || typeof record.time !== 'number') continue
          const text = eventSearchText(event)
          if (text !== undefined) index.put(session.id, record.seq, record.time, text)
        }
      }
      console.log(`[search-plus] content index built: ${index.size()} docs from ${loaded} sessions in ${Date.now() - started}ms`)
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
