/** Unit tests for the search filter chip/highlight rules. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS, filterChipKeys, filtersDiffer, type SearchFilters } from '../src/client/filters.ts'

const base = (patch: Partial<SearchFilters>): SearchFilters => ({ ...DEFAULT_FILTERS, ...patch })

describe('filterChipKeys', () => {
  it('shows the fuzzy chip when fuzzy is ON (never the inverted form)', () => {
    expect(filterChipKeys(base({ fuzzy: true }))).toEqual(['searchPlus.chipFuzzy'])
  })

  it('shows nothing by default (substring mode has no chip)', () => {
    expect(filterChipKeys(base({}))).toEqual([])
  })

  it('shows the case chip only when case-sensitive is on', () => {
    expect(filterChipKeys(base({ caseSensitive: true }))).toEqual(['searchPlus.chipCase'])
  })

  it('shows the whole-word chip when whole-word is on', () => {
    expect(filterChipKeys(base({ wholeWord: true }))).toEqual(['searchPlus.chipWord'])
  })

  it('shows the scope chip only for non-default scopes, in order', () => {
    expect(filterChipKeys(base({ scope: 'title', caseSensitive: true }))).toEqual(['searchPlus.scopeTitle', 'searchPlus.chipCase'])
    expect(filterChipKeys(base({ scope: 'content' }))).toEqual(['searchPlus.scopeContent'])
  })
})

describe('filtersDiffer', () => {
  it('is false for the defaults', () => {
    expect(filtersDiffer(base({}))).toBe(false)
  })

  it('is true when any single filter deviates', () => {
    expect(filtersDiffer(base({ scope: 'title' }))).toBe(true)
    expect(filtersDiffer(base({ fuzzy: true }))).toBe(true)
    expect(filtersDiffer(base({ caseSensitive: true }))).toBe(true)
    expect(filtersDiffer(base({ wholeWord: true }))).toBe(true)
  })
})
