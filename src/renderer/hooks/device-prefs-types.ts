// SPDX-License-Identifier: GPL-2.0-or-later

import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import type { KeymapRewriteTable } from '../../shared/keymap/keymap-apply'
import type { RemapKind } from '../components/keyboard/constants'
import type { TypingTestResult, TypingViewMenuTab, ViewMode, TypingTestMemory, TypingTestComparisonBaseline, TypingTestComparisonBaselines, ViewMatrixCell } from '../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../typing-test/types'
import type { AutoLockMinutes, BasicViewType, SplitKeyMode } from '../../shared/types/app-config'

export type { KeyboardLayoutId, AutoLockMinutes, BasicViewType, SplitKeyMode }

export interface UseDevicePrefsReturn {
  layout: KeyboardLayoutId
  autoAdvance: boolean
  layerPanelOpen: boolean
  basicViewType: BasicViewType
  splitKeyMode: SplitKeyMode
  quickSelect: boolean
  keymapScale: number
  layerNames: string[]
  typingTestResults: TypingTestResult[]
  typingTestConfig: TypingTestConfig | undefined
  typingTestMonkeytypeConfig: TypingTestConfig | undefined
  typingTestLanguage: string | undefined
  typingTestViewOnly: boolean
  typingTestViewOnlyWindowSize: { width: number; height: number } | undefined
  typingTestViewOnlyAlwaysOnTop: boolean
  typingTestMemory: TypingTestMemory | undefined
  typingTestDisplayLines: number
  typingTestFontSize: number
  typingTestHideKeymap: boolean
  typingTestHideStatsRow: boolean
  typingTestHideControls: boolean
  typingTestSaveUnnamed: boolean
  typingTestComparisonBaselines: TypingTestComparisonBaselines
  typingTestSettingsPanelOpen: boolean
  typingRecordEnabled: boolean
  typingViewMenuTab: TypingViewMenuTab
  viewMode: ViewMode
  keyEditorZoom: number | undefined
  viewMatrix: Record<string, ViewMatrixCell> | undefined
  appliedUid: string | null
  setLayout: (id: KeyboardLayoutId) => void
  setAutoAdvance: (enabled: boolean) => void
  setLayerPanelOpen: (open: boolean) => void
  setBasicViewType: (type: BasicViewType) => void
  setSplitKeyMode: (mode: SplitKeyMode) => void
  setQuickSelect: (enabled: boolean) => void
  setKeymapScale: (scale: number) => void
  setLayerNames: (names: string[]) => void
  addTypingTestResult: (result: TypingTestResult) => void
  renameTypingTestResult: (date: string, name: string) => void
  deleteTypingTestResult: (date: string) => void
  setTypingTestConfig: (config: TypingTestConfig) => void
  setTypingTestLanguage: (lang: string) => void
  setTypingTestViewOnly: (enabled: boolean) => void
  setTypingTestViewOnlyWindowSize: (size: { width: number; height: number }) => void
  setTypingTestViewOnlyAlwaysOnTop: (enabled: boolean) => void
  setTypingTestMemory: (memory: TypingTestMemory | undefined) => void
  setTypingTestDisplayLines: (lines: number) => void
  setTypingTestFontSize: (px: number) => void
  setTypingTestHideKeymap: (hidden: boolean) => void
  setTypingTestHideStatsRow: (hidden: boolean) => void
  setTypingTestHideControls: (hidden: boolean) => void
  setTypingTestSaveUnnamed: (enabled: boolean) => void
  setTypingTestComparisonBaseline: (conditionKey: string, baseline: TypingTestComparisonBaseline) => void
  setTypingTestSettingsPanelOpen: (open: boolean) => void
  setTypingRecordEnabled: (enabled: boolean) => void
  setTypingViewMenuTab: (tab: TypingViewMenuTab) => void
  setViewMode: (mode: ViewMode) => void
  setKeyEditorZoom: (zoom: number) => void
  setViewMatrix: (next: Record<string, ViewMatrixCell> | undefined) => void
  defaultLayout: KeyboardLayoutId
  defaultAutoAdvance: boolean
  defaultLayerPanelOpen: boolean
  defaultBasicViewType: BasicViewType
  defaultSplitKeyMode: SplitKeyMode
  defaultQuickSelect: boolean
  setDefaultLayout: (id: KeyboardLayoutId) => void
  setDefaultAutoAdvance: (enabled: boolean) => void
  setDefaultLayerPanelOpen: (open: boolean) => void
  setDefaultBasicViewType: (type: BasicViewType) => void
  setDefaultSplitKeyMode: (mode: SplitKeyMode) => void
  setDefaultQuickSelect: (enabled: boolean) => void
  autoLockTime: AutoLockMinutes
  setAutoLockTime: (m: AutoLockMinutes) => void
  applyDevicePrefs: (uid: string) => Promise<void>
  /** Display label for a qmkId: the active Key Label pack's own label
   *  (via `compositeLabels` -> `map`), falling back to the qmkId itself
   *  when neither has an entry. This is what feeds the keymap surface
   *  regardless of which of `KeymapEditor`'s tabs is showing (Plan-qwerty-
   *  select-no-rewrite v7 — シミュレーションタブ方式): the simulation tab
   *  renders it as-is, while the Base tab bypasses it entirely (its own
   *  raw/identity keycode builder — see `KeymapEditor`'s `baseLayerKeycodes`
   *  — never calls this at all). A Rewrite never leaves anything for this
   *  to simulate either way, since it resets `layout` back to QWERTY
   *  (raw/no-color) on success, which also makes the tabs disappear. */
  remapLabel: (qmkId: string) => string
  /** The blue "remapped" tint source: true whenever `remapLabel(qmkId)`
   *  differs from `qmkId` itself — same rule every picker/palette consumer
   *  applies. */
  isRemapped: (qmkId: string) => boolean
  /** Which remap tint `isRemapped`-tinted keys use on the keymap surface
   *  (keymap pane + typing-test pane; the picker is untouched — see
   *  `pickerRemapLabel` below). `'simulated'` iff an active (non-empty)
   *  pack map is loaded and it's a pure permutation (same `.ok` verdict
   *  `rewriteTableResult` already computes for the Rewrite gate) — the
   *  "labels show what a Rewrite WOULD produce, pressing still types the
   *  old character" case. `'actual'` otherwise: JIS-type display remaps
   *  (truthful — the OS/IME really produces the shown char), QWERTY/no
   *  pack (irrelevant since no key is ever tinted there), and
   *  non-permutation deviation packs. */
  remapKind: RemapKind
  /** The active pack's own rewrite table, already resolved and validated —
   *  `undefined` unless `remapKind === 'simulated'`. Lets
   *  `useKeymapApplyPrompt.requestApply` skip a second async lookup for
   *  the exact table `remapKind` itself already required to build. See
   *  the hook body's own doc comment for the full rationale. */
  activeRewriteTable?: KeymapRewriteTable
  /** Display name of the active layout/pack — see `remapKind`'s sibling
   *  doc comment on `activeLayoutName` in the hook body for what feeds it. */
  activeLayoutName: string
  /** Display label for a qmkId, but ONLY for the key PICKER surface
   *  (`TabbedKeycodes` / `KeyPopover` → `PopoverTabKey`) — the keymap
   *  legend itself (`useLayerKeycodes`, `KeyWidget`'s masked-inner label)
   *  keeps using `remapLabel` above unconditionally.
   *
   *  Plan-qwerty-select-no-rewrite v6: the picker should only ever change
   *  for a pack that deviates from ANSI (a symbol/label the picker can't
   *  already show as-is — JIS shift pairs, kana, ...). A pure QWERTY-
   *  keycode permutation pack (Colemak, Eucalyn, Dvorak, ...) swaps WHICH key
   *  sends a character, but every character it swaps in already exists
   *  somewhere in the picker — remapping the picker's own legends for
   *  that case would just be noise (and would desync the picker's
   *  legend from the keycode it actually inserts). So this identity-
   *  passes for a permutation pack and only forwards to `remapLabel` once
   *  the active pack fails the same `buildKeymapRewriteTable` check the
   *  Key Label "apply to keymap" rewrite itself uses to decide
   *  applicability — a deviation pack behaves exactly like `remapLabel`.
   *  QWERTY/no pack has an empty map, which trivially passes the check
   *  (nothing to permute), so it already resolves to identity without a
   *  separate guard. */
  pickerRemapLabel: (qmkId: string) => string
}
