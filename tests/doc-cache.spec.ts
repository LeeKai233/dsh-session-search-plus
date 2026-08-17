/**
 * Tests for the persisted document cache: codec round-trip, the fail-soft
 * degradation rules, the reuse/re-read/drop planner, and path resolution.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CACHE_FILE_NAME,
  CACHE_VERSION,
  buildCache,
  decodeCache,
  emptyCache,
  encodeCache,
  planReconcile,
  readCache,
  resolveCachePath,
  validateCache,
  writeCache,
  type DocCache,
} from '../src/doc-cache.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'search-plus-cache-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sample: DocCache = {
  version: CACHE_VERSION,
  sessions: {
    s1: { rev: '1:2:3:4:5', docs: [[1, 1000, 'hello'], [4, 1003, 'world']] },
    s2: { rev: '9:9:9:9:9', docs: [] },
  },
}

describe('codec', () => {
  it('round-trips a cache', () => {
    expect(decodeCache(encodeCache(sample))).toEqual(sample)
  })

  it('round-trips through a file', () => {
    const path = join(dir, CACHE_FILE_NAME)
    writeCache(path, sample)
    expect(readCache(path)).toEqual(sample)
  })

  it('preserves multi-line and non-ASCII text exactly', () => {
    const tricky: DocCache = {
      version: CACHE_VERSION,
      sessions: { s: { rev: 'r', docs: [[1, 2, 'ä¸­æ–‡\nç¬¬äºŒè¡Œ\tðŸ³']] } },
    }
    expect(decodeCache(encodeCache(tricky))?.sessions.s.docs[0][2]).toBe('ä¸­æ–‡\nç¬¬äºŒè¡Œ\tðŸ³')
  })

  it('publishes atomically and leaves no temp file behind', () => {
    const path = join(dir, CACHE_FILE_NAME)
    writeCache(path, sample)
    writeCache(path, sample)
    const leftovers = readFileSync(path)
    expect(leftovers.length).toBeGreaterThan(0)
    expect(readCache(path)).toEqual(sample)
  })
})

describe('fail-soft degradation', () => {
  it('reports an absent file as no cache', () => {
    expect(readCache(join(dir, 'missing.json.zstd'))).toBeUndefined()
  })

  it('rejects bytes that are not zstd', () => {
    const path = join(dir, CACHE_FILE_NAME)
    writeFileSync(path, Buffer.from('definitely not zstd'))
    expect(readCache(path)).toBeUndefined()
  })

  it('rejects zstd that is not JSON', () => {
    const path = join(dir, CACHE_FILE_NAME)
    writeFileSync(path, zstdCompressSync(Buffer.from('{ not json')))
    expect(readCache(path)).toBeUndefined()
  })

  it('discards a different format version instead of migrating it', () => {
    const path = join(dir, CACHE_FILE_NAME)
    writeFileSync(path, zstdCompressSync(Buffer.from(JSON.stringify({ ...sample, version: CACHE_VERSION + 1 }))))
    expect(readCache(path)).toBeUndefined()
  })

  it('rejects structurally wrong records', () => {
    expect(validateCache(null)).toBeUndefined()
    expect(validateCache({ version: CACHE_VERSION })).toBeUndefined()
    expect(validateCache({ version: CACHE_VERSION, sessions: [] })).toBeUndefined()
    expect(validateCache({ version: CACHE_VERSION, sessions: { s: { docs: [] } } })).toBeUndefined()
    expect(validateCache({ version: CACHE_VERSION, sessions: { s: { rev: 'r' } } })).toBeUndefined()
    expect(validateCache({ version: CACHE_VERSION, sessions: { s: { rev: 'r', docs: [[1, 2]] } } })).toBeUndefined()
    expect(validateCache({ version: CACHE_VERSION, sessions: { s: { rev: 'r', docs: [['1', 2, 'x']] } } })).toBeUndefined()
    expect(validateCache({ version: CACHE_VERSION, sessions: { s: { rev: 'r', docs: [[1, 2, 3]] } } })).toBeUndefined()
  })

  it('accepts an empty cache', () => {
    expect(validateCache(emptyCache())).toEqual(emptyCache())
  })
})

describe('planReconcile', () => {
  const snapshots = [
    { sessionId: 's1', rev: 'rev-1' },
    { sessionId: 's2', rev: 'rev-2' },
  ]

  it('reuses a session whose revision is unchanged', () => {
    const cache: DocCache = { version: CACHE_VERSION, sessions: { s1: { rev: 'rev-1', docs: [[1, 2, 'x']] } } }
    const plan = planReconcile(cache, snapshots)
    expect(plan.reuse).toEqual([{ sessionId: 's1', rev: 'rev-1', docs: [[1, 2, 'x']] }])
    expect(plan.reread).toEqual([{ sessionId: 's2', rev: 'rev-2' }])
    expect(plan.drop).toEqual([])
  })

  it('re-reads a session whose revision moved', () => {
    const cache: DocCache = { version: CACHE_VERSION, sessions: { s1: { rev: 'stale', docs: [[1, 2, 'x']] } } }
    const plan = planReconcile(cache, snapshots)
    expect(plan.reuse).toEqual([])
    expect(plan.reread.map((entry) => entry.sessionId)).toEqual(['s1', 's2'])
  })

  it('drops a cached session that no longer exists', () => {
    const cache: DocCache = {
      version: CACHE_VERSION,
      sessions: { s1: { rev: 'rev-1', docs: [] }, gone: { rev: 'whatever', docs: [] } },
    }
    const plan = planReconcile(cache, snapshots)
    expect(plan.drop).toEqual(['gone'])
    expect(plan.reuse.map((entry) => entry.sessionId)).toEqual(['s1'])
  })

  it('re-reads everything when there is no cache', () => {
    const plan = planReconcile(undefined, snapshots)
    expect(plan.reuse).toEqual([])
    expect(plan.reread).toEqual(snapshots)
    expect(plan.drop).toEqual([])
  })

  it('reuses nothing when a revision is an empty token', () => {
    // The fallback listing path uses '' for "revision unknown"; an unknown
    // token must never compare equal to a stored one.
    const cache: DocCache = { version: CACHE_VERSION, sessions: { s1: { rev: '', docs: [[1, 2, 'x']] } } }
    const plan = planReconcile(cache, [{ sessionId: 's1', rev: 'rev-1' }])
    expect(plan.reuse).toEqual([])
    expect(plan.reread).toEqual([{ sessionId: 's1', rev: 'rev-1' }])
  })

  it('handles an empty corpus', () => {
    const cache: DocCache = { version: CACHE_VERSION, sessions: { s1: { rev: 'rev-1', docs: [] } } }
    expect(planReconcile(cache, [])).toEqual({ reuse: [], reread: [], drop: ['s1'] })
  })
})

describe('buildCache', () => {
  it('packs observed documents into storage tuples', () => {
    const observed = new Map([
      ['s1', { rev: 'rev-1', docs: [{ seq: 1, time: 1000, text: 'hello' }] }],
    ])
    expect(buildCache(observed)).toEqual({
      version: CACHE_VERSION,
      sessions: { s1: { rev: 'rev-1', docs: [[1, 1000, 'hello']] } },
    })
  })

  it('round-trips through the codec unchanged', () => {
    const observed = new Map([
      ['s1', { rev: 'rev-1', docs: [{ seq: 3, time: 30, text: 'a' }, { seq: 4, time: 40, text: 'b' }] }],
      ['s2', { rev: 'rev-2', docs: [] }],
    ])
    const cache = buildCache(observed)
    expect(decodeCache(encodeCache(cache))).toEqual(cache)
  })

  it('produces an empty cache from no observations', () => {
    expect(buildCache(new Map())).toEqual(emptyCache())
  })
})

describe('resolveCachePath', () => {
  it('prefers an explicit absolute path', () => {
    expect(resolveCachePath('/tmp/custom-cache.zstd', {})).toBe('/tmp/custom-cache.zstd')
  })

  it('uses DSH_HOME when no path is configured', () => {
    expect(resolveCachePath(undefined, { DSH_HOME: '/custom/home' })).toBe(join('/custom/home', CACHE_FILE_NAME))
  })

  it('treats a blank DSH_HOME as unset rather than resolving to the cwd', () => {
    const resolved = resolveCachePath(undefined, { DSH_HOME: '   ' })
    expect(resolved.endsWith(join('.dsh', CACHE_FILE_NAME))).toBe(true)
    expect(resolved.startsWith(process.cwd() + '/' + CACHE_FILE_NAME)).toBe(false)
  })

  it('falls back to the default home', () => {
    const resolved = resolveCachePath(undefined, {})
    expect(resolved.endsWith(join('.dsh', CACHE_FILE_NAME))).toBe(true)
  })

  it('ignores a blank configured path', () => {
    expect(resolveCachePath('   ', { DSH_HOME: '/custom/home' })).toBe(join('/custom/home', CACHE_FILE_NAME))
  })
})
