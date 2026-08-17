/** Unit tests for the search mode toggle matrix (vscode semantics). */
import { describe, expect, it } from 'vitest'
import { applyToggle, DEFAULT_FILTERS, type SearchFilters } from '../src/client/filters.ts'

const base = (patch: Partial<SearchFilters>): SearchFilters => ({ ...DEFAULT_FILTERS, ...patch })

describe('applyToggle', () => {
  it('case toggles independently', () => {
    expect(applyToggle(base({}), 'caseSensitive')).toEqual(base({ caseSensitive: true }))
    expect(applyToggle(base({ caseSensitive: true, regex: true }), 'caseSensitive')).toEqual(base({ regex: true }))
  })

  it('fuzzy excludes regex and wholeWord', () => {
    expect(applyToggle(base({ regex: true, wholeWord: true }), 'fuzzy')).toEqual(base({ fuzzy: true }))
    expect(applyToggle(base({ fuzzy: true }), 'fuzzy')).toEqual(base({}))
  })

  it('regex excludes fuzzy but stacks with wholeWord', () => {
    expect(applyToggle(base({ fuzzy: true }), 'regex')).toEqual(base({ regex: true }))
    expect(applyToggle(base({ wholeWord: true }), 'regex')).toEqual(base({ wholeWord: true, regex: true }))
    expect(applyToggle(base({ regex: true }), 'regex')).toEqual(base({}))
  })

  it('wholeWord excludes fuzzy but stacks with regex', () => {
    expect(applyToggle(base({ fuzzy: true }), 'wholeWord')).toEqual(base({ wholeWord: true }))
    expect(applyToggle(base({ regex: true }), 'wholeWord')).toEqual(base({ regex: true, wholeWord: true }))
    expect(applyToggle(base({ wholeWord: true }), 'wholeWord')).toEqual(base({}))
  })
})
