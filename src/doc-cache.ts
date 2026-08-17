/**
 * Persisted document cache for dsh-session-search-plus.
 *
 * The host index used to be rebuilt from every persisted log on every boot
 * (measured 28.6s in a live process). Nothing about those logs changes while
 * dsh is not running, so this module stores the extracted documents and
 * reuses them, keyed by each log's persistence REVISION.
 *
 * Why revision and not a seq watermark: the persistence seam does expose a
 * read-from-seq primitive, but on the JSONL backend it re-parses the whole
 * artifact regardless of \`fromSeq\` (measured 14.9s vs 11.1s for a full
 * logical read — the suffix bounds what is RETURNED, not what is READ). So
 * per-seq incrementality buys nothing here; per-SESSION skipping is the whole
 * win. A changed log is re-extracted in full, which keeps the invalidation
 * story to one comparison and removes every shrunk-log edge case.
 *
 * JSONL revisions are \`dev:ino:size:mtimeNs:ctimeNs\` — stat-derived and
 * stable across restarts, so they are a valid durable cache key.
 *
 * Cache semantics, mirroring the harness's own projection cache: a record is
 * possibly stale but never wrong, every failure is fail-soft, and a version
 * mismatch discards rather than migrates. Deleting the file is always safe.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { ScannedDoc } from './doc-scan.ts'

/**
 * Cache format version. It stamps the EXTRACTION rule set, not the file
 * layout: any change to which events become documents, or to the text they
 * yield, must bump this so stale documents are discarded instead of served.
 */
export const CACHE_VERSION = 1

/** Default artifact name under the harness home. */
export const CACHE_FILE_NAME = 'session-search-plus-cache.json.zstd'

/** One cached session: the revision its documents were extracted from. */
export interface CachedSession {
  /** Opaque persistence revision observed BEFORE the documents were read. */
  rev: string
  /** Documents as compact tuples: [seq, time, text]. */
  docs: Array<[number, number, string]>
}

/** The whole cache file's logical content. */
export interface DocCache {
  version: number
  sessions: Record<string, CachedSession>
}

/** An empty cache — the value every failure path degrades to. */
export function emptyCache(): DocCache {
  return { version: CACHE_VERSION, sessions: {} }
}

/**
 * Expand the supported tilde prefixes against the OS home, matching the
 * harness's own home-path handling.
 * @param path - a configured path that may begin with \`~\`, \`~/\`, or \`~\\\`.
 * @returns the expanded path, or the input when no supported prefix is present.
 */
