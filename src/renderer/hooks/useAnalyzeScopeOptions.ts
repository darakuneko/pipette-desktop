// SPDX-License-Identifier: GPL-2.0-or-later
// Device / Keymap-snapshot option data for a single Analyze uid.
// Extracted from `AnalyzePane` (the Device select's labelled options and
// the snapshot timeline's option list both used to live inline, bound to
// the pane's committed keyboard) so the filter modal can resolve the
// same option lists for a *draft* uid — the keyboard the user is about
// to switch to, before Apply commits it as the pane's selection.
//
// Deliberately narrow: this hook only owns the fetch/cancel/loading-flag
// plumbing for the two option lists. Anything that reacts to the results
// (persisted-hash fallback, "jump to latest snapshot" range auto-set,
// `selectedSnapshotSavedAt`) stays with the consumer, since those are
// side effects specific to how the *committed* pane uses the data, not
// part of "what are the available options".
//
// Uid-consistency contract: the returned data is derived against `uid`
// at render time (each state entry is tagged with the uid it was fetched
// for), so the very first render after a uid switch already returns the
// empty/loading shape. An effect-based clear would lag one commit behind
// and let a consumer's same-commit effect act on the PREVIOUS uid's
// summaries (e.g. mark the new uid as auto-ranged using the old list).

import { useEffect, useState } from 'react'
import type {
  TypingAnalyticsDeviceInfo,
  TypingKeymapSnapshotSummary,
} from '../../shared/types/typing-analytics'

export interface AnalyzeDeviceInfos {
  own: TypingAnalyticsDeviceInfo | null
  remotes: readonly TypingAnalyticsDeviceInfo[]
  /** True once the fetch has resolved (success or explicit "no data").
   * Stays `false` on a rejected fetch (see `error`) so callers can tell
   * "still resolving / failed" apart from "resolved empty" — a fallback
   * that prunes stale hash scopes once the list is known must not run
   * before this flips true, or it would wipe a valid persisted selection
   * during the fetch. */
  loaded: boolean
  /** True when the fetch rejected. Kept distinct from `loaded` so a
   * loading overlay can release on failure instead of waiting forever. */
  error: boolean
}

const EMPTY_DEVICE_INFOS: AnalyzeDeviceInfos = { own: null, remotes: [], loaded: false, error: false }
const EMPTY_SUMMARIES: TypingKeymapSnapshotSummary[] = []

export interface UseAnalyzeScopeOptionsReturn {
  deviceInfos: AnalyzeDeviceInfos
  snapshotSummaries: TypingKeymapSnapshotSummary[]
  /** True while the snapshot-summary list is being (re)fetched for `uid`. */
  summariesLoading: boolean
}

/** Fetch the Device (own + remotes) and Keymap-snapshot-summary option
 * lists for `uid`. The returned values are always consistent with the
 * `uid` passed on the *current* render (see the uid-consistency note in
 * the module doc comment) — a stale render from the previous keyboard
 * can never leak into the next one, not even for a single commit. */
export function useAnalyzeScopeOptions(uid: string | null): UseAnalyzeScopeOptionsReturn {
  // Each resolved payload is tagged with the uid it belongs to; the
  // derivations below mask any entry whose tag doesn't match the current
  // `uid` prop, which is what makes the hook render-synchronous.
  const [deviceState, setDeviceState] = useState<{ forUid: string; infos: AnalyzeDeviceInfos } | null>(null)
  const [summariesState, setSummariesState] = useState<{ forUid: string; list: TypingKeymapSnapshotSummary[] } | null>(null)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    void window.vialAPI
      .typingAnalyticsListDeviceInfos(uid)
      .then((bundle) => {
        if (cancelled) return
        setDeviceState({
          forUid: uid,
          infos: bundle === null
            ? { own: null, remotes: [], loaded: true, error: false }
            : { own: bundle.own, remotes: bundle.remotes, loaded: true, error: false },
        })
      })
      // `loaded: false` on error keeps a "missing from list" fallback from
      // wiping a valid persisted hash selection; `error: true` lets a
      // loading overlay release instead of stalling on "preparing".
      .catch(() => {
        if (!cancelled) {
          setDeviceState({ forUid: uid, infos: { own: null, remotes: [], loaded: false, error: true } })
        }
      })
    return () => { cancelled = true }
  }, [uid])

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    void window.vialAPI
      .typingAnalyticsListKeymapSnapshots(uid)
      .then((list) => {
        if (!cancelled) setSummariesState({ forUid: uid, list })
      })
      .catch(() => {
        if (!cancelled) setSummariesState({ forUid: uid, list: [] })
      })
    return () => { cancelled = true }
  }, [uid])

  const deviceInfos = uid !== null && deviceState?.forUid === uid
    ? deviceState.infos
    : EMPTY_DEVICE_INFOS
  const snapshotSummaries = uid !== null && summariesState?.forUid === uid
    ? summariesState.list
    : EMPTY_SUMMARIES
  // Loading = a uid is selected but no resolved payload for it yet. A
  // rejected fetch resolves to an empty list, so errors release the flag.
  const summariesLoading = uid !== null && summariesState?.forUid !== uid

  return { deviceInfos, snapshotSummaries, summariesLoading }
}
