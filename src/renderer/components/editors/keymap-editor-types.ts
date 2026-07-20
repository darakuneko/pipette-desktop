// SPDX-License-Identifier: GPL-2.0-or-later

import type { KeyboardLayout, KleKey } from '../../../shared/kle/types'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { BulkKeyEntry } from '../../hooks/useKeyboard'
import type { MacroAction } from '../../../preload/macro'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry, DeviceInfo } from '../../../shared/types/protocol'
import type { FavoriteType } from '../../../shared/types/favorite-store'
import type { KeyboardLayoutId } from '../../hooks/useKeyboardLayout'
import type { TypingTestResult, TypingViewMenuTab, TypingTestMemory, TypingTestComparisonBaseline, TypingTestComparisonBaselines, ViewMatrixCell } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../../typing-test/types'
import type { FavHubEntryResult } from './FavoriteHubActions'
import type { KeymapRewriteTable } from '../../../shared/keymap/keymap-apply'
import type { RemapKind } from '../keyboard/constants'

export const MIN_SCALE = 0.3
export const MAX_SCALE = 2.0

/** Where a "View Analytics" action was triggered, so the analytics page's
 * Back can return the user to the same place. */
export type AnalyticsOrigin = 'typingView' | 'typingTest' | 'editor'

/** Collapsed width of the layer list panel / toolbar column (3.125rem). */
export const PANEL_COLLAPSED_WIDTH = '3.125rem'

/** Maps KeyboardEvent.code to a resolved key when e.key is 'Process' (IME active). */
export const PROCESS_CODE_TO_KEY = new Map<string, string>([
  ['Space', ' '],
  ['Enter', 'Enter'],
  ['NumpadEnter', 'Enter'],
  ['Backspace', 'Backspace'],
])

export const EMPTY_KEYCODES = new Map<string, string>()
export const EMPTY_REMAPPED = new Set<string>()
export const EMPTY_ENCODER_KEYCODES = new Map<string, [string, string]>()

export type PopoverState =
  | { anchorRect: DOMRect; kind: 'key'; row: number; col: number; maskClicked: boolean }
  | { anchorRect: DOMRect; kind: 'encoder'; idx: number; dir: 0 | 1; maskClicked: boolean }

/** Result of `KeymapEditorHandle.applyKeymapRewrite`. */
export interface KeymapApplyResult {
  /** Number of keymap/encoder positions actually rewritten before any failure. */
  appliedCount: number
  /** Set when a write failed partway through. Positions already written
   *  (and already folded into the one undo-able batch entry) are not
   *  rolled back — Undo reverts them like any other edit. */
  error?: string
}

export interface KeymapEditorHandle {
  toggleMatrix: () => void
  toggleTypingTest: () => void
  matrixMode: boolean
  hasMatrixTester: boolean
  /** Bulk-rewrite every keymap/encoder position via `table` (Plan-key-
   *  label-keymap-apply Phase 3). Destructive one-shot (Plan-qwerty-
   *  select-no-rewrite v5 最終仕様): the moment any write actually lands,
   *  the undo/redo stacks are wiped instead of gaining a revertible batch
   *  entry — recovery is the user's own .vil/snapshot backup, not Undo. */
  applyKeymapRewrite: (table: KeymapRewriteTable) => Promise<KeymapApplyResult>
  /** Wipes the undo/redo stack in place, without touching the keymap itself.
   *  Called by the host (App.tsx) after a snapshot/layout-store restore or
   *  `.vil` import replaces the whole keymap out from under this same
   *  mounted editor instance (Plan-qwerty-select-no-rewrite §snapshot/.vil
   *  復元時のクリーンアップ) — those flows keep the same uid and never empty
   *  the keymap, so KeymapEditor's own uid/keymap-size clear effect never
   *  fires on its own. */
  clearHistory: () => void
}