function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the cache file location.
 *
 * Precedence mirrors the harness home resolution: an explicit configured path
 * wins, then \`$DSH_HOME\`, then \`~/.dsh\`. A blank or whitespace-only
 * \`$DSH_HOME\` is treated as unset so it never resolves to the cwd.
 * @param configured - explicit \`cachePath\` from plugin config.
 * @param env - environment mapping used to read \`DSH_HOME\`.
 * @returns the absolute cache file path.
 */
export function resolveCachePath(configured?: string, env: Record<string, string | undefined> = process.env): string {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    const expanded = expandTilde(configured.trim())
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  const fromEnv = env.DSH_HOME
  const home = typeof fromEnv === 'string' && fromEnv.trim().length > 0
    ? expandTilde(fromEnv.trim())
    : join(homedir(), '.dsh')
  return join(isAbsolute(home) ? home : resolve(home), CACHE_FILE_NAME)
}

/**
 * Validate an unknown decoded value as a cache.
 *
 * Structural only — it accepts exactly what {@link encodeCache} writes and
 * rejects everything else, so a hand-edited or partially-written file degrades
 * to a cold build instead of injecting malformed documents into the index.
 * @param value - the parsed JSON value.
 * @returns the cache when valid and version-current, otherwise \`undefined\`.
 */
export function validateCache(value: unknown): DocCache | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== CACHE_VERSION) return undefined
  const sessions = record.sessions
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return undefined
  const out: Record<string, CachedSession> = {}
  for (const [sessionId, raw] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) return undefined
    const entry = raw as Record<string, unknown>
    if (typeof entry.rev !== 'string' || !Array.isArray(entry.docs)) return undefined
    const docs: Array<[number, number, string]> = []
    for (const tuple of entry.docs) {
      if (!Array.isArray(tuple) || tuple.length !== 3) return undefined
      const [seq, time, text] = tuple as unknown[]
      if (typeof seq !== 'number' || typeof time !== 'number' || typeof text !== 'string') return undefined
      docs.push([seq, time, text])
    }
    out[sessionId] = { rev: entry.rev, docs }
  }
  return { version: CACHE_VERSION, sessions: out }
}

/**
 * Serialize a cache to its durable bytes (zstd-compressed JSON).
 * @param cache - the cache to encode.
 * @returns the compressed buffer.
 */
export function encodeCache(cache: DocCache): Buffer {
  return zstdCompressSync(Buffer.from(JSON.stringify(cache), 'utf8'))
}

/**
 * Decode durable bytes back into a validated cache.
 * @param bytes - the file's raw contents.
 * @returns the cache, or \`undefined\` when unreadable, malformed, or stale.
 */
export function decodeCache(bytes: Buffer): DocCache | undefined {
  let json: string
  try {
    json = zstdDecompressSync(bytes).toString('utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  return validateCache(parsed)
}

/**
 * Read the cache from disk. Never throws: absence, corruption, and a version
 * mismatch all mean "no reusable documents".
 * @param path - the cache file path.
 * @returns the cache, or \`undefined\` when nothing usable is stored.
 */
export function readCache(path: string): DocCache | undefined {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return undefined
  }
  return decodeCache(bytes)
}

/**
 * Publish the cache by atomic replace (temp file in the same directory, then
 * \`rename\`), so a crash mid-write can never leave a torn cache behind.
 * @param path - the cache file path.
 * @param cache - the cache to persist.
 * @throws when the write or rename fails; callers keep this fail-soft.
 */
export function writeCache(path: string, cache: DocCache): void {
  const temp = path + '.' + process.pid + '.tmp'
  try {
    writeFileSync(temp, encodeCache(cache))
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may not exist; the original error is what matters.
    }
    throw error
  }
}

/** One session observed in persistence, with its current change token. */
export interface SnapshotLike {
  sessionId: string
  rev: string
}

/** What the boot build must do for one session. */
export interface ReconcilePlan {
  /** Cached documents that are still current — reusable with zero log reads. */
  reuse: Array<{ sessionId: string; rev: string; docs: Array<[number, number, string]> }>
  /** Sessions whose log changed or that were never cached — must be read. */
  reread: SnapshotLike[]
  /** Cached session ids no longer present in persistence. */
  drop: string[]
}

/**
 * Decide, per session, whether cached documents may be reused.
 *
 * Persistence is the authority: a session absent from \`snapshots\` is dropped,
 * and any revision difference means re-read. Only an exact revision match
 * reuses documents.
 * @param cache - the cache read from disk, or \`undefined\`.
 * @param snapshots - the current sessions and their revisions.
 * @returns the reuse / re-read / drop partition.
 */
export function planReconcile(cache: DocCache | undefined, snapshots: readonly SnapshotLike[]): ReconcilePlan {
  const cached = cache?.sessions ?? {}
  const plan: ReconcilePlan = { reuse: [], reread: [], drop: [] }
  const seen = new Set<string>()
  for (const snapshot of snapshots) {
    seen.add(snapshot.sessionId)
    const entry = cached[snapshot.sessionId]
    if (entry !== undefined && entry.rev === snapshot.rev) {
      plan.reuse.push({ sessionId: snapshot.sessionId, rev: entry.rev, docs: entry.docs })
      continue
    }
    plan.reread.push(snapshot)
  }
  for (const sessionId of Object.keys(cached)) {
    if (!seen.has(sessionId)) plan.drop.push(sessionId)
  }
  return plan
}

/**
 * Build the cache to persist from this boot's observations.
 *
 * Only pairs captured from a DURABLE read are accepted: each entry's \`rev\`
 * was observed before its documents were read, so the pair is self-consistent.
 * Documents from the live \`session/event\` feed are deliberately excluded —
 * an in-memory document can be ahead of the committed log (an event may be
 * appended but not yet flushed), and storing it under a revision that predates
 * it would make a later boot trust a document whose seq is not in the log,
 * which is exactly how a jump anchor goes stale.
 * @param observed - per-session revision and documents captured at boot.
 * @returns the cache value to write.
 */
export function buildCache(observed: ReadonlyMap<string, { rev: string; docs: readonly ScannedDoc[] }>): DocCache {
  const sessions: Record<string, CachedSession> = {}
  for (const [sessionId, entry] of observed) {
    sessions[sessionId] = {
      rev: entry.rev,
      docs: entry.docs.map((doc) => [doc.seq, doc.time, doc.text] as [number, number, string]),
    }
  }
  return { version: CACHE_VERSION, sessions }
}
