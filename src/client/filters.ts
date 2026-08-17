/** Search mode toggles for the enhanced search box (vscode-style inline buttons). */

export interface SearchFilters {
  fuzzy: boolean
  caseSensitive: boolean
  /** Whole-word: hits must not touch ASCII word chars. Stacks with regex (a `\b` wrap). */
  wholeWord: boolean
  /** Query is a regular expression. Mutually exclusive with fuzzy. */
  regex: boolean
}

export const DEFAULT_FILTERS: SearchFilters = { fuzzy: false, caseSensitive: false, wholeWord: false, regex: false }

export type SearchFilterKey = keyof SearchFilters

/**
 * Toggle one filter. vscode semantics: case is independent; wholeWord stacks
 * with regex (vscode wraps the pattern in `\b`); fuzzy — our addition — is a
 * subsequence mode, so it excludes regex and wholeWord.
 */
export function applyToggle(filters: SearchFilters, key: SearchFilterKey): SearchFilters {
  switch (key) {
    case 'caseSensitive':
      return { ...filters, caseSensitive: !filters.caseSensitive }
    case 'fuzzy':
      return filters.fuzzy ? { ...filters, fuzzy: false } : { ...filters, fuzzy: true, regex: false, wholeWord: false }
    case 'regex':
      return filters.regex ? { ...filters, regex: false } : { ...filters, regex: true, fuzzy: false }
    case 'wholeWord':
      return filters.wholeWord ? { ...filters, wholeWord: false } : { ...filters, wholeWord: true, fuzzy: false }
  }
}
