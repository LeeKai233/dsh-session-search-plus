/**
 * Pure-unit tests for the host search engine pieces: matcher, snippet
 * builder, event text extraction, in-memory index, and the HTTP route.
 */
import { describe, expect, it } from 'vitest'
import { SearchIndex, eventSearchText, findRuns, handleSearchRequest, snippetOf } from '../src/index.ts'

describe('findRuns', () => {
  it('substring matches case-insensitively by default', () => {
    const found = findRuns('Install NPM packages', 'install npm packages', 'npm', false, false)
    expect(found).not.toBeNull()
    expect(found?.runs).toEqual([{ start: 8, end: 11 }])
  })

  it('substring respects case sensitivity', () => {
    expect(findRuns('Install npm packages', 'install npm packages', 'NPM', false, true)).toBeNull()
    expect(findRuns('Install NPM packages', 'install npm packages', 'NPM', false, true)).not.toBeNull()
  })

  it('fuzzy subsequence finds scattered characters', () => {
    const found = findRuns('npm registry mirror', 'npm registry mirror', 'npmreg', true, false)
    expect(found).not.toBeNull()
    expect(found?.runs.length).toBeGreaterThan(0)
  })

  it('fuzzy scoring prefers consecutive runs', () => {
    const scattered = findRuns('n x m y p', 'n x m y p', 'nmp', true, false)
    const tight = findRuns('nmp xyz', 'nmp xyz', 'nmp', true, false)
    expect(scattered).not.toBeNull()
    expect(tight).not.toBeNull()
    expect(tight!.score).toBeGreaterThan(scattered!.score)
  })

  it('returns null when nothing matches', () => {
    expect(findRuns('nothing here', 'nothing here', 'zzz', false, false)).toBeNull()
    expect(findRuns('abc', 'abc', 'z', true, false)).toBeNull()
  })

  it('whole-word rejects hits glued to ASCII word chars', () => {
    expect(findRuns('pnpm 对 file', 'pnpm 对 file', 'npm', false, false, true)).toBeNull()
    expect(findRuns('batnpmdom', 'batnpmdom', 'npm', false, false, true)).toBeNull()
  })

  it('whole-word accepts real boundaries, CJK and punctuation included', () => {
    expect(findRuns('npm 包管理', 'npm 包管理', 'npm', false, false, true)?.runs).toEqual([{ start: 0, end: 3 }])
    expect(findRuns('使用npm管理', '使用npm管理', 'npm', false, false, true)?.runs).toEqual([{ start: 2, end: 5 }])
    expect(findRuns('(npm) install', '(npm) install', 'npm', false, false, true)?.runs).toEqual([{ start: 1, end: 4 }])
  })

  it('whole-word scans past a glued occurrence to a later clean one', () => {
    expect(findRuns('pnpm, npm', 'pnpm, npm', 'npm', false, false, true)?.runs).toEqual([{ start: 6, end: 9 }])
  })

  it('whole-word is ignored under fuzzy', () => {
    expect(findRuns('pnpm', 'pnpm', 'npm', true, false, true)).not.toBeNull()
  })

  it('regex matches patterns and honors case and \b wrap', () => {
    expect(findRuns('run npm install now', 'run npm install now', 'npm.*install', false, false, false, true)?.runs).toEqual([{ start: 4, end: 15 }])
    expect(findRuns('run NPM install', 'run NPM install', 'npm.*install', false, false, false, true)?.runs).toEqual([{ start: 4, end: 15 }])
    expect(findRuns('run NPM install', 'run NPM install', 'npm.*install', false, true, false, true)).toBeNull()
    expect(findRuns('xnpm install', 'xnpm install', 'npm', false, false, true, true)).toBeNull()
    expect(findRuns('(npm) install', '(npm) install', 'npm', false, false, true, true)?.runs).toEqual([{ start: 1, end: 4 }])
  })

  it('regex returns null for invalid patterns and zero-width matches', () => {
    expect(findRuns('anything', 'anything', 'np[', false, false, false, true)).toBeNull()
    expect(findRuns('anything', 'anything', 'n*', false, false, false, true)).toBeNull()
  })
})

