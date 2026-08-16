/** Client-side matching + coloring helpers (mirror of the host matcher for titles). */

export interface ClientRun {
  start: number
  end: number
}

/** ASCII word char: letters, digits, underscore. CJK etc. count as boundaries. */
export function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  const code = ch.codePointAt(0) ?? 0
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

/** First `needle` occurrence in `hay` (from `from`) with non-word chars on both sides. */
export function wholeWordIndexOf(hay: string, needle: string, from: number): number {
  let index = hay.indexOf(needle, from)
  while (index !== -1) {
    if (!isWordChar(hay[index - 1]) && !isWordChar(hay[index + needle.length])) return index
    index = hay.indexOf(needle, index + 1)
  }
  return -1
}

/**
 * Locate a query in a title/snippet: substring or fzf-style subsequence.
 * `wholeWord` requires substring hits to sit on word boundaries (ignored under fuzzy).
 * @returns contiguous matched runs (code-unit offsets), or null.
 */
export function findRunsInText(text: string, query: string, fuzzy: boolean, caseSensitive: boolean, wholeWord = false): ClientRun[] | null {
  const needle = caseSensitive ? query : query.toLowerCase()
  const hay = caseSensitive ? text : text.toLowerCase()
  if (needle.length === 0 || hay.length === 0) return null
  if (!fuzzy) {
    const index = wholeWord ? wholeWordIndexOf(hay, needle, 0) : hay.indexOf(needle)
    if (index === -1) return null
    return [{ start: index, end: index + needle.length }]
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
  const runs: ClientRun[] = []
  for (const p of positions) {
    const last = runs[runs.length - 1]
    if (last !== undefined && p === last.end) last.end = p + 1
    else runs.push({ start: p, end: p + 1 })
  }
  return runs
}

export interface TextSegment {
  text: string
  hit: boolean
}

/** Split text into plain and hit segments for colored rendering. */
export function segmentsOf(text: string, runs: ClientRun[] | null): TextSegment[] {
  if (runs === null || runs.length === 0) return [{ text, hit: false }]
  const segments: TextSegment[] = []
  let cursor = 0
  for (const run of runs) {
    if (run.end <= cursor) continue
    const start = Math.max(cursor, run.start)
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false })
    segments.push({ text: text.slice(start, run.end), hit: true })
    cursor = run.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
  return segments
}