export interface KeymapEditorProps {
  keyboardUid?: string
  layout: KeyboardLayout | null
  layers: number
  currentLayer: number
  onLayerChange?: (layer: number) => void
  keymap: Map<string, number> // "layer,row,col" -> keycode
  encoderLayout: Map<string, number> // "layer,idx,dir" -> keycode
  encoderCount: number
  layoutOptions: Map<number, number>
  layoutLabels?: (string | string[])[]
  packedLayoutOptions?: number
  onSetLayoutOptions?: (options: number) => Promise<void>
  remapLabel?: (qmkId: string) => string
  isRemapped?: (qmkId: string) => boolean
  /** Which remap tint `isRemapped`-tinted keys use on the keymap surface
   *  (keymap pane + typing-test pane) — see `RemapKind` in
   *  `components/keyboard/constants.ts` and `useDevicePrefs.ts`'s
   *  `remapKind` for the gating logic. Applied as a pure CSS override
   *  (the `remap-simulated` class in `style.css`) on the single container
   *  that wraps the active keymap surface — it does NOT thread further
   *  into KeyboardPane/TypingTestPane/KeyboardWidget/KeyWidget/
   *  EncoderWidget, which only ever know `--key-label-remap` via
   *  `KEY_REMAP_COLOR`. Defaults to `'actual'`. */
  remapKind?: RemapKind
  /** Picker-only variant of `remapLabel` (Plan-qwerty-select-no-rewrite
   *  v6, Phase P) — identity for a pure QWERTY-permutation pack, same as
   *  `remapLabel` otherwise. Threaded ONLY to the picker surface
   *  (`TabbedKeycodes`, the key popover); the keymap legend itself keeps
   *  using `remapLabel` unconditionally. See `useDevicePrefs.ts` for the
   *  full rationale. */
  pickerRemapLabel?: (qmkId: string) => string
  onSetKey: (layer: number, row: number, col: number, keycode: number) => Promise<void>
  onSetKeysBulk: (entries: BulkKeyEntry[]) => Promise<void>
  onSetEncoder: (layer: number, idx: number, dir: number, keycode: number) => Promise<void>
  rows?: number
  cols?: number
  getMatrixState?: () => Promise<number[]>
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  tapDanceEntries?: TapDanceEntry[]
  onSetTapDanceEntry?: (index: number, entry: TapDanceEntry) => Promise<void>
  macroCount?: number
  macroBufferSize?: number
  macroBuffer?: number[]
  vialProtocol?: number
  parsedMacros?: MacroAction[][] | null
  onSaveMacros?: (buffer: number[], parsedMacros?: MacroAction[][]) => Promise<void>
  tapHoldSupported?: boolean
  mouseKeysSupported?: boolean
  magicSupported?: boolean
  graveEscapeSupported?: boolean
  autoShiftSupported?: boolean
  oneShotKeysSupported?: boolean
  comboSettingsSupported?: boolean
  supportedQsids?: Set<number>
  qmkSettingsGet?: (qsid: number) => Promise<number[]>
  qmkSettingsSet?: (qsid: number, data: number[]) => Promise<void>
  qmkSettingsReset?: () => Promise<void>
  onSettingsUpdate?: (qsid: number, data: number[]) => void
  autoAdvance?: boolean
  onAutoAdvanceChange?: (enabled: boolean) => void
  /** Auto Move order override, keyed by physical `"row,col"` — see
   *  `PipetteSettings.viewMatrix`. Also drives View Matrix mode's
   *  effective-position display and edit modal. */
  viewMatrix?: Record<string, ViewMatrixCell>
  onViewMatrixChange?: (next: Record<string, ViewMatrixCell> | undefined) => void
  basicViewType?: BasicViewType
  onBasicViewTypeChange?: (type: BasicViewType) => void
  splitKeyMode?: SplitKeyMode
  onSplitKeyModeChange?: (mode: SplitKeyMode) => void
  quickSelect?: boolean
  onQuickSelectChange?: (enabled: boolean) => void
  keyboardLayout?: KeyboardLayoutId
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId) => void
  /** Display name of the active Key Label pack — labels the simulation
   *  tab's top button. Only read while `remapKind === 'simulated'`
   *  (Plan-qwerty-select-no-rewrite v7). */
  keymapPackName?: string
  /** Opens the Rewrite confirm modal for the pack currently active in
   *  `keyboardLayout` — wired to `useKeymapApplyPrompt().requestApply`.
   *  Called by the simulation tab's Apply button (layer-indicator row). */
  onRequestKeymapApply?: () => void
  /** Non-null while the Rewrite confirm modal should be open — mirrors
   *  `useKeymapApplyPrompt().pendingApply !== null`. */
  keymapApplyOpen?: boolean
  /** Display name shown in the confirm modal's title — mirrors
   *  `useKeymapApplyPrompt().pendingApply?.name`. */
  keymapApplyLabelName?: string
  /** True while the confirm apply is in flight — mirrors
   *  `useKeymapApplyPrompt().isApplying`. Disables the modal's buttons. */
  keymapApplyBusy?: boolean
  onKeymapApplyConfirm?: () => void
  onKeymapApplyCancel?: () => void
  /** Set after a partial-failure apply — mirrors
   *  `useKeymapApplyPrompt().applyError`. Shown near the Apply button. */
  keymapApplyError?: string | null
  onLock?: () => void
  onMatrixModeChange?: (matrixMode: boolean, hasMatrixTester: boolean) => void
  onOpenLighting?: () => void
  comboEntries?: ComboEntry[]
  onOpenCombo?: (index: number) => void
  onSetComboEntry?: (index: number, entry: ComboEntry) => Promise<void>
  keyOverrideEntries?: KeyOverrideEntry[]
  onOpenKeyOverride?: (index: number) => void
  onSetKeyOverrideEntry?: (index: number, entry: KeyOverrideEntry) => Promise<void>
  altRepeatKeyEntries?: AltRepeatKeyEntry[]
  onOpenAltRepeatKey?: (index: number) => void
  onSetAltRepeatKeyEntry?: (index: number, entry: AltRepeatKeyEntry) => Promise<void>
  toolsExtra?: React.ReactNode
  dataPanel?: React.ReactNode
  onOverlayOpen?: () => void
  layerNames?: string[]
  onSetLayerName?: (layer: number, name: string) => void
  layerPanelOpen?: boolean
  onLayerPanelOpenChange?: (open: boolean) => void
  scale?: number
  onScaleChange?: (delta: number) => void
  keyEditorZoom?: number
  onKeyEditorZoomChange?: (zoom: number) => void
  typingTestMode?: boolean
  onTypingTestModeChange?: (enabled: boolean) => void
  onSaveTypingTestResult?: (result: TypingTestResult) => void
  onRenameTypingTestResult?: (date: string, name: string) => void
  onDeleteTypingTestResult?: (date: string) => void
  typingTestHistory?: TypingTestResult[]
  typingTestConfig?: TypingTestConfig
  typingTestMonkeytypeConfig?: TypingTestConfig
  typingTestLanguage?: string
  onTypingTestConfigChange?: (config: TypingTestConfig) => void
  onTypingTestLanguageChange?: (lang: string) => void
  typingTestViewOnly?: boolean
  onTypingTestViewOnlyChange?: (enabled: boolean) => void
  typingTestViewOnlyWindowSize?: { width: number; height: number }
  onTypingTestViewOnlyWindowSizeChange?: (size: { width: number; height: number }) => void
  typingTestViewOnlyAlwaysOnTop?: boolean
  onTypingTestViewOnlyAlwaysOnTopChange?: (enabled: boolean) => void
  typingTestMemory?: TypingTestMemory
  onTypingTestMemoryChange?: (memory: TypingTestMemory | undefined) => void
  typingTestDisplayLines?: number
  typingTestFontSize?: number
  onTypingTestDisplayLinesChange?: (lines: number) => void
  onTypingTestFontSizeChange?: (px: number) => void
  typingTestHideKeymap?: boolean
  typingTestHideStatsRow?: boolean
  typingTestHideControls?: boolean
  typingTestSaveUnnamed?: boolean
  typingTestComparisonBaselines?: TypingTestComparisonBaselines
  onTypingTestHideKeymapChange?: (hidden: boolean) => void
  onTypingTestHideStatsRowChange?: (hidden: boolean) => void
  onTypingTestHideControlsChange?: (hidden: boolean) => void
  onTypingTestSaveUnnamedChange?: (enabled: boolean) => void
  onTypingTestComparisonBaselineChange?: (conditionKey: string, baseline: TypingTestComparisonBaseline) => void
  typingTestSettingsPanelOpen?: boolean
  onTypingTestSettingsPanelOpenChange?: (open: boolean) => void
  typingRecordEnabled?: boolean
  onTypingRecordEnabledChange?: (enabled: boolean) => void
  /** Called once per matrix keystroke recorded while REC is active, so
   *  the host (App) can drive the tray's session keystroke count. See
   *  UseInputModesOptions.onRecKeystroke for the exact gating. */
  onRecKeystroke?: () => void
  /** AppConfig flag — true once the user has accepted the recording
   * disclosure, so the REC tab Start button can skip the modal. */
  typingRecordingConsentAccepted?: boolean
  onTypingRecordingConsentAccepted?: () => void
  /** Window length in minutes for the typing-view heatmap. Flows
   * through AppConfig so the choice survives app restarts. */
  typingHeatmapWindowMin?: number
  onTypingHeatmapWindowMinChange?: (minutes: number) => void
  /** AppConfig flag for the Monitor App tab. When true (and REC is
   * running) the analytics service tags each minute with the active
   * application name. Disabling stops new tags but does not erase
   * historical data. The toggle in the typing-view popover is greyed
   * out until REC starts so the user has a single, predictable point
   * where data collection begins. */
  typingMonitorAppEnabled?: boolean
  onTypingMonitorAppEnabledChange?: (enabled: boolean) => void
  /** AppConfig fields for the REC tab's tray toggles — same source and
   * linked-clear semantics as Settings > Tools (SettingsToolsTab). */
  typingTrayResident?: boolean
  onTypingTrayResidentChange?: (enabled: boolean) => void
  typingStartInTray?: boolean
  onTypingStartInTrayChange?: (enabled: boolean) => void
  typingViewMenuTab?: TypingViewMenuTab
  onTypingViewMenuTabChange?: (tab: TypingViewMenuTab) => void
  /** Called when "View Analytics" is triggered, from either the compact
   * Typing View REC tab (`'typingView'`) or the full-screen Typing Test
   * header (`'typingTest'`). KeymapEditor forwards to the App shell, which
   * swaps to the analytics page and remembers the origin so Back returns
   * there. The record toggle is preserved across the navigation — leaving
   * the compact window stops the sink via typingTestViewOnly without
   * touching the persisted preference. */
  onViewAnalytics?: (origin: AnalyticsOrigin) => void
  /** Reports whether an editor typing test is mid-run, so the host (App)
   * can disable the StatusBar's "View Analytics" button mid-run. */
  onTypingTestRunningChange?: (running: boolean) => void
  /** TAPPING_TERM (ms) from the keyboard's QMK settings. Forwarded to
   * useTypingTest so masked-key tap/hold classification uses the same
   * timeout QMK itself enforces. */
  tappingTermMs?: number
  deviceName?: string
  isDummy?: boolean
  onExportLayoutPdfAll?: () => void
  onExportLayoutPdfCurrent?: () => void
  // Hub favorite props (forwarded to TapDanceModal / MacroModal)
  favHubOrigin?: string
  favHubNeedsDisplayName?: boolean
  favHubUploading?: string | null
  favHubUploadResult?: FavHubEntryResult | null
  onFavUploadToHub?: (type: FavoriteType, entryId: string) => void
  onFavUpdateOnHub?: (type: FavoriteType, entryId: string) => void
  onFavRemoveFromHub?: (type: FavoriteType, entryId: string) => void
  onFavRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void
  /** List of currently detected HID devices (for device probe picker) */
  devices?: DeviceInfo[]
  /** Currently connected (primary) device info */
  connectedDevice?: DeviceInfo | null
  /** Notify parent when device list browsing state changes (for polling control) */
  onDeviceListActiveChange?: (active: boolean) => void
}

// Layout picker (the picker "Keyboard" tab) data shapes — hoisted here so
// LayoutPickerContent and useLayoutPicker share them without a type-only
// import cycle between the two sibling modules.
export interface PickerFileDataShape {
  layout: KeyboardLayout
  keymap: Map<string, number>
  layers: number
  encoderKeycodes: Map<string, [string, string]>
  layoutOptions: Map<number, number>
  name: string
  layerNames?: string[]
  uid?: string
}
export type PickerFileData = PickerFileDataShape | null

export interface PickerData {
  keys: KleKey[]
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  remapped: Set<string>
  layoutOpts: Map<number, number>
  totalLayers: number
  names?: string[]
}
