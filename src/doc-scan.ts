/**
 * Searchable-text extraction for dsh-session-search-plus.
 *
 * Two entry points over the same rule set:
 * - {@link eventSearchText} decides whether ONE logical event contributes a
 *   document (used by the live \`session/event\` feed and the \`inspect\`
 *   fallback);
 * - {@link scanRawArtifact} walks a backend's VERBATIM JSONL artifact text and
 *   applies the same rule per physical line.
 *
 * Why the raw path exists: a JSONL log packs delta-chunk runs into
 * \`text-chunks\` / \`reasoning-chunks\` / \`tool-call-chunks\` storage rows, and
 * the logical read paths (\`inspect\` / \`readFrom\`) unpack every one of them
 * into individual events. On this machine that is 1.79M logical events from
 * 232k physical lines — and a search index over user/assistant message text
 * needs none of that unpacking. Scanning the artifact instead skips it
 * entirely (measured 3.97s vs 11.1s over 25 sessions) while producing
 * byte-identical documents.
 *
 * The correctness assumption is narrow and explicit: \`user/message\` and
 * \`assistant/message\` are whole-row writes that never participate in chunk
 * packing. Verified by double-path reconciliation over every session on this
 * machine (1300 documents, zero key or text differences). If a future harness
 * packs messages too, the host config flag \`rawScan: false\` forces the
 * logical path back on.
 */

/** One extracted document: a message's searchable text at its log position. */
export interface ScannedDoc {
  seq: number
  time: number
  text: string
}

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
 * are \`user/message\`) and assembled assistant messages. Everything else
 * (tool/call, tool/result, todo/write, turn/end, …) is excluded.
 * @param event - one logical session event, or any unknown value.
 * @returns the document text, or \`undefined\` when this event contributes none.
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

/**
 * The two record types that can yield a document. Used as a cheap substring
 * prefilter so the scanner only pays \`JSON.parse\` on candidate lines — every
 * chunk-storage row and tool record is rejected on a string test instead.
 */
const CANDIDATE_MARKERS = ['"user/message"', '"assistant/message"'] as const

/** Whether a raw line is worth parsing at all. */
function mayContainDoc(line: string): boolean {
  for (const marker of CANDIDATE_MARKERS) {
    if (line.includes(marker)) return true
  }
  return false
}

/**
 * Scan one verbatim JSONL artifact into documents.
 *
 * Walks lines with \`indexOf\` rather than \`split\` so a 30 MB artifact never
 * materializes as an array of every line at once. The artifact's first line is
 * the session header (\`type: 'session'\`), which carries no seq and is
 * rejected by the same guards as any other non-message row. A line that fails
 * to parse is skipped: the caller is reading a committed prefix, and one
 * unreadable row must not lose the rest of the log.
 * @param content - the artifact's full decoded text (see \`readRaw\`).
 * @returns one document per contributing message row, in log order.
 */
export function scanRawArtifact(content: string): ScannedDoc[] {
  const docs: ScannedDoc[] = []
  let cursor = 0
  while (cursor < content.length) {
    let end = content.indexOf('\n', cursor)
    if (end === -1) end = content.length
    if (end > cursor) {
      const line = content.slice(cursor, end)
      if (mayContainDoc(line)) {
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          record = undefined
        }
        const doc = record === undefined ? undefined : scannedDocOf(record)
        if (doc !== undefined) docs.push(doc)
      }
    }
    cursor = end + 1
  }
  return docs
}

/**
 * Project one parsed record into a document when it qualifies.
 * @param record - a parsed JSONL row.
 * @returns the document, or \`undefined\` when the row contributes none.
 */
export function scannedDocOf(record: unknown): ScannedDoc | undefined {
  const text = eventSearchText(record)
  if (text === undefined) return undefined
  const envelope = record as { seq?: unknown; time?: unknown }
  if (typeof envelope.seq !== 'number' || typeof envelope.time !== 'number') return undefined
  return { seq: envelope.seq, time: envelope.time, text }
}