describe('snippetOf', () => {
  it('windows around the match with ellipses', () => {
    const text = 'a'.repeat(300) + 'npm' + 'b'.repeat(300)
    const snippet = snippetOf(text, [{ start: 300, end: 303 }])
    expect(snippet.text.startsWith('…')).toBe(true)
    expect(snippet.text.endsWith('…')).toBe(true)
    expect(snippet.text.slice(snippet.matchRuns[0].start, snippet.matchRuns[0].end)).toBe('npm')
  })

  it('keeps short texts intact', () => {
    const snippet = snippetOf('hello npm world', [{ start: 6, end: 9 }])
    expect(snippet.text).toBe('hello npm world')
    expect(snippet.matchRuns).toEqual([{ start: 6, end: 9 }])
  })

  it('maps every fuzzy run into the window', () => {
    const text = 'a'.repeat(100) + 'npm' + 'b'.repeat(20) + 'x' + 'c'.repeat(100)
    const snippet = snippetOf(text, [{ start: 100, end: 103 }, { start: 123, end: 124 }])
    const covered = snippet.matchRuns.map((run) => snippet.text.slice(run.start, run.end)).join('')
    expect(covered).toBe('npmx')
  })
})

describe('eventSearchText', () => {
  const userEvent = (content: unknown) => ({ type: 'user/message', data: { content } })
  const assistantEvent = (content: unknown) => ({ type: 'assistant/message', data: { message: { content } } })

  it('extracts only text blocks from user messages (context injections included)', () => {
    expect(eventSearchText(userEvent([{ type: 'text', text: '  fix the npm build  ' }]))).toBe('fix the npm build')
  })

  it('excludes reasoning and tool-call blocks', () => {
    const text = eventSearchText(assistantEvent([
      { type: 'reasoning', text: 'npm npm npm' },
      { type: 'tool-call', name: 'bash', arguments: '{"cmd":"npm i"}' },
      { type: 'text', text: 'installed npm' },
    ]))
    expect(text).toBe('installed npm')
  })

  it('returns undefined for tool events and structural noise', () => {
    expect(eventSearchText({ type: 'tool/call', data: { name: 'bash', arguments: 'npm' } })).toBeUndefined()
    expect(eventSearchText({ type: 'tool/result', data: {} })).toBeUndefined()
    expect(eventSearchText({ type: 'todo/write', data: { todos: [{ status: 'x', content: 'npm' }] } })).toBeUndefined()
    expect(eventSearchText({ type: 'turn/end', data: {} })).toBeUndefined()
    expect(eventSearchText(userEvent([]))).toBeUndefined()
  })
})

describe('SearchIndex', () => {
  it('dedupes by (sessionId, seq)', () => {
    const index = new SearchIndex()
    index.put('s1', 1, 10, 'first npm mention')
    index.put('s1', 1, 20, 'duplicate later npm mention')
    expect(index.size()).toBe(1)
  })

  it('groups hits per session and counts occurrenceIndex', () => {
    const index = new SearchIndex()
    index.put('s1', 1, 100, 'npm zero. npm one.')
    index.put('s2', 1, 200, 'only npm here')
    const groups = index.query({ query: 'npm', fuzzy: false, caseSensitive: false, wholeWord: false, regex: false, scope: 'content', limit: 10 })
    expect(groups).toHaveLength(2)
    const s1 = groups.find((group) => group.sessionId === 's1')
    expect(s1?.matches[0].occurrenceIndex).toBe(0)
    const s2 = groups.find((group) => group.sessionId === 's2')
    expect(s2?.matches[0].occurrenceIndex).toBe(0)
  })

  it('caps per-session hits and honors the session limit', () => {
    const index = new SearchIndex()
    for (let seq = 1; seq <= 20; seq++) index.put('s1', seq, 2000 + seq, `npm mention ${seq}`)
    for (let n = 1; n <= 60; n++) index.put(`s${n + 1}`, 1, n, `npm in session ${n}`)
    const groups = index.query({ query: 'npm', fuzzy: false, caseSensitive: false, wholeWord: false, regex: false, scope: 'content', limit: 10 })
    expect(groups).toHaveLength(10)
    expect(groups.find((group) => group.sessionId === 's1')?.matches.length).toBe(8)
  })

  it('supports case-sensitive and fuzzy modes', () => {
    const index = new SearchIndex()
    index.put('s1', 1, 1, 'NPM registry')
    expect(index.query({ query: 'npm', fuzzy: false, caseSensitive: true, wholeWord: false, regex: false, scope: 'content', limit: 10 })).toHaveLength(0)
    expect(index.query({ query: 'NPM', fuzzy: false, caseSensitive: true, wholeWord: false, regex: false, scope: 'content', limit: 10 })).toHaveLength(1)
    index.put('s2', 1, 2, 'n x p x m scattered')
    expect(index.query({ query: 'npm', fuzzy: true, caseSensitive: false, wholeWord: false, regex: false, scope: 'content', limit: 10 })).toHaveLength(2)
  })

  it('whole-word filters glued hits end to end', () => {
    const index = new SearchIndex()
    index.put('s1', 1, 1, 'pnpm workspace npm 对 file 引用')
    index.put('s2', 1, 2, 'batnpmdom glued')
    const groups = index.query({ query: 'npm', fuzzy: false, caseSensitive: false, wholeWord: true, regex: false, scope: 'content', limit: 10 })
    expect(groups.map((group) => group.sessionId)).toEqual(['s1'])
    expect(groups[0].snippet).toContain('npm')
  })

  it('collapses identical snippets within one session', () => {
    const index = new SearchIndex()
    index.put('s1', 1, 100, '重复注入的 npm 上下文')
    index.put('s1', 2, 200, '重复注入的 npm 上下文')
    index.put('s1', 3, 300, '另一条 npm 消息')
    const groups = index.query({ query: 'npm', fuzzy: false, caseSensitive: false, wholeWord: false, regex: false, scope: 'content', limit: 10 })
    expect(groups[0].matches).toHaveLength(2)
    expect(groups[0].matches.map((hit) => hit.seq)).toEqual([1, 3])
  })

  it('regex queries match patterns end to end', () => {
    const index = new SearchIndex()
    index.put('s1', 1, 100, 'please run npm install first')
    index.put('s2', 1, 200, 'nothing here')
    const groups = index.query({ query: 'npm\\s+install', fuzzy: false, caseSensitive: false, wholeWord: false, regex: true, scope: 'content', limit: 10 })
    expect(groups.map((group) => group.sessionId)).toEqual(['s1'])
    const hit = groups[0].matches[0]
    expect(hit.snippet.slice(hit.matchRuns[0].start, hit.matchRuns[0].end)).toBe('npm install')
  })
})

