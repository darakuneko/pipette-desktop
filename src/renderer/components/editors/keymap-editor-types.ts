// SPDX-License-Identifier: GPL-2.0-or-later

import type { KeyboardLayout } from '../../../shared/kle/types'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { BulkKeyEntry } from '../../hooks/useKeyboard'
import type { MacroAction } from '../../../preload/macro'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry, DeviceInfo } from '../../../shared/types/protocol'
import type { KeyboardLayoutId } from '../../hooks/useKeyboardLayout'
import type { TypingTestResult, TypingViewMenuTab } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../../typing-test/types'
import type { FavHubEntryResult } from './FavoriteHubActions'

export const MIN_SCALE = 0.3
export const MAX_SCALE = 2.0

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

export interface KeymapEditorHandle {
  toggleMatrix: () => void
  toggleTypingTest: () => void
  matrixMode: boolean
  hasMatrixTester: boolean
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
  basicViewType?: BasicViewType
  onBasicViewTypeChange?: (type: BasicViewType) => void
  splitKeyMode?: SplitKeyMode
  onSplitKeyModeChange?: (mode: SplitKeyMode) => void
  quickSelect?: boolean
  onQuickSelectChange?: (enabled: boolean) => void
  keyboardLayout?: KeyboardLayoutId
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId) => void
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
  typingTestMode?: boolean
  onTypingTestModeChange?: (enabled: boolean) => void
  onSaveTypingTestResult?: (result: TypingTestResult) => void
  typingTestHistory?: TypingTestResult[]
  typingTestConfig?: TypingTestConfig
  typingTestLanguage?: string
  onTypingTestConfigChange?: (config: TypingTestConfig) => void
  onTypingTestLanguageChange?: (lang: string) => void
  typingTestViewOnly?: boolean
  onTypingTestViewOnlyChange?: (enabled: boolean) => void
  typingTestViewOnlyWindowSize?: { width: number; height: number }
  onTypingTestViewOnlyWindowSizeChange?: (size: { width: number; height: number }) => void
  typingTestViewOnlyAlwaysOnTop?: boolean
  onTypingTestViewOnlyAlwaysOnTopChange?: (enabled: boolean) => void
  typingRecordEnabled?: boolean
  onTypingRecordEnabledChange?: (enabled: boolean) => void
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
  typingViewMenuTab?: TypingViewMenuTab
  onTypingViewMenuTabChange?: (tab: TypingViewMenuTab) => void
  /** Called when the typing-view REC tab triggers "View Analytics".
   * KeymapEditor forwards to the App shell so the shell can exit the
   * compact window and swap to the analytics page. The record toggle
   * is preserved across the navigation — leaving the compact window
   * stops the sink via typingTestViewOnly without touching the
   * persisted preference. */
  onViewAnalytics?: () => void
  /** TAPPING_TERM (ms) from the keyboard's QMK settings. Forwarded to
   * useTypingTest so masked-key tap/hold classification uses the same
   * timeout QMK itself enforces. */
  tappingTermMs?: number
  deviceName?: string
  isDummy?: boolean
  onExportLayoutPdfAll?: () => void
  onExportLayoutPdfCurrent?: () => void
  /** Hub display name for the signed-in user. Forwarded to the
   *  KeyLabelsModal that opens from the keypicker overlay's Edit
   *  button (mirrors the SettingsModal entry point). */
  hubDisplayName?: string | null
  /** True when the signed-in user can write to Hub (Upload / Update /
   *  Remove). Used to gate the Edit-modal Hub buttons. */
  hubCanWrite?: boolean
  // Hub favorite props (forwarded to TapDanceModal / MacroModal)
  favHubOrigin?: string
  favHubNeedsDisplayName?: boolean
  favHubUploading?: string | null
  favHubUploadResult?: FavHubEntryResult | null
  onFavUploadToHub?: (type: string, entryId: string) => void
  onFavUpdateOnHub?: (type: string, entryId: string) => void
  onFavRemoveFromHub?: (type: string, entryId: string) => void
  onFavRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void
  /** List of currently detected HID devices (for device probe picker) */
  devices?: DeviceInfo[]
  /** Currently connected (primary) device info */
  connectedDevice?: DeviceInfo | null
  /** Notify parent when device list browsing state changes (for polling control) */
  onDeviceListActiveChange?: (active: boolean) => void
}
