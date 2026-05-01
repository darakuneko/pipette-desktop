// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Keycode } from '../../shared/keycodes/keycodes'
import { deserialize } from '../../shared/keycodes/keycodes'
import type { MacroAction } from '../../preload/macro'
import type { TapDanceEntry } from '../../shared/types/protocol'
import type { FavoriteType } from '../../shared/types/favorite-store'
import type { BasicViewType, SplitKeyMode } from '../../shared/types/app-config'
import { useUnlockGate } from './useUnlockGate'
import { useConfirmAction } from './useConfirmAction'
import { useMaskedKeycodeSelection } from './useMaskedKeycodeSelection'
import { useFavoriteStore } from './useFavoriteStore'
import type { UseFavoriteStoreReturn } from './useFavoriteStore'
import { useTileContentOverride } from './useTileContentOverride'

// ---------------------------------------------------------------------------
// Adapter — each modal provides one of these to describe its differences
// ---------------------------------------------------------------------------

export interface KeycodeFieldDescriptor<TEntry> {
  key: string & keyof TEntry
  labelKey: string
  labelOpts?: Record<string, unknown>
}

export interface KeycodeEntryModalAdapter<TEntry extends Record<string, unknown>> {
  /** data-testid prefix, e.g. "combo", "ko", "ar", "td" */
  testIdPrefix: string
  /** data-testid for the body container, e.g. "editor-combo". Defaults to `editor-${testIdPrefix}` */
  bodyTestId?: string
  /** Favorite type for storage */
  favoriteType: FavoriteType
  /** i18n key for modal title */
  titleKey: string
  /** Params for title interpolation */
  titleParams: (index: number) => Record<string, unknown>

  /** Fields that hold keycode values (shown as KeycodeField + picker) */
  keycodeFields: KeycodeFieldDescriptor<TEntry>[]

  /** Factory for a blank/cleared entry */
  createEmptyEntry: () => TEntry
  /** Whether the entry has meaningful data (for fav save gate) */
  isConfigured: (entry: TEntry) => boolean
  /** Keycode values to check for QK_BOOT unlock. Empty = no guard */
  guardCodes: (entry: TEntry) => number[]
  /** Post-update normalizer, e.g. KO/AR auto-disable when unconfigured */
  normalizeEntry?: (entry: TEntry) => TEntry

  /** Whether to close the modal after save. true for Combo/KO/AR, false for TD */
  closeOnSave: boolean
  /** Whether to show favorites panel. Default: () => true */
  showFavorites?: (opts: { isDummy?: boolean }) => boolean
  /** Modal width class. Default: 'w-[1050px]' */
  modalWidth?: string | ((opts: { isDummy?: boolean }) => string)
}

// ---------------------------------------------------------------------------
// Options — passed by the modal component that uses the hook
// ---------------------------------------------------------------------------

export interface KeycodeEntryModalOptions<TEntry extends Record<string, unknown>> {
  entry: TEntry | undefined
  index: number
  onSave: (index: number, entry: TEntry) => Promise<void>
  onClose: () => void
  unlocked?: boolean
  onUnlock?: () => void
  quickSelect?: boolean
  isDummy?: boolean
  /** Vial protocol of the live keyboard. Forwarded to favorite export (v3) so importers can resolve protocol-specific keycode values. */
  vialProtocol: number
  // TabbedKeycodes tile content
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
  splitKeyMode?: SplitKeyMode
  basicViewType?: BasicViewType
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface KeycodeEntryModalReturn<TEntry extends Record<string, unknown>> {
  // State
  editedEntry: TEntry | null
  setEditedEntry: React.Dispatch<React.SetStateAction<TEntry | null>>
  selectedField: string | null
  popoverState: { field: string; anchorRect: DOMRect } | null
  hasChanges: boolean

  // Actions
  handleClose: () => void
  handleEntrySave: () => Promise<void>
  updateField: (field: string & keyof TEntry, code: number) => void
  handleFieldSelect: (field: string & keyof TEntry) => void
  handleFieldMaskPartClick: (field: string & keyof TEntry, part: 'outer' | 'inner') => void
  handleFieldDoubleClick: (field: string & keyof TEntry, rect: DOMRect) => void
  handlePickerClose: () => void
  closePopover: () => void
  confirmPopover: () => void
  handlePopoverKeycodeSelect: (kc: Keycode) => void
  handlePopoverRawKeycodeSelect: (code: number) => void

  // Confirm actions
  clearAction: { confirming: boolean; trigger: () => void; reset: () => void }
  revertAction: { confirming: boolean; trigger: () => void; reset: () => void }

  // Masked selection (forwarded for TabbedKeycodes)
  maskedSelection: ReturnType<typeof useMaskedKeycodeSelection>
  tabContentOverride: Record<string, React.ReactNode> | undefined

  // Favorites
  favStore: UseFavoriteStoreReturn

  // Derived
  preEditValueRef: React.MutableRefObject<number>
  showFavorites: boolean
  modalWidth: string
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useKeycodeEntryModal<TEntry extends Record<string, unknown>>(
  adapter: KeycodeEntryModalAdapter<TEntry>,
  options: KeycodeEntryModalOptions<TEntry>,
): KeycodeEntryModalReturn<TEntry> {
  const {
    entry, index, onSave, onClose,
    unlocked, onUnlock, quickSelect, isDummy,
    vialProtocol,
    tapDanceEntries, deserializedMacros,
  } = options

  const { guard, clearPending } = useUnlockGate({ unlocked, onUnlock })

  const [editedEntry, setEditedEntry] = useState<TEntry | null>(entry ?? null)
  const [selectedField, setSelectedField] = useState<string | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: string; anchorRect: DOMRect } | null>(null)
  const preEditValueRef = useRef<number>(0)

  // Favorites
  const showFavorites = adapter.showFavorites
    ? adapter.showFavorites({ isDummy })
    : true

  const favStore = useFavoriteStore({
    favoriteType: adapter.favoriteType,
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as TEntry),
    enabled: showFavorites,
    vialProtocol,
  })

