/**
 * Pure-unit tests for the client matcher/coloring helpers and the
 * highlight fingerprint logic (no DOM surgery in this suite — that part is
 * covered by manual acceptance).
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { findRunsInText, segmentsOf } from '../src/client/matcher.ts'
import { clearMarks, markConversation, matchIndices } from '../src/client/highlight.ts'

describe('findRunsInText', () => {
  it('substring matches case-insensitively', () => {
    expect(findRunsInText('修复 dsh-statusbar 槽位冲突', 'statusbar', false, false)).toEqual([{ start: 7, end: 16 }])
  })

  it('respects case sensitivity', () => {
    expect(findRunsInText('NPM registry', 'npm', false, true)).toBeNull()
    expect(findRunsInText('NPM registry', 'NPM', false, true)).not.toBeNull()
  })

  it('fuzzy subsequence splits into contiguous runs', () => {
    const runs = findRunsInText('npm registry mirror', 'npmreg', true, false)
    expect(runs).not.toBeNull()
    expect(runs!.length).toBeGreaterThan(0)
    const covered = runs!.map((run) => 'npm registry mirror'.slice(run.start, run.end)).join('')
    expect(covered).toBe('npmreg')
  })

  it('whole-word rejects glued hits and accepts boundary hits', () => {
    expect(findRunsInText('pnpm 对 file', 'npm', false, false, true)).toBeNull()
    expect(findRunsInText('batnpmdom', 'npm', false, false, true)).toBeNull()
    expect(findRunsInText('使用npm管理', 'npm', false, false, true)).toEqual([{ start: 2, end: 5 }])
    expect(findRunsInText('npx 与 npm 关系', 'npm', false, false, true)).toEqual([{ start: 6, end: 9 }])
  })
})

describe('segmentsOf', () => {
  it('splits around a single run', () => {
    expect(segmentsOf('abcDEFghi', [{ start: 3, end: 6 }])).toEqual([
      { text: 'abc', hit: false },
      { text: 'DEF', hit: true },
      { text: 'ghi', hit: false },
    ])
  })

  it('handles multiple runs', () => {
    expect(segmentsOf('aXbYc', [{ start: 1, end: 2 }, { start: 3, end: 4 }]).map((s) => s.hit)).toEqual([false, true, false, true, false])
  })

  it('returns one plain segment without runs', () => {
    expect(segmentsOf('plain', null)).toEqual([{ text: 'plain', hit: false }])
  })
})

describe('matchIndices', () => {
  it('collects every occurrence, case-insensitive by default', () => {
    expect(matchIndices('npm and NPM', 'npm', false, false)).toEqual([0, 8])
  })

  it('honors case sensitivity and whole-word boundaries', () => {
    expect(matchIndices('npm and NPM', 'npm', true, false)).toEqual([0])
    expect(matchIndices('pnpm npm', 'npm', false, true)).toEqual([5])
  })
})

describe('markConversation', () => {
  const buildDom = () => {
    const container = document.createElement('div')
    const row = document.createElement('div')
    row.textContent = 'npm 与 npm 的关系'
    const other = document.createElement('div')
    other.textContent = '另一个 npm 消息'
    container.append(row, other)
    return { container, row }
  }

  it('fills the clicked occurrence in the row and boxes the rest', () => {
    const { container, row } = buildDom()
    const status = markConversation(container, row, { sessionId: 's1', query: 'npm', occurrenceIndex: 1 })
    expect(status.found).toBe(true)
    const filled = container.querySelectorAll('span.dsh-search-hit')
    const boxed = container.querySelectorAll('span.dsh-search-hit-box')
    expect(filled).toHaveLength(1)
    expect(filled[0].textContent).toBe('npm')
    expect(row.textContent).toBe('npm 与 npm 的关系')
    // row 内另一处 + 另一行一处被框选
    expect(boxed).toHaveLength(2)
    // 填充的是 row 内第二处（第一处被框选）
    const spans = row.querySelectorAll('span')
    expect(spans[0].className).toBe('dsh-search-hit-box')
    expect(spans[1].className).toBe('dsh-search-hit')
  })

  it('marks multiple occurrences in one text node without offset drift', () => {
    const container = document.createElement('div')
    const row = document.createElement('div')
    row.textContent = 'npm npm npm'
    container.append(row)
    markConversation(container, row, { sessionId: 's1', query: 'npm', occurrenceIndex: 0 })
    expect(row.querySelectorAll('span.dsh-search-hit')).toHaveLength(1)
    expect(row.querySelectorAll('span.dsh-search-hit-box')).toHaveLength(2)
    expect(row.textContent).toBe('npm npm npm')
  })

  it('clearMarks restores the original text', () => {
    const { container, row } = buildDom()
    document.body.appendChild(container)
    try {
      markConversation(container, row, { sessionId: 's1', query: 'npm', occurrenceIndex: 0 })
      clearMarks()
      expect(container.querySelectorAll('span.dsh-search-hit, span.dsh-search-hit-box')).toHaveLength(0)
      expect(row.textContent).toBe('npm 与 npm 的关系')
    } finally {
      container.remove()
    }
  })
})
