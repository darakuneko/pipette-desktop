// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared Hub search state machine for the Installed/Find-on-Hub pack
// modals. All three features (i18n, theme, key labels) run the same
// three effects against slightly different IPC calls and error copy:
//   - auto-fetch the unfiltered list when the Hub tab becomes active
//   - debounce-search once the query reaches 2+ characters
//   - reset search state when the modal closes
//
// `fetchPage` / `errorMessage` / `onSearchStart` / `onError` are kept in
// refs so the effects only depend on the primitive `open` / `activeTab`
// / `search` inputs — a fresh callback identity on every render must
// not re-arm the debounce timer (this mirrors the ref pattern the
// original KeyLabelsModal already used to avoid an update loop).
//
// `clearResultsOnError` preserves a real asymmetry: Key Labels clears
// the visible list on a failed search, i18n/theme packs leave the
// previous results on screen.
//
// `markSearchedOnFailure` preserves another real asymmetry in when
// `hubSearched` flips to true:
//   - i18n/theme only set it on a *successful* fetch. A failed initial
//     fetch leaves it false, so the "auto-fetch when the Hub tab
//     becomes active" effect below fires again the next time the user
//     leaves and re-enters the Hub tab (activeTab flips away and back).
//   - Key Labels sets it unconditionally, before the success check, so
//     a failed initial fetch does NOT auto-retry on tab re-entry — the
//     user has to type a query or hit Search again.
//
// A rejected `fetchPage` promise is folded into the same failure path
// as an unsuccessful `{ success: false }` response (see the inner
// try/catch in `runSearch`). This is an intentional deviation from the
// original per-modal code, which had no such handling:
//   - i18n/theme wrapped the await in try/finally with no catch, so a
//     rejection reset `hubSearching` but surfaced no error (silent,
//     relying on an unhandled rejection).
//   - Key Labels had no try/finally at all, so a rejection left
//     `hubSearching` stuck `true` forever (a latent stuck-spinner bug).
// Routing the rejection through the normal failure branch fixes both:
// the spinner always clears, and the user now sees the translated
// error message instead of silence — while `clearResultsOnError` and
// `markSearchedOnFailure` still apply exactly as they would for a
// non-throwing failed response, so no other behaviour changes.

import { useCallback, useEffect, useRef, useState } from 'react'
import { compareNames } from './useNameSort'

export interface HubSearchFetchResult<TItem> {
  success: boolean
  data?: { items: TItem[] }
  error?: string
}

export interface UseHubSearchListOptions<TItem> {
  open: boolean
  activeTab: string
  hubTabId: string
  /** Performs the Hub list IPC call for the given (already-trimmed for
   * debounce, raw for direct calls) query string. */
  fetchPage: (query: string) => Promise<HubSearchFetchResult<TItem>>
  /** Translates a failed fetch's `error` into the banner message. */
  errorMessage: (error: string | undefined) => string
  /** Called once at the start of every search (clears the feature's
   * own actionError state, matching each modal's prior inline reset). */
  onSearchStart: () => void
  /** Surfaces the translated error via the feature's own actionError state. */
  onError: (message: string) => void
  /** Key Labels only: clear the visible list on a failed search. */
  clearResultsOnError?: boolean
  /** Key Labels only: mark `hubSearched` true even when the fetch
   * failed, so the auto-fetch effect does not retry on tab re-entry. */
  markSearchedOnFailure?: boolean
}

export interface UseHubSearchListResult<TItem> {
  search: string
  setSearch: (value: string) => void
  hubResults: TItem[]
  hubSearched: boolean
  hubSearching: boolean
  runSearch: (query: string) => Promise<void>
}

export function useHubSearchList<TItem extends { name: string }>(
  options: UseHubSearchListOptions<TItem>,
): UseHubSearchListResult<TItem> {
  const { open, activeTab, hubTabId } = options
  const [search, setSearch] = useState('')
  const [hubResults, setHubResults] = useState<TItem[]>([])
  const [hubDefaultResults, setHubDefaultResults] = useState<TItem[]>([])
  const [hubSearched, setHubSearched] = useState(false)
  const [hubSearching, setHubSearching] = useState(false)

  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options })

  const runSearch = useCallback(async (query: string): Promise<void> => {
    setHubSearching(true)
    optionsRef.current.onSearchStart()
    try {
      let result: HubSearchFetchResult<TItem>
      try {
        result = await optionsRef.current.fetchPage(query)
      } catch (err) {
        // See the module-level comment: a thrown/rejected fetch is
        // treated exactly like a `{ success: false }` response instead
        // of leaving hubSearching stuck or failing silently.
        result = { success: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (result.success && result.data) {
        setHubSearched(true)
        // Name-sorted for all three modals (ports Key Labels' own
        // `buildHubRows` sort into this shared path so i18n/theme Hub
        // search results are no longer left in whatever order the
        // server returned).
        const sorted = result.data.items.slice().sort((a, b) => compareNames(a.name, b.name))
        setHubResults(sorted)
        if (!query.trim()) setHubDefaultResults(sorted)
      } else {
        if (optionsRef.current.markSearchedOnFailure) setHubSearched(true)
        optionsRef.current.onError(optionsRef.current.errorMessage(result.error))
        if (optionsRef.current.clearResultsOnError) setHubResults([])
      }
    } finally {
      setHubSearching(false)
    }
  }, [])

  // Auto-fetch the unfiltered Hub list when the Hub tab becomes active.
  // Re-fetches each time the modal is opened so results stay fresh.
  useEffect(() => {
    if (!open || activeTab !== hubTabId || hubSearched) return
    void runSearch('')
  }, [open, activeTab, hubTabId, hubSearched, runSearch])

  // Debounced search: fire once the user has typed 2+ characters.
  // Below the threshold restore the initial results instead of clearing.
  useEffect(() => {
    if (!open || activeTab !== hubTabId) return
    const query = search.trim()
    if (query.length < 2) {
      if (hubDefaultResults.length > 0) setHubResults(hubDefaultResults)
      return undefined
    }
    const handle = window.setTimeout(() => { void runSearch(query) }, 300)
    return () => { window.clearTimeout(handle) }
  }, [open, activeTab, hubTabId, search, runSearch, hubDefaultResults])

  // Reset hub state when the modal closes so the next open re-fetches fresh data.
  useEffect(() => {
    if (open) return
    setHubSearched(false)
    setHubResults([])
    setHubDefaultResults([])
    setSearch('')
  }, [open])

  return { search, setSearch, hubResults, hubSearched, hubSearching, runSearch }
}