  // Clear action
  const clearAction = useConfirmAction(useCallback(() => {
    setEditedEntry(adapter.createEmptyEntry() as TEntry)
    setSelectedField(null)
    setPopoverState(null)
  }, [adapter]))

  // Revert action
  const revertAction = useConfirmAction(useCallback(() => {
    clearPending()
    setEditedEntry(entry ?? null)
    setSelectedField(null)
    setPopoverState(null)
  }, [entry, clearPending]))

  // Sync when entry/index changes
  useEffect(() => {
    setEditedEntry(entry ?? null)
    setSelectedField(null)
    setPopoverState(null)
    clearAction.reset()
    revertAction.reset()
  }, [entry, index])

  // Refresh favorites on mount
  useEffect(() => {
    if (showFavorites) {
      favStore.refreshEntries()
    }
  }, [showFavorites, favStore.refreshEntries])

  // Close handler
  const handleClose = useCallback(() => {
    clearPending()
    onClose()
  }, [clearPending, onClose])

  // Update a single keycode field, with optional normalization
  const updateField = useCallback((field: string & keyof TEntry, code: number) => {
    setEditedEntry((prev) => {
      if (!prev) return prev
      let next = { ...prev, [field]: code }
      if (adapter.normalizeEntry) {
        next = adapter.normalizeEntry(next)
      }
      return next
    })
  }, [adapter])

  // Save handler
  const handleEntrySave = useCallback(async () => {
    if (!editedEntry) return
    const codes = adapter.guardCodes(editedEntry)
    if (codes.length > 0) {
      await guard(codes, async () => {
        await onSave(index, editedEntry)
        if (adapter.closeOnSave) handleClose()
      })
    } else {
      await onSave(index, editedEntry)
      if (adapter.closeOnSave) handleClose()
    }
  }, [index, editedEntry, onSave, guard, handleClose, adapter])

  // Masked keycode selection
  const maskedSelection = useMaskedKeycodeSelection({
    onUpdate(code: number) {
      if (!selectedField) return false
      setEditedEntry((prev) => {
        if (!prev) return prev
        let next = { ...prev, [selectedField]: code }
        if (adapter.normalizeEntry) {
          next = adapter.normalizeEntry(next)
        }
        return next
      })
    },
    onCommit() {
      setPopoverState(null)
      setSelectedField(null)
    },
    resetKey: selectedField,
    initialValue: selectedField && editedEntry ? editedEntry[selectedField] as number : undefined,
    quickSelect,
  })

  // pickerSelect/pickerDoubleClick honour quickSelect:
  // quickSelect=false → single-click selects, double-click / Enter commits;
  // quickSelect=true  → single-click already commits, double-click handler is undefined.
  const tabContentOverride = useTileContentOverride({
    tapDanceEntries,
    deserializedMacros,
    onSelect: maskedSelection.pickerSelect,
    onDoubleClick: maskedSelection.pickerDoubleClick,
  })

