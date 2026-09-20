// SPDX-License-Identifier: GPL-2.0-or-later

import type { MacroAction } from '../../../preload/macro'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import type { FavHubEntryResult } from './FavoriteHubActions'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'

export interface Props {
  macroCount: number
  macroBufferSize: number
  macroBuffer: number[]
  vialProtocol: number
  onSaveMacros: (buffer: number[], parsedMacros?: MacroAction[][]) => Promise<void>
  parsedMacros?: MacroAction[][] | null
  onClose?: () => void
  initialMacro?: number
  unlocked?: boolean
  onUnlock?: () => void
  isDummy?: boolean
  onEditingChange?: (editing: boolean) => void
  onRecordingChange?: (recording: boolean) => void
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
  // Hub integration (optional)
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: FavHubEntryResult | null
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void
  quickSelect?: boolean
  autoAdvance?: boolean
  splitKeyMode?: SplitKeyMode
  basicViewType?: BasicViewType
  layers?: number
}
