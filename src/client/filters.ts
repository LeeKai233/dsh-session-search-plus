/** Filter state for the enhanced search box: chips and the popover share these. */

export interface SearchFilters {
  scope: 'all' | 'title' | 'content'
  fuzzy: boolean
  caseSensitive: boolean
  /** Whole-word: substring hits must not touch ASCII word chars. Mutually exclusive with fuzzy. */
  wholeWord: boolean
}

export const DEFAULT_FILTERS: SearchFilters = { scope: 'all', fuzzy: false, caseSensitive: false, wholeWord: false }

/**
 * Whether the filter set differs from the defaults — drives the filter
 * button's active (◈) highlight.
 */
export function filtersDiffer(filters: SearchFilters): boolean {
  return filters.scope !== DEFAULT_FILTERS.scope
    || filters.fuzzy !== DEFAULT_FILTERS.fuzzy
    || filters.caseSensitive !== DEFAULT_FILTERS.caseSensitive
    || filters.wholeWord !== DEFAULT_FILTERS.wholeWord
}

/**
 * Locale keys of the state chips, in display order. A chip shows the mode
 * that is ON: fuzzy on → fuzzy chip (never the inverted "off shows" form).
 */
export function filterChipKeys(filters: SearchFilters): string[] {
  const keys: string[] = []
  if (filters.scope !== 'all') keys.push(filters.scope === 'title' ? 'searchPlus.scopeTitle' : 'searchPlus.scopeContent')
  if (filters.fuzzy) keys.push('searchPlus.chipFuzzy')
  if (filters.caseSensitive) keys.push('searchPlus.chipCase')
  if (filters.wholeWord) keys.push('searchPlus.chipWord')
  return keys
}