  // Field interactions
  const handleFieldSelect = useCallback((field: string & keyof TEntry) => {
    if (!selectedField && editedEntry) {
      preEditValueRef.current = editedEntry[field] as number
      setSelectedField(field)
    }
  }, [selectedField, editedEntry])

  const handleFieldMaskPartClick = useCallback((field: string & keyof TEntry, part: 'outer' | 'inner') => {
    if (selectedField === field) {
      maskedSelection.setEditingPart(part)
    } else if (!selectedField && editedEntry) {
      preEditValueRef.current = editedEntry[field] as number
      maskedSelection.enterMaskMode(editedEntry[field] as number, part)
      setSelectedField(field)
    }
  }, [selectedField, editedEntry, maskedSelection])

  const handleFieldDoubleClick = useCallback(
    (field: string & keyof TEntry, rect: DOMRect) => {
      if (!selectedField) return
      setPopoverState({ field, anchorRect: rect })
    },
    [selectedField],
  )

  // Picker close → restore pre-edit value
  const handlePickerClose = useCallback(() => {
    if (selectedField) {
      setEditedEntry((prev) => prev ? { ...prev, [selectedField]: preEditValueRef.current } : prev)
    }
    maskedSelection.clearMask()
    setSelectedField(null)
  }, [selectedField, maskedSelection])

  // Popover
  const closePopover = useCallback(() => {
    setPopoverState(null)
  }, [])

  const confirmPopover = useCallback(() => {
    setPopoverState(null)
    setSelectedField(null)
  }, [])

  const popoverField = popoverState?.field ?? null

  const handlePopoverKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!popoverField) return
      updateField(popoverField as string & keyof TEntry, deserialize(kc.qmkId))
    },
    [popoverField, updateField],
  )

  const handlePopoverRawKeycodeSelect = useCallback(
    (code: number) => {
      if (!popoverField) return
      updateField(popoverField as string & keyof TEntry, code)
    },
    [popoverField, updateField],
  )

  // Derived
  const hasChanges = editedEntry !== null && entry != null && JSON.stringify(entry) !== JSON.stringify(editedEntry)

  const modalWidth = typeof adapter.modalWidth === 'function'
    ? adapter.modalWidth({ isDummy })
    : adapter.modalWidth ?? 'w-[1050px]'

  return {
    editedEntry,
    setEditedEntry,
    selectedField,
    popoverState,
    hasChanges,
    handleClose,
    handleEntrySave,
    updateField,
    handleFieldSelect,
    handleFieldMaskPartClick,
    handleFieldDoubleClick,
    handlePickerClose,
    closePopover,
    confirmPopover,
    handlePopoverKeycodeSelect,
    handlePopoverRawKeycodeSelect,
    clearAction,
    revertAction,
    maskedSelection,
    tabContentOverride,
    favStore,
    preEditValueRef,
    showFavorites,
    modalWidth,
  }
}

// ---------------------------------------------------------------------------
// Helper for entries with enabled/options fields (KO, AR)
// ---------------------------------------------------------------------------

interface EnabledEntryFields {
  enabled: boolean
  options: number
}

export interface EnabledEntryCallbacks<TEntry extends EnabledEntryFields> {
  handleToggleEnabled: () => void
  handleToggleOption: (flag: number) => void
  updateEntry: (field: keyof TEntry, value: number) => void
  canEnable: boolean
}

export function useEnabledEntryCallbacks<TEntry extends EnabledEntryFields>(
  hook: KeycodeEntryModalReturn<TEntry>,
  isConfigured: (entry: TEntry) => boolean,
): EnabledEntryCallbacks<TEntry> {
  const { editedEntry, setEditedEntry } = hook

  const handleToggleEnabled = useCallback(() => {
    setEditedEntry((prev) => prev ? { ...prev, enabled: !prev.enabled } : prev)
  }, [setEditedEntry])

  const handleToggleOption = useCallback((flag: number) => {
    setEditedEntry((prev) => prev ? { ...prev, options: prev.options ^ flag } : prev)
  }, [setEditedEntry])

  const updateEntry = useCallback((field: keyof TEntry, value: number) => {
    setEditedEntry((prev) => {
      if (!prev) return prev
      const next = { ...prev, [field]: value }
      if (!isConfigured(next)) (next as EnabledEntryFields).enabled = false
      return next
    })
  }, [setEditedEntry, isConfigured])

  const canEnable = editedEntry !== null && isConfigured(editedEntry)

  return { handleToggleEnabled, handleToggleOption, updateEntry, canEnable }
}