describe('handleSearchRequest', () => {
  interface FakeResponse {
    code: number
    headers: Record<string, string | number | string[] | undefined>
    body: string
  }

  function fakeRes(): FakeResponse & { writeHead(code: number, headers?: Record<string, string | number | string[] | undefined>): void; end(text?: string): void } {
    const res = { code: 0, headers: {}, body: '' } as FakeResponse & {
      writeHead(code: number, headers?: Record<string, string | number | string[] | undefined>): void
      end(text?: string): void
    }
    res.writeHead = (code, headers) => {
      res.code = code
      res.headers = headers ?? {}
    }
    res.end = (text) => {
      res.body = text ?? ''
    }
    return res
  }

  function fakeReq(input: { method?: string; url?: string; origin?: string; body?: string }) {
    const body = input.body ?? ''
    return {
      method: input.method ?? 'POST',
      url: input.url ?? '/query',
      headers: input.origin === undefined ? {} : { origin: input.origin },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(body)
      },
    } as never
  }

  it('serves a JSON page for a valid same-origin query', async () => {
    const index = new SearchIndex()
    index.put('s1', 1, 100, 'npm registry mirror')
    const res = fakeRes()
    await handleSearchRequest(index, fakeReq({ url: '/api/search-plus/query', body: JSON.stringify({ query: 'npm', limit: 5 }) }), res as never)
    expect(res.code).toBe(200)
    const payload = JSON.parse(res.body) as { items: Array<{ sessionId: string; matches: Array<{ snippet: string; matchRuns: Array<{ start: number; end: number }> }> }> }
    expect(payload.items).toHaveLength(1)
    const hit = payload.items[0].matches[0]
    expect(hit.snippet.slice(hit.matchRuns[0].start, hit.matchRuns[0].end)).toBe('npm')
  })

  it('rejects non-query subpaths', async () => {
    const res = fakeRes()
    await handleSearchRequest(new SearchIndex(), fakeReq({ url: '/api/search-plus/other', body: '{}' }), res as never)
    expect(res.code).toBe(405)
  })

  it('rejects cross-origin callers', async () => {
    const res = fakeRes()
    await handleSearchRequest(new SearchIndex(), fakeReq({ origin: 'http://evil.example' }), res as never)
    expect(res.code).toBe(403)
  })

  it('rejects non-POST methods', async () => {
    const res = fakeRes()
    await handleSearchRequest(new SearchIndex(), fakeReq({ method: 'GET' }), res as never)
    expect(res.code).toBe(405)
  })

  it('rejects malformed JSON', async () => {
    const res = fakeRes()
    await handleSearchRequest(new SearchIndex(), fakeReq({ body: '{not json' }), res as never)
    expect(res.code).toBe(400)
  })
})
