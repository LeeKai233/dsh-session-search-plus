/**
 * Browser-half entry (paradigm): the official-rc.6 WorkspaceBrowser fork with
 * the search-plus surgery lives in ./workspace-browser.js; this entry only
 * re-binds its apply/inject.
 */
import wb from './workspace-browser.js'

export const apply = wb.apply
export const inject = wb.inject
